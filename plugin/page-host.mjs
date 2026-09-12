import { nativeImport } from './page-native.mjs';
import { PAGE_TOOL, pageProjection, questionIdOf } from './page-model.mjs';
import { normalizePageInput } from './page-input.mjs';

const { defineTool } = await nativeImport('@deepseek-ai/dsh-tools');

export const name = 'coldx-pages';
export const inject = ['tools', 'userQuestions', 'agents'];

/** Native tools, native question carrier, native session projections. */
export function apply(ctx) {
  const active = new Set();
  let disposed = false;
  ctx.effect(() => () => {
    disposed = true;
    for (const controller of active) controller.abort('ColdX page plugin unloaded');
  });
  ctx.inject(['sessionProjections'], pc => pc.sessionProjections.register(pageProjection));
  ctx.tools.register(defineTool({
    name: PAGE_TOOL,
    description: 'Generate and present a useful page in the current ColdX workspace when a visual surface materially improves the result. Comparisons of three or more options across multiple dimensions, multi-source research, audits, roadmaps, editors, progress monitors and explorable data are strong candidates even without an explicit page request. Choose this from task value rather than a quota; answer directly when a page would only wrap short prose or delay a clear result. Use waitForInput=false for a display-only result and true only when the submitted choice must continue the same task. Prefer script-only: omit html and htmlBase64, create semantic DOM with document.createElement, textContent and append under #coldx-root, and use CSS/JavaScript for a task-shaped editor, canvas, map, timeline, simulation or report rather than generic cards. Explicit HTML or UTF-8 Base64 HTML is also supported. The page may call window.ColdX.submit(JSON_value) to return its user-selected result. A waiting call continues the same task automatically after submission; do not call another wait tool. This local display grants no Host, filesystem, network or native plugin permissions.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short page title.' },
      subtitle: { type: 'string', description: 'Optional short page context.' },
      html: { type: 'string', description: 'Optional real HTML body markup; never combine with htmlBase64. Prefer omitting both when script builds the DOM in #coldx-root. Never provide a JSON tag tree or HTML-escaped prose. Do not include secrets.' },
      htmlBase64: { type: 'string', description: 'Canonical padded Base64 of the original UTF-8 HTML. Use this if the provider damages angle-bracket markup; omit html. Never Base64-encode a JSON tag tree.' },
      css: { type: 'string', description: 'Optional page CSS. Follow the app theme using inherited --page-bg, --page-surface, --page-text, --page-muted, --page-line, --page-field, --page-accent and --page-on-accent tokens; do not redefine these host tokens or hardcode a white/black page. For custom palettes provide both :root[data-theme="light"] and :root[data-theme="dark"] variants. The app preference can differ from the OS, so do not rely on prefers-color-scheme.' },
      script: { type: 'string', description: 'Preferred page source: browser JavaScript using document.createElement/textContent/append to build any DOM under document.getElementById("coldx-root"); omit html and htmlBase64 for this path. Submit user choices with window.ColdX.submit(value). ColdX.theme is initially light or dark; listen to window coldx:themechange (event.detail.theme) to repaint canvases/charts on live changes without rebuilding forms or losing input.' },
      waitForInput: { type: 'boolean', description: 'Wait for the page to return a choice. Defaults to true.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => ({ coldxPage: value }),
    },
    async execute(args, exec) {
      if (disposed) throw new Error('ColdX page plugin unloaded');
      if (!exec.agent || ctx.agents.get(exec.agent.id) !== exec.agent) {
        throw new Error('ColdX pages require the exact live calling Agent');
      }
      if (!exec.callId) throw new Error('ColdX pages require a native tool call ID');
      const page = normalizePageInput(args);
      const pageId = exec.callId;
      const result = (status, value = null) => ({ pageId, revision: 1, status, value });
      if (!page.waitForInput) return result('displayed');
      const lifetime = new AbortController();
      active.add(lifetime);
      try {
        const answer = await ctx.userQuestions.ask({
          agent: exec.agent,
          signal: AbortSignal.any([exec.signal, lifetime.signal]),
          questions: [{
            id: questionIdOf(pageId), header: 'ColdX 页面',
            question: `请在「${page.title}」页面中完成选择并提交。`,
          }],
        });
        const item = answer.answers[0];
        if (answer.answers.length !== 1 || item?.id !== questionIdOf(pageId)
          || item.selected.length !== 0 || typeof item.custom !== 'string' || item.custom.length > 65_536) {
          throw new Error('ColdX page response must be one JSON answer for its exact page');
        }
        const value = JSON.parse(item.custom);
        return result('selected', value);
      } catch (error) {
        if (lifetime.signal.aborted && !exec.signal.aborted) return result('interrupted');
        throw error;
      } finally {
        active.delete(lifetime);
      }
    },
  }));
}
