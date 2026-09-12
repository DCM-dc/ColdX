import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { nativeImport } from './page-native.mjs';
import { createLabFiles } from './lab-files.mjs';

const { TypertRemoteService } = await nativeImport('@deepseek-ai/dsh-typert-protocol');
const { defineTool } = await nativeImport('@deepseek-ai/dsh-tools');
const projectRoot = fileURLToPath(new URL('..', import.meta.url));

export const name = 'coldx-lab';
export const inject = ['tools', 'agents', 'typert'];

/** Native Gateway descriptors. The existing Connection owns transport/trust.
 * Browser: connection.rpc.call('/api', 'coldxLab/create',
 *   { args: { agentId: sessionId, request: { requestId } } }, signal).
 * The Agent lookup resolves the live object before the service is invoked.
 */
export const LAB_INVOCATIONS = ['create', 'inspect', 'apply'].map(method => ({
  id: `coldx-lab:${method}`, service: 'coldxLab', namespace: 'coldxLab', method,
  invocation: { kind: 'direct' },
  parameters: [
    { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: { mode: 'src-json' } },
    { name: 'request', wire: 'request', source: 'json', codec: { mode: 'src-json' } },
  ],
  cancellation: { parameter: 'signal' }, result: { mode: 'src-json' },
}));

function requestShape(request, allowed) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some(key => !allowed.includes(key))) throw new Error('Invalid lab request fields.');
  return request;
}

class LabService extends TypertRemoteService {
  constructor(ctx, config) {
    super(ctx, 'coldxLab');
    this.closed = false;
    this.lifetime = new AbortController();
    this.files = createLabFiles({
      labRoot: config.labRoot ?? resolve(projectRoot, '.runtime', 'interaction-lab'),
      outputRoot: config.outputRoot ?? resolve(projectRoot, '..', 'interaction-lab'),
    });
    ctx.effect(() => () => { this.closed = true; this.lifetime.abort('ColdX lab unloaded'); });
  }
  invoke(method, agent, request, signal) {
    if (this.closed) throw new Error('ColdX lab unloaded.');
    if (!agent || this.ctx.agents.get(agent.id) !== agent) throw new Error('Lab requires the exact live Agent.');
    const lifetime = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    lifetime.throwIfAborted();
    return this.files[method]({ ...request, ownerId: agent.id, signal: lifetime });
  }
  async create(agent, request, signal) {
    return this.invoke('create', agent, requestShape(request, ['requestId']), signal);
  }
  async inspect(agent, request, signal) {
    return this.invoke('inspect', agent, requestShape(request, ['runId']), signal);
  }
  async apply(agent, request, signal) {
    return this.invoke('apply', agent, requestShape(request, ['runId', 'requestId', 'planId', 'overrides']), signal);
  }
}

/** Install once at the Host root, alongside the native Web client Host plugin. */
export function apply(ctx, config = {}) {
  const service = new LabService(ctx, config);
  ctx.typert.register({ package: 'coldx-lab', face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] }, invocations: LAB_INVOCATIONS });
  const tools = [
    ['create', 'Create twelve clearly artificial sample files in the dedicated ColdX lab. Returns real file descriptors and four organization previews. Never reads or changes the user desktop.', {
      requestId: { type: 'string', required: true, description: 'Stable unique request ID, letters/digits/hyphen/underscore, at most 128 characters. Retry with the same ID after an uncertain response.' },
    }],
    ['inspect', 'Inspect this Agent-owned sample run, verify its sources and completed output hashes, and obtain four real organization previews.', {
      runId: { type: 'string', required: true, description: 'Exact runId returned by coldx_lab_create.' },
    }],
    ['apply', 'Apply a selected organization preview to an immutable output version under outputs/interaction-lab. Copies only the twelve artificial sample files and verifies their hashes; originals are preserved. Use the same requestId to retry the same operation. A new requestId creates another version.', {
      runId: { type: 'string', required: true }, requestId: { type: 'string', required: true },
      planId: { type: 'string', enum: ['project', 'type', 'time', 'mixed'], required: true },
      overrides: { type: 'object', properties: {}, additionalProperties: true, description: 'Optional object mapping an existing file ID to a short single folder name. No slashes, relative paths or reserved device names.' },
    }],
  ];
  for (const [method, description, parameters] of tools) ctx.tools.register(defineTool({
    name: `coldx_lab_${method}`, description, parameters,
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: (args, execution) => service[method](execution.agent, args, execution.signal),
  }));
}
