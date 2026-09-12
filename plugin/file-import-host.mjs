import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { nativeImport } from './page-native.mjs';
import { listWorkspaceFiles, readWorkspaceFile } from './workspace-files.mjs';
import { verifyChildRead } from './child-read-access.mjs';

const { TypertRemoteService } = await nativeImport('@deepseek-ai/dsh-typert-protocol');

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_FILE_NAME_BYTES = 240;
const REQUEST_FIELDS = ['base64', 'mime', 'name', 'size'];
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;
const PORTABLE_FORBIDDEN_CHARACTERS = /[<>:"|?*]/gu;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|(?:com|lpt)[1-9¹²³])(?:\.|$)/iu;

function sanitizeFileName(input) {
  const leaf = input.replaceAll('\\', '/').split('/').at(-1) ?? '';
  let name = leaf.normalize('NFC').replace(CONTROL_CHARACTERS, '')
    .replace(PORTABLE_FORBIDDEN_CHARACTERS, '_').trim().replace(/[. ]+$/u, '');
  if (!name) throw new Error('File import requires a usable file name.');
  if (WINDOWS_DEVICE_NAME.test(name)) name = `_${name}`;
  if (Buffer.byteLength(name, 'utf8') > MAX_FILE_NAME_BYTES) {
    throw new Error(`File import name must be at most ${MAX_FILE_NAME_BYTES} UTF-8 bytes.`);
  }
  return name;
}

function containedPath(root, name) {
  const target = resolve(root, name);
  const fromRoot = relative(root, target);
  if (!fromRoot || isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new Error('File import path escapes its upload directory.');
  }
  return target;
}

function assertInsideWorkspace(workspace, target) {
  const fromWorkspace = relative(workspace, target);
  if (!fromWorkspace || isAbsolute(fromWorkspace) || fromWorkspace === '..' || fromWorkspace.startsWith(`..${sep}`)) {
    throw new Error('File import path escapes the Agent workspace.');
  }
}

async function ensurePlainDirectory(path) {
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    try {
      await mkdir(path);
    } catch (mkdirError) {
      if (mkdirError?.code !== 'EEXIST') throw mkdirError;
    }
    entry = await lstat(path);
  }
  if (entry.isSymbolicLink()) throw new Error('ColdX managed upload directory cannot be a symbolic link.');
  if (!entry.isDirectory()) throw new Error('ColdX managed upload path must be a directory.');
}

function hashOf(data) {
  return createHash('sha256').update(data).digest('hex');
}

function truncateUtf8(input, maxBytes) {
  let result = '';
  let bytes = 0;
  for (const character of input) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

function withHashSuffix(name, hash, length = 12) {
  const suffix = `-${hash.slice(0, length)}`;
  const extension = truncateUtf8(extname(name), 64);
  const stem = extension ? name.slice(0, -extension.length) : name;
  const stemBudget = MAX_FILE_NAME_BYTES - Buffer.byteLength(suffix, 'utf8') - Buffer.byteLength(extension, 'utf8');
  return `${truncateUtf8(stem, stemBudget)}${suffix}${extension}`;
}

async function matchesExistingFile(path, data, hash, signal) {
  signal?.throwIfAborted();
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error('File import destination is not a regular file.');
  }
  if (entry.size !== data.length) return false;
  const existing = await readFile(path);
  signal?.throwIfAborted();
  return hashOf(existing) === hash;
}

async function createExclusiveFile(target, data, signal) {
  let handle;
  let ownsTarget = false;
  let committed = false;
  try {
    handle = await open(target, 'wx');
    ownsTarget = true;
    signal?.throwIfAborted();
    await handle.writeFile(data);
    signal?.throwIfAborted();
    await handle.close();
    handle = undefined;
    signal?.throwIfAborted();
    committed = true;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (ownsTarget && !committed) await unlink(target).catch(() => {});
    throw error;
  }
}

async function writeWithoutOverwrite(root, name, data, hash, signal) {
  const candidates = [name, withHashSuffix(name, hash), withHashSuffix(name, hash, hash.length)];
  for (const candidate of [...new Set(candidates)]) {
    signal?.throwIfAborted();
    const target = containedPath(root, candidate);
    try {
      await createExclusiveFile(target, data, signal);
      return candidate;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (await matchesExistingFile(target, data, hash, signal)) return candidate;
    }
  }
  throw new Error('File import hash collision at the destination.');
}

export const name = 'coldx-file-import';
export const inject = ['agents', 'typert'];

