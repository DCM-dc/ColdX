import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeImport, nativeRuntime } from './native-helpers.mjs';

const DSML = `<|DSML|tool_calls>
<|DSML|invoke name="fixture_probe">
<|DSML|parameter name="value"><![CDATA7]]></|DSML|parameter>
<|DSML|parameter name="label"><![CDATA[真实执行</|DSML|parameter>
</|DSML|invoke>
</|DSML|tool_calls>`;

function text(value) { return { type: 'text', text: value }; }

async function fixture(t, respond, { provider = 'deepseek-official' } = {}) {
  const ctx = await nativeRuntime();
  t.after(() => ctx.fiber.dispose());
  for (const name of ['dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop', 'dsh-llm-retry']) {
    const mod = await nativeImport(`@deepseek-ai/${name}`);
    await ctx.plugin(mod.default ?? mod, {});
  }
  const { LlmAdapter, createUserMessage } = await nativeImport('@deepseek-ai/dsh-llm');
  const { defineTool } = await nativeImport('@deepseek-ai/dsh-tools');
  const requests = [];
  class FixtureAdapter extends LlmAdapter {
    async *stream(request) {
      requests.push(request);
      const block = respond(request, requests.length);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      for (const part of [block.slice(0, 19), block.slice(19, 47), block.slice(47)]) {
        if (part) yield { type: 'text-delta', index: 0, text: part };
      }
      yield { type: 'block-end', index: 0, block: text(block) };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } };
      yield { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { stopReason: 'stop' }, blocks: [{}] } };
    }
  }
  ctx.llm.registerAdapter([provider], new FixtureAdapter());
  const { agent } = await ctx.agents.create({ sessionId: 'session-protocol-fixture', agentOptions: { provider, model: 'fixture-model' } });
  const calls = [];
  agent.ctx.tools.register(defineTool({
    name: 'fixture_probe',
    description: 'Record a protocol recovery probe.',
    parameters: {
      value: { type: 'number', required: true },
      label: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { accepted: { type: 'boolean', required: true } } },
      render: (_args, result) => [text(JSON.stringify(result))],
    },
    async execute(args) { calls.push(structuredClone(args)); return { accepted: true }; },
  }));
  await agent.ctx.plugin(await import('../plugin/protocol-guard.mjs'));
  async function run() {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [text('Run the protocol recovery fixture.')] }));
    await agent.whenIdle();
  }
  return { ctx, agent, calls, requests, run };
}

test('DSML text is promoted into native tool calls that execute through the Agent Loop', { timeout: 10_000 }, async t => {
  const f = await fixture(t, (_request, attempt) => attempt === 1 ? `正在核实。\n\n${DSML}` : '已根据真实工具结果完成。');
  await f.run();

  assert.equal(f.requests.length, 2, 'the real tool result must drive a second model step');
  assert.deepEqual(f.calls, [{ value: 7, label: '真实执行' }]);
  const calls = f.agent.session.events.filter(event => event.type === 'tool/call');
  const results = f.agent.session.events.filter(event => event.type === 'tool/result');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].data.name, 'fixture_probe');
  assert.equal(results.length, 1);
  assert.equal(results[0].data.message.content.some(block => block.type === 'tool-result' && !block.isError), true);

  const assistant = f.agent.session.events.filter(event => event.type === 'assistant/message');
  assert.equal(assistant.length, 2);
  assert.equal(assistant[0].data.message.content.some(block => block.type === 'tool-call' && block.name === 'fixture_probe'), true);
  assert.equal(JSON.stringify(assistant).includes('<|DSML|'), false, 'protocol markup must never become assistant prose');
  assert.equal(assistant[0].data.message.source.replayState, undefined, 'rewritten blocks must not retain misaligned provider replay metadata');
});

test('non-DeepSeek providers pass the same DSML text through unchanged', { timeout: 10_000 }, async t => {
  const f = await fixture(t, (_request, attempt) => attempt === 1 ? DSML : 'unexpected protocol repair', { provider: 'fixture' });
  await f.run();

  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.calls, []);
  const assistant = f.agent.session.events.filter(event => event.type === 'assistant/message');
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].data.message.content.find(block => block.type === 'text')?.text, DSML);
  assert.equal(assistant[0].data.message.content.some(block => block.type === 'tool-call'), false);
});

test('parser accepts the malformed CDATA variants observed in the live provider output', async () => {
  const { parseDsmlToolCalls } = await import('../plugin/protocol-guard.mjs');
  assert.deepEqual(parseDsmlToolCalls(DSML, new Set(['fixture_probe'])), [{
    name: 'fixture_probe',
    arguments: { value: 7, label: '真实执行' },
  }]);
});

