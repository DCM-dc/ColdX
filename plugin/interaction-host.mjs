import { nativeImport } from './page-native.mjs';
import { normalizeInteractionInput, normalizeInteractionAnswer, normalizeCompletionInput } from './interaction-input.mjs';
import { INTERACT_TOOL, FINISH_TOOL, questionIdOf, interactionProjection } from './interaction-model.mjs';

const { defineTool } = await nativeImport('@deepseek-ai/dsh-tools');
const { scopeOf, scopeChainOf } = await nativeImport('@deepseek-ai/dsh-scope');
export const name = 'coldx-interactions';
export const inject = ['tools', 'userQuestions', 'agents'];

export function apply(ctx) {
  const owner = scopeOf(ctx);
  const active = new Set();
  let disposed = false;
  ctx.effect(() => () => {
    disposed = true;
    for (const controller of active) controller.abort('ColdX interaction plugin unloaded');
  });
  ctx.inject(['sessionProjections'], pc => pc.sessionProjections.register(interactionProjection));
  function assertOwner(exec) {
    if (disposed) throw new Error('ColdX interaction plugin unloaded');
    // rc.2 mounts a preset once under an opaque standing scope, then joins each
    // Agent to that scope. Runtime parent ownership is separate from this chain.
    if (!owner || !exec.agent || !scopeChainOf(exec.agent).includes(owner)
      || ctx.agents.get(exec.agent.id) !== exec.agent || !ctx.agents.roots().includes(exec.agent)) {
      throw new Error('ColdX interaction tools require their exact live root Agent. Delegated agents must return decisions to their parent.');
    }
    if (!exec.callId) throw new Error('A native tool call ID is required.');
    exec.signal.throwIfAborted();
  }
  const preview = { type: 'object', additionalProperties: false, properties: {
    html: { type: 'string' }, htmlBase64: { type: 'string' },
    css: { type: 'string', description: 'Use inherited --page-bg, --page-surface, --page-text, --page-muted, --page-line, --page-field, --page-accent and --page-on-accent theme tokens, without redefining them. Custom palettes need both :root[data-theme="light"] and :root[data-theme="dark"] variants; the app theme can differ from the OS.' },
    script: { type: 'string', description: 'ColdX.theme supplies the initial light/dark theme. Listen to window coldx:themechange (event.detail.theme) for chart/canvas repainting; preserve local input when the theme changes.' },
  } };
  ctx.tools.register(defineTool({
    name: INTERACT_TOOL,
    description: 'Declare that the task needs a human decision and immediately show a clickable ColdX interaction. Supply stable choice IDs and concise labels; optional sandbox previews are local and do not execute Host operations. The first option may be previewed initially without submitting it; put a recommended option first and explicitly set recommended=true on at most one option when justified, never invent a recommendation label. Empty options allow a short custom answer. The native tool waits for submission and returns the answer to this same task; continue real work from that result. Use the native approval/plan-review tools for permissions and plan approval instead.',
    parameters: {
      title: { type: 'string', required: true }, question: { type: 'string', required: true },
      options: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, label: { type: 'string', required: true },
        description: { type: 'string' }, recommended: { type: 'boolean' }, preview,
      } } },
      multiSelect: { type: 'boolean' }, allowCustom: { type: 'boolean' }, submitLabel: { type: 'string' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => ({ coldxInteraction: value }) },
    async execute(args, exec) {
      assertOwner(exec);
      const input = normalizeInteractionInput(args);
      const questionId = questionIdOf(exec.callId);
      const lifetime = new AbortController();
      active.add(lifetime);
      try {
        const answer = await ctx.userQuestions.ask({ agent: exec.agent, signal: AbortSignal.any([exec.signal, lifetime.signal]), questions: [{
          id: questionId, header: input.title, question: input.question,
          options: input.options.map(({ label, description }) => ({ label, ...(description ? { description } : {}) })),
          multiSelect: input.multiSelect,
        }] });
        return { interactionId: exec.callId, status: 'selected', ...normalizeInteractionAnswer(input, questionId, answer) };
      } catch (error) {
        if (lifetime.signal.aborted && !exec.signal.aborted) return { interactionId: exec.callId, status: 'interrupted', selectedIds: [], selectedLabels: [], custom: '' };
        throw error;
      } finally { active.delete(lifetime); }
    },
  }));
  ctx.tools.register(defineTool({
    name: FINISH_TOOL,
    description: 'Optional typed completion marker for a finished ColdX interaction or generated page. Ordinary prose answers should end with the native assistant stop and should not call this tool. No generated page is required. When a compact workspace completion record is useful, call this once as the only block in the step and put the complete user-facing result in summary: a successful call closes the current turn directly and there is no later assistant-answer step.',
    parameters: { summary: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => ({ coldxFinish: value }) },
    async execute(args, exec) {
      assertOwner(exec);
      const value = { completionId: exec.callId, status: 'completed', ...normalizeCompletionInput(args) };
      exec.concludeTurn();
      return value;
    },
  }));
}
