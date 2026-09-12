import { AsyncLocalStorage } from 'node:async_hooks';
import { nativeImport } from './page-native.mjs';
import { TerminalStreamStore } from './terminal-stream.mjs';
import { verifyChildRead } from './child-read-access.mjs';

const { TypertRemoteService } = await nativeImport('@deepseek-ai/dsh-typert-protocol');
export const name = 'coldx-terminal-stream';
export const inject = ['agents', 'tools', 'typert'];
export const TERMINAL_INVOCATIONS = [{
  id: 'coldx-terminal:read', service: 'coldxTerminal', namespace: 'coldxTerminal', method: 'read',
  invocation: { kind: 'direct' },
  parameters: [
    { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: { mode: 'src-json' } },
    { name: 'request', wire: 'request', source: 'json', codec: { mode: 'src-json' } },
  ],
  cancellation: { parameter: 'signal' }, result: { mode: 'src-json' },
}];
TERMINAL_INVOCATIONS.push({
  ...TERMINAL_INVOCATIONS[0], id: 'coldx-terminal:read-child', method: 'readChild',
  parameters: [
    { name: 'address', wire: 'address', source: 'json', codec: { mode: 'src-json' } },
    { name: 'request', wire: 'request', source: 'json', codec: { mode: 'src-json' } },
  ],
});

function assertReadRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some(key => key !== 'afterRevision' && key !== 'waitMs')
    || !Number.isSafeInteger(request.afterRevision) || request.afterRevision < -1
    || !Number.isInteger(request.waitMs) || request.waitMs < 0 || request.waitMs > 20_000) throw new Error('Invalid terminal stream request.');
}

class TerminalService extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, 'coldxTerminal');
    this.store = new TerminalStreamStore();
    this.lifetime = new AbortController();
    ctx.effect(() => () => { this.lifetime.abort(new Error('Terminal stream closed.')); this.store.dispose(); });
  }
  read(agent, request, signal) {
    if (!agent || this.ctx.agents.get(agent.id) !== agent) throw new Error('Terminal requires its exact live Agent.');
    assertReadRequest(request);
    return this.store.wait(agent.id, request.afterRevision, { signal, waitMs: request.waitMs });
  }
  async readChild(address, request, signal) {
    assertReadRequest(request);
    const operationSignal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    const child = await verifyChildRead(this.ctx, address, operationSignal);
    const result = await this.store.wait(child.sessionId, request.afterRevision, { signal: operationSignal, waitMs: request.waitMs });
    await child.revalidate();
    return result;
  }
}

export function apply(ctx) {
  const service = new TerminalService(ctx);
  const calls = new AsyncLocalStorage();
  ctx.effect(() => () => calls.disable());
  ctx.typert.register({ package: 'coldx-terminal-stream', face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] }, invocations: TERMINAL_INVOCATIONS });
  ctx.on('tools/execute', (exec, next) => {
    let owner;
    // Only native shell tools: search/LSP/indexing subprocesses never become terminal history.
    if (['bash', 'pwsh'].includes(exec.name) && exec.agent && ctx.agents.get(exec.agent.id) === exec.agent) {
      try {
        const view = ctx.tools.get(exec.name, exec.agent)?.presentCall?.(exec.arguments);
        const background = exec.arguments?.run_in_background === true;
        if (typeof view?.title === 'string' && (view.card === 'terminal' || background)) {
          owner = { sessionId: exec.agent.id, callId: exec.callId, command: view.title, background };
        }
      } catch { /* A display observer must not affect tool execution. */ }
    }
    // Clear inherited identity on unrelated/nested calls; only their own shell dispatch may set it.
    return calls.run(owner, next);
  });
  ctx.on('subprocess/spawn', (handle, metadata) => {
    const owner = calls.getStore();
    if (owner) service.store.observe(owner, handle, { cwd: metadata?.cwd, signal: metadata?.signal });
  });
  ctx.inject(['jobs'], jobsContext => {
    // Use non-consuming native job snapshots, including explicit kill state on Windows.
    jobsContext.jobs.onJobsChanged(agent => {
      if (!agent) return;
      for (const id of service.store.jobsForSession(agent.id)) {
        try { service.store.updateJob(agent.id, jobsContext.jobs.get(id, agent)); } catch { /* Removed owner/job. */ }
      }
    });
    jobsContext.on('tools/result', (exec, result) => {
      if (!['bash', 'pwsh'].includes(exec.name) || !exec.agent || result.isError
        || result.value?.kind !== 'background' || typeof result.value.jobId !== 'string') return;
      try { service.store.bindJob(exec.agent.id, exec.callId, jobsContext.jobs.get(result.value.jobId, exec.agent)); }
      catch { /* An already-unloaded job cannot affect the command's result. */ }
    });
  });
}