test('an exact leaked idle reminder is hidden without forcing a model retry', async () => {
  const { repairProtocolStream } = await import('../plugin/protocol-guard.mjs');
  const reminder = '<system-reminder>The user has not sent any new message. Do not perform any new work. Do not call any tools. Wait for the user\'s next instruction.</system-reminder>';
  async function* source() {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: reminder.slice(0, 42) };
    yield { type: 'text-delta', index: 0, text: reminder.slice(42) };
    yield { type: 'block-end', index: 0, block: text(reminder) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  const chunks = [];
  for await (const chunk of repairProtocolStream(source(), { tools: [] })) chunks.push(chunk);
  assert.equal(chunks.some(chunk => chunk.type === 'text-delta' || chunk.type === 'block-end'), false);
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } });
});

test('the same reminder is preserved when the human explicitly supplied it', async () => {
  const { repairProtocolStream } = await import('../plugin/protocol-guard.mjs');
  const reminder = '<system-reminder>The user has not sent any new message. Do not perform any new work. Do not call any tools. Wait for the user\'s next instruction.</system-reminder>';
  async function* source() {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: reminder };
    yield { type: 'block-end', index: 0, block: text(reminder) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  const options = { tools: [], messages: [{ role: 'user', source: { kind: 'user' }, content: [text(`请原样复述：${reminder}`)] }] };
  const chunks = [];
  for await (const chunk of repairProtocolStream(source(), options)) chunks.push(chunk);
  assert.equal(chunks.find(chunk => chunk.type === 'block-end')?.block.text, reminder);
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } });
});

test('a marker-only private agent terminator ends once without leaking or retrying', { timeout: 10_000 }, async t => {
  const f = await fixture(t, (_request, attempt) => attempt === 1 ? '<|DS2_AGENT_DONE|>' : '重试后得到正常可见回复。');
  await f.run();

  assert.equal(f.requests.length, 1, 'ColdX must not turn private output into an LLM retry');
  const assistant = f.agent.session.events.filter(event => event.type === 'assistant/message');
  assert.equal(JSON.stringify(assistant).includes('DS2_AGENT_DONE'), false);
  assert.equal(JSON.stringify(assistant).includes('重试后得到正常可见回复。'), false);
  assert.equal(f.agent.session.events.some(event => event.type === 'turn/end' && event.data.reason?.kind === 'completed'), true);
});

test('a trailing private agent terminator is stripped while visible prose completes natively', async () => {
  const { repairProtocolStream } = await import('../plugin/protocol-guard.mjs');
  const marker = '<|DS2_AGENT_DONE|>';
  const visible = '这是正常的最终正文。';
  async function collect(value, options = {}, parts = [value.slice(0, 7), value.slice(7, -3), value.slice(-3)]) {
    async function* source() {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      for (const part of parts) {
        if (part) yield { type: 'text-delta', index: 0, text: part };
      }
      yield { type: 'block-end', index: 0, block: text(value) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
    const chunks = [];
    for await (const chunk of repairProtocolStream(source(), options)) chunks.push(chunk);
    return chunks;
  }

  const undeclared = await collect(`${visible}\n\n${marker}`);
  assert.equal(undeclared.some(chunk => JSON.stringify(chunk).includes('DS2_AGENT_DONE')), false);
  assert.equal(undeclared.find(chunk => chunk.type === 'block-end')?.block.text, visible);
  assert.deepEqual(undeclared.at(-1), { type: 'finish', reason: { kind: 'stop' } });

  const inline = await collect(`${visible}${marker}`);
  assert.equal(inline.find(chunk => chunk.type === 'block-end')?.block.text, visible);
  assert.deepEqual(inline.at(-1), { type: 'finish', reason: { kind: 'stop' } });

  for (const padded of [
    `${visible}${marker}${' '.repeat(80)}`,
    `${visible}\n${marker}${'\n'.repeat(80)}`,
  ]) {
    const chunks = await collect(padded, {}, [...padded]);
    assert.equal(chunks.some(chunk => JSON.stringify(chunk).includes('DS2_AGENT_DONE')), false);
    assert.equal(chunks.find(chunk => chunk.type === 'block-end')?.block.text, visible);
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } });
  }

  for (const literal of [
    `正文中的 ${marker} 不在结尾`,
    `> ${marker}`,
    `    ${marker}`,
    `\`\`\`text\n${marker}\n\`\`\``,
  ]) {
    const chunks = await collect(literal);
    assert.equal(chunks.find(chunk => chunk.type === 'block-end')?.block.text, literal);
  }

  const requested = await collect(marker, {
    messages: [{ role: 'user', source: { kind: 'user' }, content: [text(`请原样解释 ${marker}`)] }],
  });
  assert.equal(requested.find(chunk => chunk.type === 'block-end')?.block.text, marker);

  const historicalRequest = await collect(`${visible}\n${marker}`, {
    messages: [
      { role: 'user', source: { kind: 'user' }, content: [text(`请原样解释 ${marker}`)] },
      { role: 'assistant', content: [text(marker)] },
      { role: 'user', source: { kind: 'user' }, content: [text('现在正常回答。')] },
    ],
  });
  assert.equal(historicalRequest.find(chunk => chunk.type === 'block-end')?.block.text, visible);
  assert.equal(historicalRequest.some(chunk => JSON.stringify(chunk).includes('DS2_AGENT_DONE')), false);
});

