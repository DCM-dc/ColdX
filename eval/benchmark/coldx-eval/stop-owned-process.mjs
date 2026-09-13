#!/usr/bin/env node
// Linux-only cleanup for this evaluation's setsid process group.
import { readFile } from 'node:fs/promises';
import { groupMembers, requireOwnedGroup, terminateOwnedMembers } from './linux-process-group.mjs';
const [pidFile, expectedEntry] = process.argv.slice(2);
if (process.platform !== 'linux' || !pidFile || !expectedEntry) throw new Error('Linux PID record and exact launcher entry are required');
const raw = await readFile(pidFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
if (!raw) process.exit(0); // The launcher never reached its spawn boundary.
if (!/^\d+\s*$/.test(raw) || Number(raw) < 2) throw new Error('Invalid owned process record');
const pid = Number(raw);
// Zombies have no executable code or open handles and cannot change the task.
if ((await groupMembers(pid)).length === 0) process.exit(0);
let owner;
try { owner = await requireOwnedGroup(pid, expectedEntry); }
catch (error) {
  // The launcher can finish its own verified cleanup between our enumeration
  // and ownership read. Only absence of all live members resolves that race.
  if ((await groupMembers(pid)).length === 0) process.exit(0);
  throw error;
}
await terminateOwnedMembers(owner, { includeLeader: true });
