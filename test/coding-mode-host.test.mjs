import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeImport, nativeRuntime } from './native-helpers.mjs';

async function fixture(t) {
  const ctx = await nativeRuntime();
  t.after(() => ctx.fiber.dispose());
  for (const name of ['dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop', 'dsh-session-projection', 'dsh-commands', 'dsh-goal', 'dsh-user-questions']) {
    const mod = await nativeImport(`@deepseek-ai/${name}`);
    await ctx.plugin(mod.default ?? mod, {});
  }
  const codingModePersistence = await import('../plugin/coding-mode-persistence-host.mjs');
  await ctx.plugin(codingModePersistence);
  const { agent: a } = await ctx.agents.create({ sessionId: 'session-coding-a' });
  const { agent: b } = await ctx.agents.create({ sessionId: 'session-coding-b' });
  const codingMode = await import('../plugin/coding-mode-host.mjs');
  const fiber = await a.ctx.plugin(codingMode);
  return { ctx, a, b, fiber };
}

const execute = (ctx, agent, line, signal = new AbortController().signal) => ctx.commands.execute(agent, line, [], signal);
const snapshot = (ctx, agent) => ctx.sessionProjections.snapshot(agent.session).values['coldx.codingMode'];

test('scoped Goal selection persists without creating a turn, message, or native goal', async t => {
  const { ctx, a, b, fiber } = await fixture(t);
  assert.ok(ctx.commands.find(a, 'coldx-goal'));
  assert.equal(ctx.commands.find(b, 'coldx-goal'), undefined);
  const before = a.session.events.length;
  const result = await execute(ctx, a, '/coldx-goal on');
  assert.equal(result.result.kind, 'success');
  assert.deepEqual(snapshot(ctx, a), { goal: true });
  assert.equal(ctx.goals.get(a), undefined);
  const added = a.session.events.slice(before);
  assert.deepEqual(added.map(event => event.type), ['command/run', 'command/done']);
  assert.equal(added[0].data.args, ' on');
  assert.equal(added.some(event => ['turn/start', 'user/message'].includes(event.type)), false);
  assert.equal(a.status, 'idle');
  assert.deepEqual(snapshot(ctx, b), { goal: false });
  await fiber.dispose();
  assert.equal(ctx.commands.find(a, 'coldx-goal'), undefined);
});

test('invalid and cancelled commands never claim a selected mode', async t => {
  const { ctx, a } = await fixture(t);
  const invalid = await execute(ctx, a, '/coldx-goal someday');
  assert.equal(invalid.result.kind, 'error');
  assert.match(invalid.result.text, /on\|off/);
  assert.deepEqual(snapshot(ctx, a), { goal: false });
  const controller = new AbortController(); controller.abort('cancelled');
  await assert.rejects(execute(ctx, a, '/coldx-goal on', controller.signal));
  assert.deepEqual(snapshot(ctx, a), { goal: false });
});

test('Goal off pauses an active native goal before recording off and retains the objective', async t => {
  const { ctx, a } = await fixture(t);
  await execute(ctx, a, '/coldx-goal on');
  const active = ctx.goals.create(a, { objective: 'Ship the verified workspace' });
  const result = await execute(ctx, a, '/coldx-goal off');
  assert.equal(result.result.kind, 'success');
  assert.deepEqual(snapshot(ctx, a), { goal: false });
  const paused = ctx.goals.get(a);
  assert.equal(paused.phase, 'paused');
  assert.equal(paused.objective, active.objective);
  const types = a.session.events.map(event => event.type);
  assert.ok(types.lastIndexOf('goal/change') < types.lastIndexOf('command/done'));
});

test('a pause failure never appends a false preference', async t => {
  const { ctx, a } = await fixture(t);
  await execute(ctx, a, '/coldx-goal on');
  ctx.goals.create(a, { objective: 'Stay selected on failure' });
  const original = ctx.goals.pause.bind(ctx.goals);
  ctx.goals.pause = () => { throw new Error('pause rejected'); };
  await assert.rejects(execute(ctx, a, '/coldx-goal off'), /pause rejected/);
  assert.deepEqual(snapshot(ctx, a), { goal: true });
  assert.equal(a.session.events.some(event => event.type === 'coldx/coding-mode'), false);
  ctx.goals.pause = original;
});

