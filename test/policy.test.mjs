import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeRuntime, nativeImport } from './native-helpers.mjs';
import { PERSONA, OPERATING_POLICY } from '../plugin/policy.mjs';

test('stable ColdX prompt is compact and contains no per-run values', () => {
  const stablePrefix = `${PERSONA}\n${OPERATING_POLICY}`;
  const words = stablePrefix.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) ?? [];
  assert.ok(stablePrefix.length < 5_880, `stable prompt must stay below 5,880 characters; received ${stablePrefix.length}`);
  assert.ok(words.length < 1_000, `stable prompt must stay below 1,000 English words; received ${words.length}`);
  for (const volatile of ['{{model}}', '{{cwd}}', 'decision-studio.mjs', 'C:\\', '/Users/', '/home/']) {
    assert.doesNotMatch(stablePrefix, new RegExp(volatile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
});

test('policy drives practical autonomy through evidence rather than extra questions', () => {
  assert.match(OPERATING_POLICY, /inspect[^.]+choose[^.]+execute[^.]+inspect the result[^.]+repair[^.]+verify/i);
  assert.match(OPERATING_POLICY, /ask only when[^.]+user alone/i);
  assert.match(OPERATING_POLICY, /continue[^.]+without asking/i);
  assert.match(OPERATING_POLICY, /never invent[^.]+tool result[^.]+status[^.]+source/i);
  assert.match(OPERATING_POLICY, /native assistant stop[^.]+valid completion boundary/i);
  assert.match(OPERATING_POLICY, /coldx_finish[^.]+optional/i);
  assert.match(OPERATING_POLICY, /materially improves[^.]+result/i);
  assert.match(OPERATING_POLICY, /three or more options[^.]+multiple dimensions[^.]+strong candidates[^.]+even without an explicit page request/i);
  assert.match(OPERATING_POLICY, /task value[^.]+quota/i);
  assert.match(OPERATING_POLICY, /never[^.]+page[^.]+merely[^.]+completion/i);
  assert.doesNotMatch(OPERATING_POLICY, /default to a generated (?:interface|page)/i);
  assert.doesNotMatch(OPERATING_POLICY, /must first have a fresh successful coldx_present_page/i);
});

test('policy gives generated interfaces creative direction and a real continuation contract', () => {
  for (const criterion of ['audience', 'domain', 'density', 'primary action', 'visual thesis']) {
    assert.match(OPERATING_POLICY, new RegExp(criterion, 'i'));
  }
  assert.match(OPERATING_POLICY, /empty[^.]+pending[^.]+success[^.]+failure[^.]+disabled/i);
  assert.match(OPERATING_POLICY, /semantic controls[^.]+accessible names/i);
  assert.match(OPERATING_POLICY, /verify one real interaction/i);
  assert.match(OPERATING_POLICY, /simple[^.]+answer[^.]+direct/i);
  assert.match(OPERATING_POLICY, /same Session/i);
});

test('policy delegates only bounded independent work and integrates evidence', () => {
  assert.match(OPERATING_POLICY, /Delegate[^.]+independent or parallel/i);
  assert.match(OPERATING_POLICY, /clear deliverable/i);
  assert.match(OPERATING_POLICY, /sequential or tightly coupled[^.]+directly/i);
  assert.match(OPERATING_POLICY, /integrate[^.]+verify/i);
});

test('policy keeps Goal selection authoritative and research bounded', () => {
  assert.match(OPERATING_POLICY, /session-scoped Goal and Plan instructions[^.]+only when selected/i);
  assert.match(OPERATING_POLICY, /do not synthesize either mode/i);
  assert.match(OPERATING_POLICY, /research[^.]+bounded evidence goal[^.]+authoritative primary sources/i);
});

test('policy spends context deliberately without durable volatile state', () => {
  const section = OPERATING_POLICY.match(/^## Spend context deliberately\n([\s\S]*?)(?=\n## |$)/m)?.[1];
  assert.ok(section, 'OPERATING_POLICY must contain the Spend context deliberately section');
  const words = section.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) ?? [];
  assert.ok(words.length < 140, `policy section must stay below 140 English words; received ${words.length}`);
  assert.match(section, /reuse existing artifacts and prior tool results by reference/i);
  assert.match(section, /summarize long tool output once/i);
  assert.match(section, /avoid sending the same large content back/i);
  assert.match(section, /temporary findings and volatile state out of durable instructions/i);
  assert.match(section, /targeted paths or symbols before broad listings/i);
  assert.match(section, /compact only when measured context pressure warrants it/i);
  for (const required of ['goals', 'constraints', 'decisions', 'side effects', 'pending work', 'artifact references', 'verification evidence']) {
    assert.match(section, new RegExp(required, 'i'));
  }
  for (const volatile of ['timestamp', 'session id', 'provider/model state', 'workspace state', 'cache counters', 'current git data']) {
    assert.doesNotMatch(section, new RegExp(volatile, 'i'));
  }
});

test('policy applies the DeepSeek research as task, evidence, tool, and attachment behavior', () => {
  assert.match(OPERATING_POLICY, /form a compact task contract[^.]+outcome[^.]+constraints[^.]+proof[^.]+only when useful/i);
  assert.match(OPERATING_POLICY, /choose only the tools relevant to the current stage/i);
  assert.match(OPERATING_POLICY, /different strategies fail[^.]+higher reasoning effort/i);
  assert.match(OPERATING_POLICY, /images[^.]+native evidence blocks/i);
  assert.match(OPERATING_POLICY, /@[^.]+read[^.]+before claiming[^.]+contents/i);
  assert.match(OPERATING_POLICY, /keep file references[^.]+instead of echoing their full contents/i);
  assert.match(OPERATING_POLICY, /generated interface[^.]+when browser tools exist[^.]+real interaction or rendered state[^.]+repair[^.]+otherwise[^.]+state the limit/i);
});

test('stable policy defers mode details to the selected session-scoped instruction', () => {
  assert.match(OPERATING_POLICY, /Coding mode selection is authoritative/i);
  assert.doesNotMatch(OPERATING_POLICY, /get_goal|create_goal/i);
});

test('ColdX policy composes with native prompts and disposes without removing native tools', async t => {
  const ctx = await nativeRuntime();
  t.after(() => ctx.fiber.dispose());
  const coldx = await import('../plugin/host.mjs');
  const { renderPrompt } = await nativeImport('@deepseek-ai/dsh-system-prompt');
  const before = await ctx.systemPrompt.assemble();
  const fiber = await ctx.plugin(coldx);
  const withColdX = await ctx.systemPrompt.assemble();
  assert.ok(withColdX.sections.some(section => section.name === 'coldx:operating-policy'));
  for (const section of before.sections) assert.ok(withColdX.sections.some(value => value.name === section.name));
  const rendered = renderPrompt(withColdX);
  assert.match(rendered, /ColdX/);
  assert.doesNotMatch(rendered, /decision-studio|[A-Z]:\\|\/Users\/|\/home\//i);
  assert.ok(ctx.tools.get('cordis_define'));
  await fiber.dispose();
  assert.deepEqual((await ctx.systemPrompt.assemble()).sections.map(s => s.name), before.sections.map(s => s.name));
  assert.ok(ctx.tools.get('cordis_define'));
});

test('native session context returns the full caller ID only inside its scope and is removed on disposal', async t => {
  const ctx = await nativeRuntime();
  t.after(() => ctx.fiber.dispose());
  const { createScope } = await nativeImport('@deepseek-ai/dsh-scope');
  const coldx = await import('../plugin/host.mjs');
  const owner = { id: 'session-9dd2169b-a5f0-4a19-8a60-4c90829a6e7a' };
  const other = { id: 'session-other-caller' };
  const scope = createScope(ctx, owner);
  owner.ctx = scope.ctx;
  other.ctx = createScope(ctx, other).ctx;
  const fiber = await scope.ctx.plugin(coldx);
  assert.ok(ctx.tools.get('coldx_session_context', owner), 'ColdX must register the native context tool');
  assert.equal(ctx.tools.get('coldx_session_context', other), undefined);
  const invoke = agent => ctx.tools.execute({
    callId: `context-${agent.id}`, name: 'coldx_session_context', arguments: {},
    agent, signal: new AbortController().signal,
  });
  const result = await invoke(owner);
  assert.equal(result.isError, false);
  assert.deepEqual(result.value, { sessionId: owner.id });
  assert.deepEqual(JSON.parse(result.content[0].text), { sessionId: owner.id });
  assert.equal((await invoke(other)).isError, true);
  await fiber.dispose();
  assert.equal(ctx.tools.get('coldx_session_context', owner), undefined);
  assert.equal((await invoke(owner)).isError, true);
  assert.ok(ctx.tools.get('cordis_define', owner));
});

test('ColdX mounts scoped interaction tools without the sample experience', async t => {
  const ctx = await nativeRuntime(); t.after(() => ctx.fiber.dispose());
  for (const name of ['dsh-typert-registry', 'dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop', 'dsh-user-questions', 'dsh-session-projection']) {
    const mod = await nativeImport(`@deepseek-ai/${name}`); await ctx.plugin(mod.default ?? mod, {});
  }
  ctx.provide('workspaceRegistry', { async create(cwd) { return { id: 'workspace-fixture', cwd }; } });
  const clientHost = await ctx.plugin(await import('../plugin/client/client-host.mjs'));
  assert.equal(ctx.tools.get('coldx_lab_create'), undefined);
  const { agent: a } = await ctx.agents.create({ sessionId: 'session-policy-a' });
  const { agent: b } = await ctx.agents.create({ sessionId: 'session-policy-b' });
  const coldx = await import('../plugin/host.mjs');
  const first = await a.ctx.plugin(coldx);
  assert.ok(ctx.tools.get('coldx_interact', a), 'the ColdX preset must include the explicit interaction tool');
  assert.ok(ctx.tools.get('coldx_finish', a));
  assert.equal(ctx.tools.get('coldx_interact', b), undefined);
  const second = await b.ctx.plugin(coldx);
  assert.equal(ctx.tools.get('coldx_lab_create'), undefined);
  const completion = await ctx.tools.execute({ name: 'coldx_finish', callId: 'policy-finish', arguments: { summary: '完成验证。' }, agent: a, signal: new AbortController().signal });
  assert.equal(completion.isError, false);
  assert.equal(completion.value.status, 'completed');
  assert.equal(completion.concludesTurn, true);
  assert.equal(completion.additionalContexts, undefined);
  const { renderPrompt } = await nativeImport('@deepseek-ai/dsh-system-prompt');
  const prompt = renderPrompt(await ctx.systemPrompt.assemble({ scope: a, agent: a, signal: new AbortController().signal }));
  assert.match(prompt, /coldx_interact/); assert.match(prompt, /coldx_finish/);
  assert.match(prompt, /plan[- ]review/);
  await first.dispose();
  assert.equal(ctx.tools.get('coldx_interact', a), undefined);
  assert.ok(ctx.tools.get('coldx_interact', b));
  assert.equal(ctx.tools.get('coldx_lab_create', b), undefined);
  assert.ok(ctx.tools.get('cordis_define', b));
  await second.dispose(); await clientHost.dispose();
  assert.equal(ctx.tools.get('coldx_lab_create', b), undefined);
  assert.ok(ctx.tools.get('cordis_define', b));
});
