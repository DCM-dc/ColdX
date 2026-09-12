import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, writeFile, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
function inside(root, path) {
  const part = relative(root, path);
  if (!part || isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`)) throw new Error('Native patch path escapes its package.');
  return path;
}

/** Copy only patches named by pnpm, with a content digest and an exact package version. */
export async function stageNativePatches(projectRoot, runtimeRoot) {
  let yaml;
  try { yaml = await readFile(join(projectRoot, 'pnpm-workspace.yaml'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let entries = [];
  if (yaml !== undefined) {
    const dshRequire = createRequire(realpathSync(new URL('../../node_modules/@deepseek-ai/dsh/package.json', import.meta.url)));
    const { parse } = dshRequire('yaml');
    const configured = parse(yaml)?.patchedDependencies ?? {};
    if (!configured || typeof configured !== 'object' || Array.isArray(configured)) throw new Error('Invalid patchedDependencies map.');
    entries = Object.entries(configured);
  }
  const records = [];
  const root = await realpath(projectRoot);
  for (const [specifier, source] of entries) {
    const match = /^(@[^/]+\/[^@]+|[^@/]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(specifier);
    if (!match || typeof source !== 'string') throw new Error(`Native patches require an exact package version: ${specifier}`);
    const sourcePath = inside(root, await realpath(inside(root, resolve(root, source))));
    const patch = await readFile(sourcePath);
    const path = `desktop/native-patches/${String(records.length).padStart(3, '0')}.patch`;
    await mkdir(dirname(join(runtimeRoot, path)), { recursive: true });
    await writeFile(join(runtimeRoot, path), patch);
    records.push({ specifier, name: match[1], version: match[2], path, sha256: digest(patch) });
  }
  await writeFile(join(runtimeRoot, 'desktop/native-patches.json'), JSON.stringify({ version: 1, patches: records }, null, 2) + '\n');
  return records;
}

/** Strict text-only unified patch parser: no fuzzy matching, renames, shell or external Git dependency. */
function parsePatch(patch) {
  const lines = patch.replaceAll('\r\n', '\n').split('\n');
  const files = [];
  for (let index = 0; index < lines.length;) {
    if (!lines[index].startsWith('--- ')) { index += 1; continue; }
    const oldPath = lines[index++].slice(4), newPath = lines[index++]?.slice(4);
    if (!oldPath.startsWith('a/') || newPath !== `b/${oldPath.slice(2)}`) throw new Error('Native patches support existing text files only; path change is unsupported.');
    const path = oldPath.slice(2);
    if (!path || /[\u0000-\u001f\\]/u.test(path) || isAbsolute(path) || path.split('/').includes('..')) throw new Error('Native patch path escapes its package.');
    const hunks = [];
    while (index < lines.length && !lines[index].startsWith('diff --git ') && !lines[index].startsWith('--- ')) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(lines[index]);
      if (!header) { index += 1; continue; }
      index += 1;
      const hunk = { oldStart: Number(header[1]), oldCount: Number(header[2] ?? 1), newStart: Number(header[3]), newCount: Number(header[4] ?? 1), lines: [] };
      let oldCount = 0, newCount = 0;
      while (index < lines.length && (oldCount < hunk.oldCount || newCount < hunk.newCount || lines[index].startsWith('\\ No newline'))) {
        const line = lines[index++];
        if (line.startsWith('\\ No newline')) { if (!hunk.lines.length) throw new Error('Invalid native patch newline marker.'); hunk.lines.at(-1).noNewline = true; continue; }
        if (![' ', '-', '+'].includes(line[0])) throw new Error('Invalid native patch hunk.');
        hunk.lines.push({ kind: line[0], text: line.slice(1) });
        if (line[0] !== '+') oldCount += 1;
        if (line[0] !== '-') newCount += 1;
      }
      if (oldCount !== hunk.oldCount || newCount !== hunk.newCount) throw new Error('Invalid native patch hunk length.');
      hunks.push(hunk);
    }
    if (!hunks.length) throw new Error('Native patch contains no text hunks.');
    files.push({ path, hunks });
  }
  if (!files.length || /^(?:GIT binary patch|Binary files|rename |copy |new file mode|deleted file mode)/mu.test(patch)) throw new Error('Unsupported native patch operation.');
  return files;
}

function patchText(original, hunks) {
  if (original.includes('\0')) throw new Error('Cannot apply text patch to binary source.');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  let newline = original.endsWith('\n');
  const lines = original.replaceAll('\r\n', '\n').split('\n');
  if (newline) lines.pop();
  if (!original) lines.length = 0;
  const output = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const start = hunk.oldCount === 0 ? hunk.oldStart : Math.max(0, hunk.oldStart - 1);
    if (start < cursor || start > lines.length) throw new Error('Native patch hunk position does not match source.');
    output.push(...lines.slice(cursor, start)); cursor = start;
    if (output.length !== (hunk.newCount === 0 ? hunk.newStart : Math.max(0, hunk.newStart - 1))) throw new Error('Native patch new hunk position does not match source.');
    for (const line of hunk.lines) {
      if (line.kind !== '+') {
        if (lines[cursor] !== line.text) throw new Error('Native patch context does not match installed source.');
        cursor += 1;
      }
      if (line.kind !== '-') {
        output.push(line.text);
        if (line.noNewline) newline = false;
        else if (cursor >= lines.length) newline = true;
      }
    }
  }
  output.push(...lines.slice(cursor));
  return output.join(eol) + (newline ? eol : '');
}

async function installedPackages(nodeModules, names, found) {
  let entries;
  try { entries = await readdir(nodeModules, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
    const path = join(nodeModules, entry.name);
    if (entry.name.startsWith('@')) { await installedPackages(path, names, found); continue; }
    const metadata = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
    if (names.has(metadata.name)) found.push({ path, metadata });
    await installedPackages(join(path, 'node_modules'), names, found);
  }
}

/** Verify every package/hash/hunk first, then apply all changes to the isolated npm stage. */
export async function applyStagedNativePatches(runtimeRoot) {
  const root = await realpath(runtimeRoot);
  const manifest = JSON.parse(await readFile(join(root, 'desktop/native-patches.json'), 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.patches)) throw new Error('Unsupported native patch manifest.');
  const packages = [];
  await installedPackages(join(root, 'node_modules'), new Set(manifest.patches.map(item => item.name)), packages);
  const pending = new Map();
  for (const record of manifest.patches) {
    const buffer = await readFile(inside(root, await realpath(inside(root, resolve(root, record.path)))));
    if (digest(buffer) !== record.sha256) throw new Error(`Native patch digest mismatch: ${record.specifier}`);
    const matches = packages.filter(item => item.metadata.name === record.name);
    if (!matches.length) throw new Error(`Native patched package missing from desktop stage: ${record.specifier}`);
    const files = parsePatch(buffer.toString('utf8'));
    for (const item of matches) {
      if (item.metadata.version !== record.version) throw new Error(`Native patch version mismatch for ${record.name}: expected ${record.version}, installed ${item.metadata.version}`);
      const packageRoot = inside(root, await realpath(item.path));
      for (const file of files) {
        const path = inside(packageRoot, resolve(packageRoot, file.path));
        if ((await lstat(path)).isSymbolicLink()) throw new Error('Native patch target cannot be a symbolic link.');
        inside(packageRoot, await realpath(path));
        const original = pending.get(path) ?? await readFile(path, 'utf8');
        pending.set(path, patchText(original, file.hunks));
      }
    }
  }
  for (const [path, content] of pending) await writeFile(path, content);
  return manifest.patches.map(({ specifier, sha256 }) => ({ specifier, sha256 }));
}
