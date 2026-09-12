import { join } from 'node:path';

export function parseArguments(args) {
  const result = { port: 3086, open: true, help: false, dump: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--no-open') result.open = false;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--dump-config') result.dump = true;
    else if (arg === '--home' || arg === '--cwd' || arg === '--port') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--port') {
        if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error('Port must be an integer from 0 to 65535.');
        result.port = Number(value);
      } else result[arg.slice(2)] = value;
    } else throw new Error(`Unknown option: ${arg}. Run with --help.`);
  }
  return result;
}

export function buildDshArguments({ dshRoot, port, open, dump }) {
  const args = [join(dshRoot, 'lib', 'bin.js'), '--profile', 'web'];
  if (dump) return [...args, '--dump-config'];
  return [...args, '--host', '127.0.0.1', '--port', String(port), ...(!open ? ['--no-open'] : [])];
}
