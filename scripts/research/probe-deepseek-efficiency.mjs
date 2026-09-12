/**
 * Offline research probe. Runs a synthetic adapter inside the pinned native DSH
 * runtime; it does not load a profile, provider settings, user files or conversations.
 * No HTTP server, network transport, real model or model API is used.
 *
 * From the repository root: node scripts/research/probe-deepseek-efficiency.mjs
 * Stdout is one sanitized JSON observation. This is not a quality benchmark or
 * a regression assertion that the observed behavior should remain unchanged.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeImport, nativeRuntime } from '../../test/native-helpers.mjs';
import { PERSONA, OPERATING_POLICY } from '../../plugin/policy.mjs';
import { createSessionControls } from '../../plugin/client/session-controls-source.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const dshPackage = realpathSync(new URL('../../node_modules/@deepseek-ai/dsh/package.json', import.meta.url));
const dshRequire = createRequire(dshPackage);
const jsonFile = path => JSON.parse(readFileSync(path, 'utf8'));
const appVersion = jsonFile(join(projectRoot, 'package.json')).version;

function sourceReference(path, component, version, anchors) {
  const source = readFileSync(path, 'utf8');
  const lines = source.split(/\r?\n/);
  return {
    component,
    version,
    sha256: createHash('sha256').update(source).digest('hex'),
    lines: Object.fromEntries(Object.entries(anchors).map(([label, fragment]) => {
      const index = lines.findIndex(line => line.includes(fragment));
      return [label, index < 0 ? null : index + 1];
    })),
  };
}

function nativeReference(packageName, anchors) {
  const entry = dshRequire.resolve(packageName);
  let root = dirname(entry);
  while (true) {
    try {
      const manifest = jsonFile(join(root, 'package.json'));
      if (manifest.name === packageName) return {
        ...sourceReference(entry, packageName, manifest.version, anchors),
        path: `${packageName}/${relative(root, entry).replaceAll('\\', '/')}`,
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(root);
    if (parent === root) throw new Error(`Package metadata unavailable for ${packageName}`);
    root = parent;
  }
}

function productReference(path, anchors) {
  return { ...sourceReference(join(projectRoot, path), 'coldx-web', appVersion, anchors), path };
}

async function observe() {
  const ctx = await nativeRuntime();
  try {
    for (const name of ['dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop', 'dsh-llm-retry', 'dsh-user-questions', 'dsh-session-projection', 'dsh-token-meter']) {
      const plugin = await nativeImport(`@deepseek-ai/${name}`);
      await ctx.plugin(plugin.default ?? plugin, {});
    }
    const { LlmAdapter, createUserMessage } = await nativeImport('@deepseek-ai/dsh-llm');
    const reportedUsage = { inputTokens: 120, outputTokens: 10, reasoningTokens: 10 };
    let syntheticAdapterInvocations = 0;
    class SyntheticAdapter extends LlmAdapter {
      async *stream() {
        syntheticAdapterInvocations += 1;
        yield { type: 'block-start', index: 0, blockType: 'reasoning' };
        yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Synthetic reasoning-only fixture.' } };
        yield { type: 'usage', usage: { ...reportedUsage } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    // The provider alias exercises ColdX's guard. Its only registered adapter is
    // the in-memory class above; no DeepSeek transport is mounted or configured.
    ctx.llm.registerAdapter(['deepseek-official'], new SyntheticAdapter());
    const { agent } = await ctx.agents.create({
      sessionId: 'synthetic-coldx-efficiency-probe',
      agentOptions: { provider: 'deepseek-official', model: 'synthetic-fixture' },
    });
    await agent.ctx.plugin(await import('../../plugin/host.mjs'));
    const assembly = await ctx.systemPrompt.assemble({ scope: agent, agent, signal: new AbortController().signal });
    const tools = assembly.tools.filter(tool => tool.name.startsWith('coldx_'));
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Complete the synthetic fixture.' }] }));
    let timer;
    try {
      await Promise.race([agent.whenIdle(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Synthetic fixture did not settle within 5 seconds')), 5000);
      })]);
    } finally { clearTimeout(timer); }
    const events = agent.session.events;
    const views = ctx.sessionProjections.snapshot(agent.session).values;
    const messages = events.filter(event => event.type === 'assistant/message').map(event => event.data.message);
    const cache = createSessionControls({ createElement() {} }, {}).cacheStats(views.tokenUsage).cache;
    const stablePrompt = `${PERSONA}\n${OPERATING_POLICY}`;
    return {
      reasoningOnlyCompletion: {
        syntheticAdapterInvocations,
        assistantMessages: messages.length,
        reasoningBlocks: messages.flatMap(message => message.content).filter(block => block.type === 'reasoning').length,
        nonemptyVisibleTextBlocks: messages.flatMap(message => message.content).filter(block => block.type === 'text' && block.text.trim()).length,
        turnEndKind: events.findLast(event => event.type === 'turn/end')?.data.reason?.kind ?? null,
        coldxFlowPhase: views['coldx.flow']?.phase ?? null,
      },
      missingCacheUsage: {
        reportedUsage,
        reportedCacheReadFieldPresent: Object.hasOwn(reportedUsage, 'cacheReadTokens'),
        reportedCacheWriteFieldPresent: Object.hasOwn(reportedUsage, 'cacheWriteTokens'),
        projectedUsage: views.tokenUsage ?? null,
        cacheBadge: { known: cache.known, label: cache.label, ratio: cache.ratio },
      },
      staticMetrics: {
        unit: 'JavaScript UTF-16 code units; English words are regex matches, not model tokens',
        personaCharacters: PERSONA.length,
        operatingPolicyCharacters: OPERATING_POLICY.length,
        stablePromptWithSeparatorCharacters: stablePrompt.length,
        englishWordMatches: (stablePrompt.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) ?? []).length,
        toolsScope: 'Only ColdX preset tools in isolated native assembly; excludes the complete native preset, host browser, marketplace and user plugins',
        toolDefinitions: tools.length,
        toolDefinitionsJsonCharacters: JSON.stringify(tools).length,
        tools: tools.map(tool => ({ name: tool.name, definitionJsonCharacters: JSON.stringify(tool).length, descriptionCharacters: tool.description.length })),
      },
    };
  } finally { await ctx.fiber.dispose(); }
}

const result = {
  schemaVersion: 1,
  probe: 'coldx-deepseek-efficiency-offline',
  scope: 'Synthetic in-memory native runtime; no profile, private history, credentials, HTTP transport or actual model calls',
  limitation: 'Character metrics are not token counts. Observations are not statistical model quality or savings evidence.',
  versions: { coldxWeb: appVersion, dsh: jsonFile(dshPackage).version, node: process.version },
  observations: await observe(),
  sourceReferences: [
    nativeReference('@deepseek-ai/dsh-agent-loop', { assistantMessage: 'const message = createAssistantMessage({', noToolCompletion: 'if (toolCalls.length === 0) return { kind: "completed" };' }),
    nativeReference('@deepseek-ai/dsh-token-meter', { missingCacheReadDefaultsToZero: 'cacheReadTokens: usage.cacheReadTokens ?? 0', projectionFields: 'const projectionSchema = ' }),
    nativeReference('@deepseek-ai/dsh-llm-deepseek', { mapUsage: 'function mapUsage(usage)', optionalCacheRead: '...cacheRead !== void 0 ? { cacheReadTokens: cacheRead }' }),
    productReference('plugin/protocol-guard.mjs', { reasoningPassThrough: "if (chunk.type === 'reasoning-delta')", scopedGuard: "if (options.provider !== 'deepseek-official'" }),
    productReference('plugin/client/session-controls-source.mjs', { cacheStats: 'function cacheStats(', knownInputCounts: 'const hasCounts = ', cacheKnown: 'const cacheKnown = ' }),
    productReference('plugin/policy.mjs', { persona: 'export const PERSONA = ', operatingPolicy: 'export const OPERATING_POLICY = ' }),
    productReference('plugin/page-host.mjs', { pageTool: 'name: PAGE_TOOL,' }),
    productReference('plugin/interaction-host.mjs', { interactionTool: 'name: INTERACT_TOOL,', finishTool: 'name: FINISH_TOOL,' }),
    productReference('plugin/artifact-host.mjs', { artifactTool: "name: 'coldx_register_artifact'," }),
    productReference('plugin/host.mjs', { contextTool: "name: 'coldx_session_context'," }),
  ],
};
console.log(JSON.stringify(result));