test('malformed DSML is hidden without discarding visible prose or forcing a retry', async () => {
  const { repairProtocolStream } = await import('../plugin/protocol-guard.mjs');
  async function collect(value) {
    async function* source() {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: value };
      yield { type: 'block-end', index: 0, block: text(value) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
    const chunks = [];
    for await (const chunk of repairProtocolStream(source(), { tools: [{ name: 'fixture_probe' }] })) chunks.push(chunk);
    return chunks;
  }

  const malformed = '<|DSML|tool_calls>broken';
  const withProse = await collect(`先给出可见结论。\n\n${malformed}`);
  assert.equal(withProse.find(chunk => chunk.type === 'block-end')?.block.text, '先给出可见结论。');
  assert.equal(withProse.some(chunk => JSON.stringify(chunk).includes('DSML')), false);
  assert.deepEqual(withProse.at(-1), { type: 'finish', reason: { kind: 'stop' } });

  const protocolOnly = await collect(malformed);
  assert.equal(protocolOnly.some(chunk => chunk.type === 'text-delta' || chunk.type === 'block-end'), false);
  assert.deepEqual(protocolOnly.at(-1), { type: 'finish', reason: { kind: 'stop' } });
});

test('delta-only text streams flush complete safe blocks before native stop', async () => {
  const { repairProtocolStream } = await import('../plugin/protocol-guard.mjs');
  const marker = '<|DS2_AGENT_DONE|>';
  async function collect(entries) {
    async function* source() {
      for (const [index, parts] of entries) {
        yield { type: 'block-start', index, blockType: 'text' };
        for (const part of parts) yield { type: 'text-delta', index, text: part };
      }
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
    const chunks = [];
    for await (const chunk of repairProtocolStream(source(), { tools: [{ name: 'fixture_probe' }] })) chunks.push(chunk);
    return chunks;
  }

  for (const [source, expected] of [
    ['短正文。', '短正文。'],
    ['长正文'.repeat(80), '长正文'.repeat(80)],
    [`保留正文。${marker}${'\n'.repeat(80)}`, '保留正文。'],
    [`正文中的 ${marker} 不在结尾`, `正文中的 ${marker} 不在结尾`],
    ['先保留结论。\n\n<|DSML|tool_calls>broken', '先保留结论。'],
  ]) {
    const chunks = await collect([[3, [...source]]]);
    assert.equal(chunks.find(chunk => chunk.type === 'block-end')?.block.text, expected);
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } });
    if (expected !== source) assert.equal(chunks.some(chunk => JSON.stringify(chunk).includes('DS2_AGENT_DONE')), false);
  }

  const multiple = await collect([[4, ['后块']], [1, ['前块']]]);
  assert.deepEqual(multiple.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block.text), ['后块', '前块']);
  assert.deepEqual(multiple.at(-1), { type: 'finish', reason: { kind: 'stop' } });
});

test('authoritative block-end text replaces divergent deltas before protocol cleanup', async () => {
  const { repairProtocolStream } = await import('../plugin/protocol-guard.mjs');
  const marker = '<|DS2_AGENT_DONE|>';
  async function collect(delta, finalText) {
    async function* source() {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: delta };
      yield { type: 'block-end', index: 0, block: text(finalText) };
      yield { type: 'finish', reason: { kind: 'stop' }, replayState: { blocks: ['stale'] } };
    }
    const chunks = [];
    for await (const chunk of repairProtocolStream(source(), { tools: [] })) chunks.push(chunk);
    return chunks;
  }

  const replaced = await collect(`流式草稿 ${marker} 后续`, '权威最终正文。');
  assert.equal(replaced.find(chunk => chunk.type === 'block-end')?.block.text, '权威最终正文。');
  assert.equal(replaced.some(chunk => JSON.stringify(chunk).includes('DS2_AGENT_DONE')), false);
  assert.equal(Object.hasOwn(replaced.at(-1), 'replayState'), false);

  const cleaned = await collect('流式草稿。', `权威最终正文。\n${marker}`);
  assert.equal(cleaned.find(chunk => chunk.type === 'block-end')?.block.text, '权威最终正文。');
  assert.equal(cleaned.some(chunk => JSON.stringify(chunk).includes('DS2_AGENT_DONE')), false);
  assert.equal(Object.hasOwn(cleaned.at(-1), 'replayState'), false);
});

