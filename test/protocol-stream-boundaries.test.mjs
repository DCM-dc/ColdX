import test from 'node:test';
import assert from 'node:assert/strict';
import { repairProtocolStream } from '../plugin/protocol-guard.mjs';

const call = '<|DSML|tool_calls>\n<|DSML|invoke name="probe">\n<|DSML|parameter name="value">7</|DSML|parameter>\n</|DSML|invoke>\n</|DSML|tool_calls>';
const done = '<|DS2_AGENT_DONE|>';

async function collect(value, parts, finalText = value) {
  async function* source() {
    yield { type: 'block-start', index: 3, blockType: 'text' };
    for (const part of parts) yield { type: 'text-delta', index: 3, text: part };
    yield { type: 'block-end', index: 3, block: { type: 'text', text: finalText } };
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } };
    yield { type: 'finish', reason: { kind: 'stop' }, replayState: { stale: true } };
  }
  const chunks = [];
  for await (const chunk of repairProtocolStream(source(), { tools: new Set(['probe']) })) chunks.push(chunk);
  return chunks;
}

test('every delimiter split leaves a fenced call literal and a real call executable', async () => {
  const literal = `Example\n~~~text\n${call}\n~~~\n`;
  const value = `${literal}Proceed\n${call}`;
  for (let split = 1; split <= call.length; split++) {
    const at = literal.length + 'Proceed\n'.length + split;
    const chunks = await collect(value, [value.slice(0, at), value.slice(at)]);
    assert.equal(chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'text')?.block.text, `${literal}Proceed`);
    assert.equal(chunks.filter(chunk => chunk.type === 'tool-call-delta').length, 1);
    assert.equal(chunks.at(-1)?.reason.kind, 'tool-calls');
  }
});

test('long multiline fence never executes a split call and quoted markers stay visible', async () => {
  const value = `~~~\n${'line\n'.repeat(500)}${call}\n${done}\n~~~\n> ${done}`;
  const chunks = await collect(value, [...value]);
  assert.equal(chunks.find(chunk => chunk.type === 'block-end')?.block.text, value);
  assert.equal(chunks.some(chunk => chunk.type === 'tool-call-delta'), false);
  assert.deepEqual(chunks.at(-1)?.reason, { kind: 'stop' });
});

test('final authoritative replacement supersedes a streamed control candidate', async () => {
  const chunks = await collect(`Draft\n${call}`, ['Draft\n', call], `Final answer.\n${done}`);
  assert.equal(chunks.find(chunk => chunk.type === 'block-end')?.block.text, 'Final answer.');
  assert.equal(chunks.some(chunk => chunk.type === 'tool-call-delta'), false);
  assert.equal(Object.hasOwn(chunks.at(-1), 'replayState'), false);
});
