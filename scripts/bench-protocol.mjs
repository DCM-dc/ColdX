import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { repairProtocolStream as current } from '../plugin/protocol-guard.mjs';

const args = new Map(process.argv.slice(2).map(argument => {
  const [name, ...value] = argument.replace(/^--/, '').split('=');
  return [name, value.join('=')];
}));
let baselinePath = args.get('baseline');
let baselineRef;
if (!baselinePath) {
  baselineRef = args.get('baseline-ref') ?? 'v0.1.4';
  if (!/^[a-zA-Z0-9._/]{1,100}$/.test(baselineRef)) throw new Error('Invalid baseline ref');
  const source = execFileSync('git', ['show', `${baselineRef}:plugin/protocol-guard.mjs`], {encoding:'utf8'});
  await mkdir('.runtime', {recursive:true});
  const directory = await mkdtemp(resolve('.runtime/bench-protocol-'));
  baselinePath = resolve(directory,'protocol-guard.mjs');
  await writeFile(baselinePath, source);
  await writeFile(resolve(directory,'page-native.mjs'), "export * from '../../plugin/page-native.mjs';\n");
}
baselinePath=resolve(baselinePath);
const { repairProtocolStream: baseline } = await import(pathToFileURL(baselinePath).href);
const iterations = Number(args.get('iterations') ?? 3);
const chunkSize = Number(args.get('chunk-size') ?? 256);
if (!Number.isSafeInteger(iterations) || iterations < 1 || !Number.isSafeInteger(chunkSize) || chunkSize < 1) {
  throw new Error('iterations and chunk-size must be positive integers');
}

const opening = '<|DSML|tool_calls>';
const call = `${opening}\n<|DSML|invoke name="probe"><|DSML|parameter name="x">7</|DSML|parameter></|DSML|invoke>\n</|DSML|tool_calls>`;
const sizes = [16 * 1024, 128 * 1024, 1024 * 1024];
const median = numbers => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)];
const canonical = chunks => JSON.stringify(chunks).replace(/coldx-dsml-[\da-f-]{36}/g, 'coldx-dsml-UUID');

async function measure(repair, value) {
  async function* stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    for (let index = 0; index < value.length; index += chunkSize) {
      yield { type: 'text-delta', index: 0, text: value.slice(index, index + chunkSize) };
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: value } };
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } };
    yield { type: 'finish', reason: { kind: 'stop' }, replayState: { blocks: [{}] } };
  }
  const start = performance.now();
  const chunks = [];
  for await (const chunk of repair(stream(), { tools: new Set(['probe']) })) chunks.push(chunk);
  return { elapsed: performance.now() - start, output: canonical(chunks) };
}

console.log(`baseline=${baselinePath} iterations=${iterations} chunkSize=${chunkSize}`);
const results=[];
for (const size of sizes) {
  const prefix = `Example only\n~~~text\n${opening}\n~~~\n`;
  const filler = 'ordinary prose and data\n';
  const value = prefix + filler.repeat(Math.ceil((size - prefix.length - call.length - 1) / filler.length))
    .slice(0, Math.max(0, size - prefix.length - call.length - 1)) + `\n${call}`;
  const previous = [], now = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const a = await measure(baseline, value);
    const b = await measure(current, value);
    if (a.output !== b.output) {
      console.error(`Mismatch at size=${size}, iteration=${iteration + 1}`);
      process.exitCode = 1;
      break;
    }
    previous.push(a.elapsed);
    now.push(b.elapsed);
  }
  if (process.exitCode) break;
  results.push({bytes:size,deltas:Math.ceil(value.length/chunkSize),outputEquivalent:true,baselineMedianMs:median(previous),currentMedianMs:median(now)});
  console.log(`${size} bytes; deltas=${Math.ceil(value.length / chunkSize)}; equal=true; baselineMedian=${median(previous).toFixed(2)}ms; currentMedian=${median(now).toFixed(2)}ms`);
}
if (!process.exitCode) {
  await mkdir('.runtime',{recursive:true});
  await writeFile('.runtime/bench-protocol.json',JSON.stringify({kind:'protocol-parser-cpu',baselineRef,iterations,chunkSize,results,
    scope:'Synthetic ASCII protocol parsing only; UUID-normalized output equality; no model, network, whole-agent or token-saving claim.'},null,2)+'\n');
}