test('a command completion append failure after a successful pause stays conservatively selected and paused', async t => {
  const { ctx, a } = await fixture(t);
  await execute(ctx, a, '/coldx-goal on');
  ctx.goals.create(a, { objective: 'Preserve partial failure state' });
  const append = a.session.append.bind(a.session);
  a.session.append = (type, data, ...options) => {
    if (type === 'command/done' && data.kind === 'success') throw new Error('command completion append rejected');
    return append(type, data, ...options);
  };
  await assert.rejects(execute(ctx, a, '/coldx-goal off'), /command completion append rejected/);
  assert.equal(ctx.goals.get(a).phase, 'paused');
  assert.deepEqual(snapshot(ctx, a), { goal: true });
  assert.equal(a.session.events.some(event => event.type === 'coldx/coding-mode'), false);
  assert.equal(a.session.events.findLast(event => event.type === 'command/run').data.args, ' off');
  a.session.append = append;
});

test('cancellation after pause cannot append off and repeated commands remain idempotent', async t => {
  const { ctx, a } = await fixture(t);
  await execute(ctx, a, '/coldx-goal on');
  await execute(ctx, a, '/coldx-goal on');
  assert.equal(a.session.events.filter(event => event.type === 'command/done' && event.data.kind === 'success').length, 2);
  const active = ctx.goals.create(a, { objective: 'Keep exact native identity' });
  const controller = new AbortController();
  const pause = ctx.goals.pause.bind(ctx.goals);
  ctx.goals.pause = (agent, ref) => {
    assert.deepEqual(ref, { id: active.id, revision: active.revision });
    const paused = pause(agent, ref); controller.abort('cancel after pause'); return paused;
  };
  await assert.rejects(execute(ctx, a, '/coldx-goal off', controller.signal));
  assert.equal(ctx.goals.get(a).phase, 'paused');
  assert.deepEqual(snapshot(ctx, a), { goal: true });
  ctx.goals.pause = pause;
  await execute(ctx, a, '/coldx-goal off');
  await execute(ctx, a, '/coldx-goal off');
  assert.deepEqual(snapshot(ctx, a), { goal: false });
  assert.equal(a.session.events.some(event => event.type === 'coldx/coding-mode'), false);
  await execute(ctx, a, '/coldx-goal on');
  assert.equal(ctx.goals.get(a).phase, 'paused', 'selection alone never resumes native work');
});

test('the scoped handler rejects a sibling and owned child even if invoked directly', async t => {
  const { ctx, a, b } = await fixture(t);
  const definition = ctx.commands.find(a, 'coldx-goal');
  const signal = new AbortController().signal;
  assert.throws(() => definition.handler({ agent: b, rawInput: 'on', attachments: [], signal, commandId: 'spoof-sibling' }), /exact live root Agent/);
  const { agent: child } = await a.ctx.agents.create({ sessionId: 'session-coding-child' });
  assert.ok(!ctx.agents.roots().includes(child));
  assert.throws(() => definition.handler({ agent: child, rawInput: 'on', attachments: [], signal, commandId: 'spoof-child' }), /exact live root Agent/);
  assert.deepEqual(snapshot(ctx, a), { goal: false });
  assert.deepEqual(snapshot(ctx, b), { goal: false });
});

