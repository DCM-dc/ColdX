import { readFile, writeFile, realpath, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

export const name = 'coldx-evaluation-driver';
export const inject = ['agents', 'sessions', 'agentDefaultModel', 'agentPresets', 'systemPrompt', 'sessionPersistence', 'webServer'];

export function apply(ctx, config) {
  run(ctx, config).catch(async error => {
    const request = JSON.parse(await readFile(config.requestPath, 'utf8'));
    await writeFile(join(request.output, 'report.json'), JSON.stringify({ version: 1, status: 'driver-error', error: error.message }, null, 2) + '\n');
    process.stderr.write(`ColdX native evaluation: ${error.stack ?? error.message}\n`);
    ctx.get('appExit')?.(1);
  });
}

async function run(ctx, config) {
  const request = JSON.parse(await readFile(config.requestPath, 'utf8'));
  const sourceRequire = createRequire(join(request.source, 'package.json'));
  const nativeRequire = createRequire(await realpath(sourceRequire.resolve('@deepseek-ai/dsh/package.json')));
  const nativeImport = name => import(pathToFileURL(nativeRequire.resolve(name)).href);
  const { installModelSelection } = await nativeImport('@deepseek-ai/dsh-agent');
  const { createUserMessage } = await nativeImport('@deepseek-ai/dsh-llm');
  await ctx.get('loader')?.await();
  const counters = new Map();
  const nativeErrors = [];
  let activityRevision = 0;
  const get = agent => {
    if (!counters.has(agent.id)) counters.set(agent.id, { agent, admitted: 0, actual: 0, requests: 0, limited: false });
    return counters.get(agent.id);
  };
  // Both hooks operate inside the native dispatch chain; they neither request
  // completions nor execute a model tool. All agents in this isolated host count.
  ctx.on('agent/pre-step', async ({ agent, step }, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    if (step === 1 && decision.messages.length === 0) return decision;
    const state = get(agent);
    if (state.admitted >= request.maxSteps) { state.limited = true; return { kind: 'reject' }; }
    state.admitted++;
    return decision;
  });
  ctx.on('agent/request', async ({ agent }, next) => {
    const prepared = await next();
    get(agent).requests++;
    return { ...prepared, provider: request.provider, model: request.model, reasoningEffort: request.reasoningEffort, temperature: request.temperature };
  });
  ctx.on('session/event', (session, event) => {
    activityRevision++;
    if (event.type === 'step/start') {
      const agent = ctx.agents.get(session.id);
      if (agent) get(agent).actual++;
    }
  });
  ctx.on('agent/error', ({ agent, error }) => {
    nativeErrors.push({ agentId: agent.id, name: error?.name, message: error?.message ?? String(error) });
  });
  async function drainNativeAgents() {
    const revision = activityRevision;
    const live = ctx.agents.list();
    await Promise.all(live.map(active => active.whenIdle()));
    await new Promise(resolve => setImmediate(resolve));
    // Child completion can enqueue a native parent notice after the parent's
    // earlier idle promise resolved. Only inspect and await native lifetimes.
    if (activityRevision !== revision || ctx.agents.list().some(active => !live.includes(active))) await drainNativeAgents();
  }
  const preset = await ctx.agentPresets.resolve('coldx');
  const selection = { provider: request.provider, model: request.model, reasoningEffort: request.reasoningEffort };
  const { agent } = await ctx.agents.create({
    sessionId: `coldx-eval-${randomUUID()}`,
    meta: { cwd: request.workspace, agentPreset: preset.id },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async agentCtx => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined });
      await ctx.agentPresets.mount(agentCtx, preset.id);
    },
  });
  get(agent);
  await agent.whenIdle();
  const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent, signal: new AbortController().signal });
  const tools = assembly.tools.map(tool => tool.name).sort();
  const sections = assembly.sections.map(section => section.name);
  const policyPresent = sections.includes('coldx:operating-policy');
  const required = ['coldx_session_context', 'coldx_present_page', 'coldx_browser', 'coldx_plugins_search', 'write'];
  if (!policyPresent || required.some(tool => !tools.includes(tool))) throw new Error(`Incomplete ColdX native composition: policy=${policyPresent}, missing=${required.filter(tool => !tools.includes(tool)).join(',')}`);
  const startedAt = new Date().toISOString();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    for (const active of ctx.agents.list()) active.cancel({ kind: 'user' });
  }, request.timeoutMs);
  try {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: await readFile(request.taskFile, 'utf8') }] }));
    await drainNativeAgents();
  } finally { clearTimeout(timer); }
  const trajectoryDirectory = join(request.output, 'trajectories');
  await mkdir(trajectoryDirectory);
  const usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const agents = [];
  for (const state of counters.values()) {
    const session = state.agent.session;
    // Foreground subagents may already be disposed by the native subagent
    // provider. Its teardown owns the final flush; re-flushing a detached
    // Session through the live store is a native contract violation.
    if (ctx.agents.get(session.id) === state.agent) await state.agent.ctx.sessions.flush(session);
    const stored = await ctx.sessionPersistence.readRaw(session.id);
    if (!stored) throw new Error(`Native trajectory missing: ${session.id}`);
    const trajectory = join(trajectoryDirectory, `${session.id}.jsonl`);
    await writeFile(trajectory, stored.content);
    for (const event of session.events) if (event.type === 'assistant/message' && event.data.usage) {
      for (const field of Object.keys(usage)) usage[field] += event.data.usage[field] ?? 0;
    }
    const contexts = session.events.filter(event => event.type === 'request/context').map(event => event.data);
    const requestHeaders = session.events.filter(event => event.type === 'request/header').map(event => event.data.header.config);
    if (state.requests && (!contexts.length || contexts.some(value => value.contextWindow !== request.contextWindow))) throw new Error(`Context window mismatch for ${session.id}`);
    if (state.requests && (!requestHeaders.length || requestHeaders.some(value => value.provider !== request.provider || value.model !== request.model || value.reasoningEffort !== request.reasoningEffort || value.temperature !== request.temperature))) throw new Error(`Native sampling configuration mismatch for ${session.id}`);
    agents.push({ id: session.id, parentSession: session.header.parentSession ?? null, steps: state.actual, admittedSteps: state.admitted, requestPreparations: state.requests, limited: state.limited, trajectory, contexts, requestHeaders });
  }
  const events = agent.session.events;
  const end = events.findLast(event => event.type === 'turn/end')?.data.reason ?? null;
  const limited = agents.some(row => row.limited);
  const status = timedOut ? 'timeout' : limited ? 'step-limit' : end?.kind === 'completed' ? 'completed' : end?.kind ?? 'unknown';
  let visibleResult = '';
  for (const event of events) if (event.type === 'assistant/message') {
    const text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
    if (text) visibleResult = text;
  }
  const report = {
    version: 1, status, startedAt, finishedAt: new Date().toISOString(), end, visibleResult, nativeErrors,
    identity: { preset: preset.id, policyPresent, tools, sections, policySha256: request.policySha256, coldxVersion: request.coldxVersion, dshVersion: request.dshVersion },
    configuration: { provider: request.provider, model: request.model, reasoningEffort: request.reasoningEffort, temperature: request.temperature, contextWindow: request.contextWindow, browserRuntime: request.browserRuntime, processParallelism: request.processParallelism, topP: { owner: 'external-evaluation-proxy', independentlyVerified: false } },
    steps: { scope: 'per-agent', limit: request.maxSteps, actual: agents.reduce((sum, row) => sum + row.steps, 0) },
    usage, usageScope: 'native assistant/message usage across task agents; auxiliary provider calls require proxy accounting', agents,
    trajectory: agents.find(row => row.id === agent.id).trajectory, nativePersistenceRoot: join(request.home, 'sessions'),
  };
  await writeFile(join(request.output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ status, report: join(request.output, 'report.json'), trajectory: report.trajectory }) + '\n');
  ctx.get('appExit')(status === 'completed' ? 0 : status === 'step-limit' ? 2 : 1);
}
