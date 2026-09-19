import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { OPERATING_POLICY } from './policy.mjs';
import { superpowersPrompt } from './superpowers-adapter.mjs';
import * as pageHost from './page-host.mjs';
import * as interactionHost from './interaction-host.mjs';
import * as codingModeHost from './coding-mode-host.mjs';
import * as protocolGuard from './protocol-guard.mjs';
import * as artifactHost from './artifact-host.mjs';
import * as kernelAgent from './kernel-agent.mjs';

// Use the same native tool implementation as the pinned DSH installation.
const localRequire = createRequire(import.meta.url);
const dshRequire = createRequire(realpathSync(localRequire.resolve('@deepseek-ai/dsh/package.json')));
const { defineTool } = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-tools')).href);

export const name = 'coldx-policy';
export const inject = ['systemPrompt', 'tools'];

/** Native DSH contributions. Cordis owns their scope, registration and disposal. */
export function apply(ctx) {
  ctx.plugin(kernelAgent);
  ctx.plugin(pageHost);
  ctx.plugin(interactionHost);
  ctx.plugin(codingModeHost);
  ctx.plugin(protocolGuard);
  ctx.plugin(artifactHost);
  ctx.tools.register(defineTool({
    name: 'coldx_session_context',
    description: 'Read the exact complete Session ID of this tool invocation. Call this before binding a generated interface or tool to its owning Session; preserve the returned ID unchanged, including every prefix. Returns only sessionId and performs no mutation.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { sessionId: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, execution) {
      const sessionId = execution.agent?.id;
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error('coldx_session_context requires an Agent-backed session');
      }
      return { sessionId };
    },
  }));
  ctx.systemPrompt.section({
    name: 'coldx:operating-policy',
    order: 40,
    text: context => OPERATING_POLICY + superpowersPrompt(context),
  });
}
