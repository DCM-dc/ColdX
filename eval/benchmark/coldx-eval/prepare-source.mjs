#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';

const { values } = parseArgs({ options: { source: { type: 'string' }, output: { type: 'string' } } });
if (!values.source || !values.output) throw new Error('--source and --output are required');
const source = await realpath(resolve(values.source));
const output = resolve(values.output);
const git = args => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', windowsHide: true });
const head = git(['rev-parse', 'HEAD']).trim();
const candidates = git(['ls-files', '-z']).split('\0').filter(Boolean);
const roots = new Set(['bin', 'lib', 'patches', 'plugin', 'scripts', 'desktop']);
const rootFiles = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'LICENSE', 'LICENSE.md']);
const paths = candidates.filter(path => roots.has(path.split('/')[0]) || rootFiles.has(path));
// Never copy user home, sessions, archive, ignored files or dependency trees.
for (const path of paths) {
  if (path.split('/').some(part => ['..', '.git', 'node_modules', 'codex-archive', '.coldx', '.dsh', '.env'].includes(part)) || /(^|\/)\.env\./.test(path)) {
    throw new Error(`Unexpected private or generated path in product snapshot: ${path}`);
  }
}
await mkdir(output); // Refuse an existing snapshot; no overwrite or cleanup.
const app = join(output, 'app');
await mkdir(app);
const files = [];
for (const path of paths.sort()) {
  const origin = join(source, path);
  if (!(await lstat(origin)).isFile()) throw new Error(`Only regular tracked files are supported: ${path}`);
  const rel = relative(source, await realpath(origin));
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Source escaped its checkout: ${path}`);
  const content = await readFile(origin);
  const destination = join(app, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content);
  files.push({ path, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
}
const identity = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'));
const manifest = {
  schema: 'coldx-product-source-snapshot-v1', capturedAt: new Date().toISOString(), gitHead: head,
  version: identity.version, dshVersion: identity.dependencies['@deepseek-ai/dsh'], packageManager: identity.packageManager,
  scope: 'Tracked runtime source at its current working contents, including existing policy changes; no git history, docs, evaluations, tests, user configuration or dependencies',
  buildStatus: 'Source only. Linux frozen-lockfile install and build have NOT run.',
  policySha256: files.find(file => file.path === 'plugin/policy.mjs')?.sha256,
  totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), files,
};
await writeFile(join(output, 'source-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ output, files: files.length, bytes: manifest.totalBytes, gitHead: head, policySha256: manifest.policySha256 }));