test('an open delta-only text block stays before a later native tool block', async () => {
  const { repairProtocolStream } = await import('../plugin/protocol-guard.mjs');
  async function* source() {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: '先显示正文。' };
    yield { type: 'block-start', index: 1, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 1, id: 'native-1', name: 'fixture_probe', argumentsDelta: '{}' };
    yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'native-1', name: 'fixture_probe', arguments: '{}' } };
    yield { type: 'finish', reason: { kind: 'tool-calls' }, replayState: { blocks: ['text', 'tool'] } };
  }
  const chunks = [];
  for await (const chunk of repairProtocolStream(source(), { tools: [{ name: 'fixture_probe' }] })) chunks.push(chunk);

  assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block.type), ['text', 'tool-call']);
  assert.equal(chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'text')?.block.text, '先显示正文。');
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } });
});

test('interleaved text blocks preserve their first-start order when the later block finishes first', async () => {
  const { repairProtocolStream } = await import('../plugin/protocol-guard.mjs');
  const first = '先出现的短文本。';
  const second = '后出现的长文本。'.repeat(40);
  async function* source() {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: first };
    yield { type: 'block-start', index: 1, blockType: 'text' };
    yield { type: 'text-delta', index: 1, text: second };
    yield { type: 'block-end', index: 1, block: text(second) };
    yield { type: 'block-end', index: 0, block: text(first) };
    yield { type: 'finish', reason: { kind: 'stop' }, replayState: { blocks: ['first', 'second'] } };
  }
  const chunks = [];
  for await (const chunk of repairProtocolStream(source(), { tools: [] })) chunks.push(chunk);

  assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block.text), [first, second]);
  assert.deepEqual(chunks.at(-1).replayState, { blocks: ['first', 'second'] });
});

test('DSML followed by a private agent terminator still becomes one native tool call', async () => {
  const { repairProtocolStream } = await import('../plugin/protocol-guard.mjs');
  async function* source() {
    const value = `${DSML}\n<|DS2_AGENT_DONE|>`;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: value };
    yield { type: 'block-end', index: 0, block: text(value) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  const chunks = [];
  for await (const chunk of repairProtocolStream(source(), { tools: [{ name: 'fixture_probe' }] })) chunks.push(chunk);
  assert.equal(chunks.filter(chunk => chunk.type === 'tool-call-delta').length, 1);
  assert.equal(chunks.some(chunk => JSON.stringify(chunk).includes('DS2_AGENT_DONE')), false);
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } });
});

test('official fullwidth DSML and string flags decode without guessing string scalars', async () => {
  const { parseDsmlToolCalls } = await import('../plugin/protocol-guard.mjs');
  const official = `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="fixture_probe">\n<｜DSML｜parameter name="value" string="false">7</｜DSML｜parameter>\n<｜DSML｜parameter name="label" string="true">007</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>`;
  assert.deepEqual(parseDsmlToolCalls(official, new Set(['fixture_probe'])), [{
    name: 'fixture_probe', arguments: { value: 7, label: '007' },
  }]);
});

test('unknown tools and duplicate parameters fail closed', async () => {
  const { parseDsmlToolCalls } = await import('../plugin/protocol-guard.mjs');
  assert.equal(parseDsmlToolCalls(DSML, new Set(['another_tool'])), null);
  const duplicate = DSML.replace('</|DSML|invoke>', '<|DSML|parameter name="value">8</|DSML|parameter>\n</|DSML|invoke>');
  assert.equal(parseDsmlToolCalls(duplicate, new Set(['fixture_probe'])), null);
});

test('DSML shown inside a Markdown fence remains ordinary explanatory text', async () => {
  const { repairProtocolStream } = await import('../plugin/protocol-guard.mjs');
  const prose = `Example only:\n\n\`\`\`text\n${DSML}\n\`\`\``;
  async function* source() {
    yield { type: 'block-start', index: 4, blockType: 'text' };
    yield { type: 'text-delta', index: 4, text: prose };
    yield { type: 'block-end', index: 4, block: text(prose) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  const chunks = [];
  for await (const chunk of repairProtocolStream(source(), { tools: [{ name: 'fixture_probe' }] })) chunks.push(chunk);
  const end = chunks.find(chunk => chunk.type === 'block-end');
  assert.deepEqual(end?.block, text(prose));
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } });
  assert.equal(chunks.some(chunk => chunk.type === 'tool-call-delta'), false);
});
