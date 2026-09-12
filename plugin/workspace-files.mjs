import { realpath, readdir, stat, lstat, open } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep, extname, basename } from 'node:path';

const TEXT_LIMIT = 2 * 1024 * 1024;
const BINARY_LIMIT = 8 * 1024 * 1024;
const MIME = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.avif':'image/avif', '.pdf':'application/pdf', '.svg':'image/svg+xml', '.html':'text/html', '.htm':'text/html', '.md':'text/markdown', '.txt':'text/plain', '.csv':'text/csv', '.json':'application/json' };
function contains(root, target) {
  const part = relative(root, target);
  return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
}
function inside(root, target) {
  if (!contains(root, target)) throw new Error('File path escapes the Agent workspace.');
}
async function locate(workspace, request, signal) {
  signal?.throwIfAborted();
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).length !== 1 || typeof request.path !== 'string' || /[\u0000-\u001f]/u.test(request.path)) throw new Error('Invalid workspace file request.');
  const declaredRoot = resolve(workspace);
  const root = await realpath(declaredRoot);
  const candidate = resolve(declaredRoot, request.path || '.');
  // Windows short names and selected directory aliases are valid workspace
  // spellings. Admit only a lexical child of either spelling, then enforce the
  // canonical root again after resolving any links in the requested path.
  if (!contains(declaredRoot, candidate)) inside(root, candidate);
  const target = await realpath(candidate);
  inside(root, target);
  signal?.throwIfAborted();
  return { root, target, path: relative(root, target).split(sep).join('/') || '.' };
}
export async function listWorkspaceFiles(workspace, request, signal) {
  const located = await locate(workspace, request, signal);
  const entries = await readdir(located.target, { withFileTypes: true });
  signal?.throwIfAborted();
  const sorted = entries.filter(entry => entry.isDirectory() || entry.isFile()).sort((a,b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  // Confirm the listed names against the canonical directory, so a replaced
  // directory cannot leak names which don't exist in this workspace.
  const verified = (await Promise.all(sorted.slice(0,500).map(async entry => {
    try {
      const current = await lstat(resolve(located.target,entry.name));
      if (current.isSymbolicLink() || current.isDirectory() !== entry.isDirectory() || current.isFile() !== entry.isFile()) return null;
      return {name:entry.name,path:located.path === '.' ? entry.name : `${located.path}/${entry.name}`,kind:entry.isDirectory() ? 'directory' : 'file'};
    } catch { return null; }
  }))).filter(Boolean);
  inside(located.root,await realpath(located.target));
  signal?.throwIfAborted();
  return { path: located.path, truncated: sorted.length > 500, entries:verified };
}
export async function describeWorkspaceFile(workspace, request, signal) {
  const located = await locate(workspace, request, signal);
  const info = await stat(located.target);
  signal?.throwIfAborted();
  if (!info.isFile()) throw new Error('Artifact requires a regular file.');
  return { path:located.path, name:basename(located.target), bytes:info.size, modifiedAt:info.mtimeMs, mime:MIME[extname(located.target).toLowerCase()] || 'application/octet-stream' };
}
export async function readWorkspaceFile(workspace, request, signal) {
  const located = await locate(workspace, request, signal);
  const handle = await open(located.target, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Preview requires a regular file.');
    const extension = extname(located.target).toLowerCase();
    const mime = MIME[extension] || 'text/plain';
    const binary = /^(image\/|application\/pdf)/u.test(mime) && extension !== '.svg';
    const limit = binary ? BINARY_LIMIT : TEXT_LIMIT;
    const buffer = Buffer.alloc(Math.min(info.size, limit));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    signal?.throwIfAborted();
    // Recheck the real path after opening; a moved workspace/symlink must not silently widen access.
    inside(located.root, await realpath(located.target));
    const [openedIdentity, pathIdentity] = await Promise.all([handle.stat({bigint:true}),stat(located.target,{bigint:true})]);
    if (openedIdentity.dev !== pathIdentity.dev || openedIdentity.ino !== pathIdentity.ino) throw new Error('File identity changed during preview; reopen the file.');
    const data = buffer.subarray(0, bytesRead);
    const utf16 = data.length >= 2 && (data[0] === 0xff && data[1] === 0xfe || data[0] === 0xfe && data[1] === 0xff);
    const encoding = utf16 ? (data[0] === 0xff ? 'utf-16le' : 'utf-16be') : 'utf-8';
    const decoded = binary ? undefined : new TextDecoder(encoding).decode(utf16 ? data.subarray(0,data.length - data.length % 2) : data).replace(/^\uFEFF/u,'');
    const knownText = /^(?:text\/|application\/json)/u.test(MIME[extension] || '') || /\.(?:svg|js|mjs|cjs|ts|tsx|jsx|css|py|c|cpp|h|hpp|rs|go|sh|ps1|yaml|yml|toml|xml|log)$/u.test(extension);
    const nullCount = binary ? 0 : decoded.split('\u0000').length - 1;
    const unknownBinary = !binary && nullCount > 0 && !knownText;
    const kind = unknownBinary ? 'binary' : binary ? (mime === 'application/pdf' ? 'pdf' : 'image') : extension === '.md' ? 'markdown' : /\.html?$/u.test(extension) ? 'html' : 'text';
    return { path: located.path, absolutePath:located.target, name: basename(located.target), bytes: info.size, modifiedAt: info.mtimeMs, mime: unknownBinary ? 'application/octet-stream' : mime, kind, truncated: info.size > bytesRead,
      ...(binary || unknownBinary ? { base64: data.toString('base64') } : { text:decoded.replaceAll('\u0000','\uFFFD'), encoding, replacedNulls:nullCount,
        ...(!data.equals(Buffer.from(decoded.replaceAll('\u0000','\uFFFD'),'utf8')) ? {downloadBase64:data.toString('base64')} : {}) }) };
  } finally { await handle.close(); }
}