export const FILE_IMPORT_INVOCATIONS = [{
  id: 'coldx-files:import-file',
  service: 'coldxFiles',
  namespace: 'coldxFiles',
  method: 'importFile',
  invocation: { kind: 'direct' },
  parameters: [
    { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: { mode: 'src-json' } },
    { name: 'request', wire: 'request', source: 'json', codec: { mode: 'src-json' } },
  ],
  cancellation: { parameter: 'signal' },
  result: { mode: 'src-json' },
}];
for (const method of ['listFiles', 'readFile']) FILE_IMPORT_INVOCATIONS.push({
  ...FILE_IMPORT_INVOCATIONS[0], id: `coldx-files:${method}`, method,
});
for (const method of ['listChildFiles', 'readChildFile']) FILE_IMPORT_INVOCATIONS.push({
  ...FILE_IMPORT_INVOCATIONS[0], id: `coldx-files:${method}`, method,
  parameters: [
    { name: 'address', wire: 'address', source: 'json', codec: { mode: 'src-json' } },
    { name: 'request', wire: 'request', source: 'json', codec: { mode: 'src-json' } },
  ],
});

class FileImportService extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, 'coldxFiles');
    this.closed = false;
    this.lifetime = new AbortController();
    ctx.effect(() => () => {
      this.closed = true;
      this.lifetime.abort(new Error('ColdX file import unloaded.'));
    });
  }

  async workspaceOperation(operation, agent, request, signal) {
    if (this.closed) throw new Error('ColdX file import unloaded.');
    if (!agent || this.ctx.agents.get(agent.id) !== agent || !this.ctx.agents.roots().includes(agent)) throw new Error('ColdX files require their exact live root Agent.');
    const workspace = agent.session?.header?.cwd;
    if (typeof workspace !== 'string' || !workspace) throw new Error('ColdX files require a real Agent workspace.');
    const operationSignal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    return operation(workspace, request, operationSignal);
  }

  listFiles(agent, request, signal) { return this.workspaceOperation(listWorkspaceFiles, agent, request, signal); }
  readFile(agent, request, signal) { return this.workspaceOperation(readWorkspaceFile, agent, request, signal); }

  async childWorkspaceOperation(operation, address, request, signal) {
    if (this.closed) throw new Error('ColdX file import unloaded.');
    const operationSignal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    const child = await verifyChildRead(this.ctx, address, operationSignal);
    const result = await operation(child.workspace, request, operationSignal);
    await child.revalidate();
    return result;
  }

  listChildFiles(address, request, signal) { return this.childWorkspaceOperation(listWorkspaceFiles, address, request, signal); }
  readChildFile(address, request, signal) { return this.childWorkspaceOperation(readWorkspaceFile, address, request, signal); }

  async importFile(agent, request, signal) {
    if (this.closed) throw new Error('ColdX file import unloaded.');
    if (!agent || this.ctx.agents.get(agent.id) !== agent || !this.ctx.agents.roots().includes(agent)) {
      throw new Error('ColdX file import requires its exact live root Agent.');
    }
    const workspace = agent.session?.header?.cwd;
    if (typeof workspace !== 'string' || workspace.length === 0) {
      throw new Error('ColdX file import requires a real Agent workspace.');
    }
    const operationSignal = signal
      ? AbortSignal.any([signal, this.lifetime.signal])
      : this.lifetime.signal;
    operationSignal.throwIfAborted();
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || JSON.stringify(Object.keys(request).sort()) !== JSON.stringify(REQUEST_FIELDS)
      || typeof request.name !== 'string' || typeof request.mime !== 'string'
      || typeof request.base64 !== 'string' || typeof request.size !== 'number') {
      throw new Error('Invalid file import request fields.');
    }
    if (!Number.isSafeInteger(request.size) || request.size < 0) {
      throw new Error('File import size must be a non-negative integer.');
    }
    if (request.size > MAX_FILE_BYTES) throw new Error('File import exceeds the 8 MiB limit.');
    const expectedBase64Length = request.size === 0 ? 0 : Math.ceil(request.size / 3) * 4;
    if (request.base64.length !== expectedBase64Length) {
      throw new Error('File import requires canonical base64.');
    }
    const data = Buffer.from(request.base64, 'base64');
    if (data.toString('base64') !== request.base64) throw new Error('File import requires canonical base64.');
    if (data.length !== request.size) throw new Error('File import size does not match decoded bytes.');
    const name = sanitizeFileName(request.name);
    const realWorkspace = await realpath(workspace);
    operationSignal.throwIfAborted();
    const managedRoot = join(realWorkspace, '.coldx');
    await ensurePlainDirectory(managedRoot);
    operationSignal.throwIfAborted();
    const uploadRoot = join(managedRoot, 'uploads');
    await ensurePlainDirectory(uploadRoot);
    const realUploadRoot = await realpath(uploadRoot);
    assertInsideWorkspace(realWorkspace, realUploadRoot);
    operationSignal.throwIfAborted();
    const hash = hashOf(data);
    const storedName = await writeWithoutOverwrite(realUploadRoot, name, data, hash, operationSignal);
    operationSignal.throwIfAborted();
    return {
      path: `.coldx/uploads/${storedName}`,
      name: storedName,
      bytes: data.length,
      mime: request.mime,
      hash,
    };
  }
}

export function apply(ctx) {
  new FileImportService(ctx);
  ctx.typert.register({
    package: 'coldx-file-import', face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] }, invocations: FILE_IMPORT_INVOCATIONS,
  });
}
