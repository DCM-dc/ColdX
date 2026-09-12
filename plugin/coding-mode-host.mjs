import { nativeImport } from './page-native.mjs';
import { codingModeState } from './coding-mode-model.mjs';

const { scopeOf, scopeChainOf } = await nativeImport('@deepseek-ai/dsh-scope');

export const name = 'coldx-coding-mode';
export const inject = ['commands', 'goals', 'agents', 'systemPrompt'];

const instruction = `Goal mode is selected for this Session. On a direct human request, call get_goal once before the first business tool in that turn. Infer a concise completion objective grounded in that request and call create_goal when there is no unfinished goal. If this turn already contains goal bookkeeping, do not repeat it. If an existing paused, blocked, or disarmed goal fits the request, edit or resume it only when the human request supports that action. Selection alone never creates or resumes a goal. Never infer a new goal from plugin notices or autonomous goal rounds. In Plan mode, the Plan policy's general no-mutation rule and its precedence clause have one narrow built-in exception: native get_goal and create/edit/resume_goal bookkeeping may record the requested objective before plan review because it does not carry out the plan. No filesystem, code, configuration, business, or other mutation may occur until the native Plan is approved.`;

function refOf(goal) { return { id: goal.id, revision: goal.revision }; }

export function apply(ctx) {
  const owner = scopeOf(ctx);
  let disposed = false;
  ctx.effect(() => () => { disposed = true; });

  function assertOwner(invocation) {
    if (disposed) throw new Error('ColdX coding mode plugin unloaded');
    const agent = invocation.agent;
    if (!owner || !agent || !scopeChainOf(agent).includes(owner)
      || ctx.agents.get(agent.id) !== agent || !ctx.agents.roots().includes(agent)) {
      throw new Error('ColdX coding mode requires its exact live root Agent');
    }
    invocation.signal.throwIfAborted();
    return agent;
  }

  ctx.commands.register({
    name: 'coldx-goal',
    description: 'select Goal behavior for the next direct human request',
    input: { hint: 'on|off' },
    recordInput: true,
    handler(invocation) {
      const agent = assertOwner(invocation);
      const value = invocation.rawInput.trim().toLowerCase();
      if (value !== 'on' && value !== 'off') return { kind: 'error', text: 'Usage: /coldx-goal on|off' };
      const selected = value === 'on';
      if (!selected) {
        const current = ctx.goals.get(agent);
        if (current?.phase === 'active') {
          ctx.goals.pause(agent, refOf(current));
          invocation.signal.throwIfAborted();
        }
      }
      if (codingModeState(agent.session.events).goal === selected) {
        return { kind: 'success', text: selected ? 'Goal mode is already selected.' : 'Goal mode is already off.' };
      }
      invocation.signal.throwIfAborted();
      return {
        kind: 'success',
        text: selected ? 'Goal mode selected for the next direct human request.' : 'Goal mode turned off.',
      };
    },
  });

  ctx.systemPrompt.section({
    name: 'coldx:coding-mode',
    // Native Plan owns order 50. This section must follow it so the narrow
    // bookkeeping exception cannot be downgraded to a user-role snapshot or
    // pre-empted by Plan's later precedence clause.
    order: 60,
    text(context) {
      const agent = context.agent;
      if (!agent || !owner || !scopeChainOf(agent).includes(owner)
        || ctx.agents.get(agent.id) !== agent || !ctx.agents.roots().includes(agent)) return '';
      return codingModeState(agent.session.events).goal ? instruction : '';
    },
  });
}