test('selected Goal contributes a scoped system section and survives projection replay', async t => {
  const { ctx, a, b } = await fixture(t);
  const { renderPrompt } = await nativeImport('@deepseek-ai/dsh-system-prompt');
  await execute(ctx, a, '/coldx-goal on');
  const selectedAssembly = await ctx.systemPrompt.assemble({ scope: a, agent: a, signal: new AbortController().signal });
  const otherAssembly = await ctx.systemPrompt.assemble({ scope: b, agent: b, signal: new AbortController().signal });
  const selected = renderPrompt(selectedAssembly);
  const other = renderPrompt(otherAssembly);
  assert.match(selected, /Goal mode is selected/);
  assert.match(selected, /direct human request/);
  assert.match(selected, /get_goal/);
  assert.match(selected, /create_goal/);
  assert.match(selected, /infer a concise completion objective/i);
  assert.match(selected, /Plan mode/);
  assert.equal(selectedAssembly.contexts.some(context => context.name === 'coldx:coding-mode'), false, 'policy must not become a user-role runtime snapshot');
  assert.ok(selectedAssembly.sections.some(section => section.name === 'coldx:coding-mode' && section.text.includes('Goal mode is selected')));
  assert.doesNotMatch(other, /Goal mode is selected/);
  const { agent: child } = await a.ctx.agents.create({ sessionId: 'session-coding-prompt-child' });
  const childPrompt = renderPrompt(await ctx.systemPrompt.assemble({ scope: child, agent: child, signal: new AbortController().signal }));
  assert.doesNotMatch(childPrompt, /Goal mode is selected/);
  const events = structuredClone(a.session.events);
  const { codingModeState } = await import('../plugin/coding-mode-model.mjs');
  assert.deepEqual(codingModeState(events), { goal: true });
});

