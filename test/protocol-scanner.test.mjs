import test from 'node:test';
import assert from 'node:assert/strict';
import { IncrementalProtocolScanner } from '../lib/kernel/protocol-scanner.mjs';

const open = '<|DSML|tool_calls>';
const done = '<|DS2_AGENT_DONE|>';

test('a control opening split at every boundary is found only outside a fence', () => {
  for (let split = 1; split < open.length; split++) {
    const scanner = new IncrementalProtocolScanner();
    scanner.feed(`Before\n${open.slice(0, split)}`);
    assert.equal(scanner.marker, -1);
    scanner.feed(open.slice(split));
    scanner.finish();
    assert.equal(scanner.marker, 7);
  }
  const fenced = new IncrementalProtocolScanner();
  for (const char of `Example\n\`\`\`text\n${open}\n\`\`\`\n${open}`) fenced.feed(char);
  fenced.finish();
  assert.equal(fenced.marker, `Example\n\`\`\`text\n${open}\n\`\`\`\n`.length);
});

test('long fenced examples and quoted terminators stay literal across one-character feeds', () => {
  const value = `~~~~typescript\n${'x'.repeat(8192)}\n${open}\n${done}\n~~~~\n> ${done}\n    ${done}\nVisible ${done}`;
  const scanner = new IncrementalProtocolScanner();
  for (const char of value) scanner.feed(char);
  scanner.finish();
  assert.equal(scanner.marker, -1);
  assert.equal(scanner.agentDoneCandidate, value.lastIndexOf(done));
  assert.deepEqual(scanner.lastAgentDone, { index: value.lastIndexOf(done), literal: false });
});

test('fullwidth and doubled-pipe openings share the same line boundary rule', () => {
  for (const marker of ['<｜DSML｜tool_calls>', '<||DSML||tool_calls>']) {
    const scanner = new IncrementalProtocolScanner();
    scanner.feed(`inline ${marker}\n   ${marker}`);
    scanner.finish();
    assert.equal(scanner.marker, `inline ${marker}\n   `.length);
  }
});

test('a fence delimiter already changes done-marker meaning on its own line', () => {
  const value = `\`\`\`example\nbody\n\`\`\`${done}`;
  const scanner = new IncrementalProtocolScanner();
  for (const char of value) scanner.feed(char);
  scanner.finish();
  assert.deepEqual(scanner.lastAgentDone, { index: value.indexOf(done), literal: false });
});
