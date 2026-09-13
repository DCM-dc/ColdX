// Process cleanup for a launcher that owns a Linux setsid session. Never infer
// ownership from a recycled numeric PID after its leader has disappeared.
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

export async function readLinuxProcess(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { pid: Number(pid), state: fields[0], group: Number(fields[2]), session: Number(fields[3]), start: fields[19] };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  }
}

export async function groupMembers(group) {
  const entries = await readdir('/proc');
  const processes = await Promise.all(entries.filter(name => /^\d+$/.test(name)).map(readLinuxProcess));
  return processes.filter(row => row && row.group === group && row.state !== 'Z' && row.state !== 'X');
}

export async function requireOwnedGroup(pid, expectedEntry) {
  if (process.platform !== 'linux') throw new Error('Linux process groups are required');
  const leader = await readLinuxProcess(pid);
  if (!leader || leader.group !== pid || leader.session !== pid) throw new Error('Launcher must own a dedicated setsid process group');
  const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
  if (!argv.includes(expectedEntry)) throw new Error('Owned process entry no longer matches');
  return leader;
}

export async function terminateOwnedMembers(owner, { includeLeader = false, graceMs = 5000 } = {}) {
  const current = await readLinuxProcess(owner.pid);
  if (!current || current.start !== owner.start || current.group !== owner.group || current.session !== owner.session) {
    if ((await groupMembers(owner.group)).length === 0) return;
    throw new Error('Cannot establish ownership of the surviving process group');
  }
  const members = async () => {
    const found = (await groupMembers(owner.group)).filter(row => includeLeader || row.pid !== owner.pid);
    if (found.some(row => row.session !== owner.session)) throw new Error('Process group session ownership changed');
    return found;
  };
  const signal = async (rows, name) => {
    for (const row of rows) {
      const now = await readLinuxProcess(row.pid);
      // A process can exit between enumeration and signaling. Its replacement
      // must never receive a signal intended for the original process.
      if (!now || now.start !== row.start || now.group !== owner.group) continue;
      try { process.kill(row.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  await signal(await members(), 'SIGTERM');
  const gracefulDeadline = Date.now() + graceMs;
  while (Date.now() < gracefulDeadline && (await members()).length) await sleep(100);
  const forcedDeadline = Date.now() + 3000;
  while ((await members()).length && Date.now() < forcedDeadline) {
    await signal(await members(), 'SIGKILL');
    await sleep(100);
  }
  if ((await members()).length) throw new Error('Owned live processes did not stop; verification must not start');
}