test('the first direct human request can create a grounded native goal through the deterministic tool path', { timeout: 10_000 }, async t => {
  const { ctx, a } = await fixture(t);
  const toolGoal = await nativeImport('@deepseek-ai/dsh-tool-goal');
  await a.ctx.plugin(toolGoal.default ?? toolGoal, {});
  const { LlmAdapter, createUserMessage } = await nativeImport('@deepseek-ai/dsh-llm');
  const requests = [];
  class GoalAdapter extends LlmAdapter {
    async *stream(request) {
      requests.push(request);
      const n = requests.length;
      const block = n === 1
        ? { type: 'tool-call', name: 'get_goal', id: 'read-goal', arguments: '{}' }
        : n === 2
          ? { type: 'tool-call', name: 'create_goal', id: 'create-goal', arguments: JSON.stringify({ objective: 'Build and verify the requested cache dashboard' }) }
          : { type: 'text', text: 'Goal created and work is continuing.' };
      yield { type: 'block-start', index: 0, blockType: block.type };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['goal-fixture'], new GoalAdapter());
  a.options.provider = 'goal-fixture'; a.options.model = 'coding-goal';
  await execute(ctx, a, '/coldx-goal on');
  a.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Build me a cache dashboard and verify it end to end.' }] }));
  await a.whenIdle();
  const calls = a.session.events.filter(event => event.type === 'tool/call');
  assert.deepEqual(calls.slice(0, 2).map(event => event.data.name), ['get_goal', 'create_goal']);
  const createdArgs = JSON.parse(calls[1].data.arguments);
  assert.match(createdArgs.objective, /cache dashboard/i);
  const nativeGoal = ctx.goals.get(a);
  assert.equal(nativeGoal.objective, createdArgs.objective);
  assert.equal(nativeGoal.phase, 'active');
  const firstRequest = JSON.stringify(requests[0]);
  assert.match(firstRequest, /Goal mode is selected/);
  assert.match(firstRequest, /Build me a cache dashboard and verify it end to end/);
  assert.doesNotMatch(JSON.stringify(requests[0].messages), /coldx-goal|command\/(?:run|done)/,
    'durable command lifecycle records must stay outside the model-visible surface');
  assert.equal(calls.filter(event => event.data.name === 'create_goal').length, 1);
  assert.equal(a.session.events.filter(event => event.type === 'goal/change').length, 1);
});

test('Goal and native Plan projections can both be selected', async t => {
  const { ctx, a } = await fixture(t);
  const planMode = await nativeImport('@deepseek-ai/dsh-plan-mode');
  await ctx.plugin(planMode.default ?? planMode, { section: 'Plan fixture work before implementation.' });
  await execute(ctx, a, '/coldx-goal on');
  ctx.planMode.set(a, true);
  assert.deepEqual(snapshot(ctx, a), { goal: true });
  assert.deepEqual(ctx.sessionProjections.snapshot(a.session).values.plan, { active: true, pending: false });
});

test('combined Goal and Plan performs native goal bookkeeping before review and business mutation only after approval', { timeout: 10_000 }, async t => {
  const { ctx, a } = await fixture(t);
  const planMode = await nativeImport('@deepseek-ai/dsh-plan-mode');
  await ctx.plugin(planMode.default ?? planMode, { section: `You are in plan mode. Do not edit or write files, change configuration, or otherwise carry out the plan. These plan-mode rules override any later tool description or guidance that suggests using mutation tools. When ready, call exit_plan_mode for native plan review.` });
  const toolGoal = await nativeImport('@deepseek-ai/dsh-tool-goal');
  await a.ctx.plugin(toolGoal.default ?? toolGoal, {});
  const { defineTool } = await nativeImport('@deepseek-ai/dsh-tools');
  let mutations = 0;
  a.ctx.tools.register(defineTool({
    name: 'fixture_mutate', description: 'Fixture business mutation.', parameters: {},
    output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'mutated' }] },
    async execute() { mutations += 1; return { mutated: true }; },
  }));
  const questions = [];
  ctx.userQuestions.registerProvider({ async ask(request) {
    const selected = questions.length === 0 ? 'Keep planning' : 'Approve';
    questions.push({ request, mutationsAtReview: mutations, planAtReview: ctx.planMode.get(a), selected });
    return { answers: request.questions.map(question => ({ id: question.id, selected: [selected] })) };
  } });
  const { LlmAdapter, createUserMessage } = await nativeImport('@deepseek-ai/dsh-llm');
  const requests = [];
  class CombinedAdapter extends LlmAdapter {
    async *stream(request) {
      requests.push(request);
      const step = requests.length;
      const block = step === 1 ? { type: 'tool-call', name: 'get_goal', id: 'combined-read', arguments: '{}' }
        : step === 2 ? { type: 'tool-call', name: 'create_goal', id: 'combined-create', arguments: JSON.stringify({ objective: 'Implement and verify the requested combined-mode fixture' }) }
        : step === 3 ? { type: 'tool-call', name: 'exit_plan_mode', id: 'combined-review', arguments: JSON.stringify({ plan: '# Combined fixture\nImplement and verify the fixture after approval.' }) }
        : step === 4 ? { type: 'tool-call', name: 'exit_plan_mode', id: 'combined-review-retry', arguments: JSON.stringify({ plan: '# Combined fixture revised\nImplement and verify the fixture after approval.' }) }
        : step === 5 ? { type: 'tool-call', name: 'fixture_mutate', id: 'combined-mutate', arguments: '{}' }
        : { type: 'text', text: 'Combined-mode fixture completed.' };
      yield { type: 'block-start', index: 0, blockType: block.type };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['combined-fixture'], new CombinedAdapter());
  a.options.provider = 'combined-fixture'; a.options.model = 'combined-mode';
  await execute(ctx, a, '/coldx-goal on');
  ctx.planMode.set(a, true);
  a.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Implement and verify the combined-mode fixture.' }] }));
  await a.whenIdle();
  assert.deepEqual(a.session.events.filter(event => event.type === 'tool/call').map(event => event.data.name), ['get_goal', 'create_goal', 'exit_plan_mode', 'exit_plan_mode', 'fixture_mutate']);
  assert.equal(questions.length, 2);
  assert.equal(questions[0].request.questions[0].id, 'plan-review');
  assert.equal(questions[0].mutationsAtReview, 0);
  assert.deepEqual(questions.map(question => question.planAtReview), [{ active: true }, { active: true }], 'rejection must remain in native Plan mode until a later approval');
  assert.deepEqual(questions.map(question => question.selected), ['Keep planning', 'Approve']);
  const firstReview = a.session.events.find(event => event.type === 'tool/result' && event.data.message.source.callId === 'combined-review');
  assert.equal(firstReview.data.message.content.find(block => block.type === 'tool-result').isError, true);
  assert.equal(mutations, 1);
  assert.deepEqual(ctx.sessionProjections.snapshot(a.session).values.plan, { active: false, pending: false });
  assert.equal(ctx.goals.get(a).objective, 'Implement and verify the requested combined-mode fixture');
  const system = requests[0].system;
  assert.equal(typeof system, 'string');
  const planPolicyAt = system.indexOf('These plan-mode rules override');
  const exceptionAt = system.indexOf('one narrow built-in exception');
  assert.ok(planPolicyAt >= 0 && exceptionAt > planPolicyAt, 'Goal bookkeeping exception must be a later system section than native Plan policy');
  assert.match(system, /No filesystem, code, configuration, business, or other mutation/);
  assert.doesNotMatch(JSON.stringify(requests[0].messages), /one narrow built-in exception/, 'Goal policy must not be serialized as a user-role runtime snapshot');
});

test('a selected Goal respects existing active, disarmed, paused, blocked, and complete native phases', { timeout: 30_000 }, async t => {
  for (const scenario of [
    { name: 'active', prepare: (_ctx, _agent, goal) => goal, expectedCall: undefined, expectedPhase: 'active', sameIdentity: true },
    { name: 'active-disarmed', prepare: (ctx, agent) => ctx.goals.disarm(agent), expectedCall: 'update_goal', expectedPhase: 'active', sameIdentity: true },
    { name: 'paused', prepare: (ctx, agent, goal) => ctx.goals.pause(agent, { id: goal.id, revision: goal.revision }), expectedCall: 'update_goal', expectedPhase: 'active', sameIdentity: true },
    { name: 'blocked', prepare: (ctx, agent, goal) => ctx.goals.block(agent, { id: goal.id, revision: goal.revision }, { code: 'fixture', message: 'Waiting for a fixture dependency' }), expectedCall: 'update_goal', expectedPhase: 'active', sameIdentity: true },
    { name: 'complete', prepare: (ctx, agent, goal) => ctx.goals.complete(agent, { id: goal.id, revision: goal.revision }), expectedCall: 'create_goal', expectedPhase: 'active', sameIdentity: false },
  ]) await t.test(scenario.name, async child => {
    const { ctx, a } = await fixture(child);
    const toolGoal = await nativeImport('@deepseek-ai/dsh-tool-goal');
    await a.ctx.plugin(toolGoal.default ?? toolGoal, {});
    await execute(ctx, a, '/coldx-goal on');
    const original = ctx.goals.create(a, { objective: `Finish the ${scenario.name} fixture` });
    const prepared = scenario.prepare(ctx, a, original);
    const current = ctx.goals.get(a);
    assert.equal(prepared.id, current.id);
    const { LlmAdapter, createUserMessage } = await nativeImport('@deepseek-ai/dsh-llm');
    const requests = [];
    class ExistingGoalAdapter extends LlmAdapter {
      async *stream(request) {
        requests.push(request);
        const step = requests.length;
        const block = step === 1 ? { type: 'tool-call', name: 'get_goal', id: `${scenario.name}-read`, arguments: '{}' }
          : step === 2 && scenario.expectedCall === 'update_goal'
            ? { type: 'tool-call', name: 'update_goal', id: `${scenario.name}-resume`, arguments: JSON.stringify({ goal_id: current.id, revision: current.revision, action: 'resume' }) }
            : step === 2 && scenario.expectedCall === 'create_goal'
              ? { type: 'tool-call', name: 'create_goal', id: `${scenario.name}-create`, arguments: JSON.stringify({ objective: `Carry out the newly requested ${scenario.name} follow-up` }) }
              : { type: 'text', text: `Handled existing ${scenario.name} goal.` };
        yield { type: 'block-start', index: 0, blockType: block.type };
        yield { type: 'block-end', index: 0, block };
        yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } };
      }
    }
    ctx.llm.registerAdapter([`existing-${scenario.name}`], new ExistingGoalAdapter());
    a.options.provider = `existing-${scenario.name}`; a.options.model = scenario.name;
    a.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `Continue the ${scenario.name} fixture and preserve its goal when unfinished.` }] }));
    await a.whenIdle();
    const calls = a.session.events.filter(event => event.type === 'tool/call').map(event => event.data.name);
    assert.deepEqual(calls, scenario.expectedCall ? ['get_goal', scenario.expectedCall] : ['get_goal']);
    const final = ctx.goals.get(a);
    assert.equal(final.phase, scenario.expectedPhase);
    assert.equal(final.id === original.id, scenario.sameIdentity);
    if (scenario.sameIdentity) assert.equal(final.objective, original.objective);
    else assert.match(final.objective, /newly requested complete follow-up/);
  });
});
