import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

function hostPlugin(harness, owner, toolName) {
  let selection;
  let disposed = false;
  const waiters = new Set();
  function settle(value) { for (const finish of [...waiters]) finish(value); }
  return { inject: ['tools'], apply(ctx) {
    ctx.effect(() => harness.handle('commit', async (values) => {
      if (disposed) throw new Error('This interaction is closed');
      if (!values || !['speed', 'quality', 'budget'].every((key) => Number.isFinite(values[key]) && values[key] >= 0 && values[key] <= 100)) throw new Error('Values must be numbers from 0 to 100');
      if (selection) {
        if (['speed', 'quality', 'budget'].every((key) => values[key] === selection[key])) return { accepted: true, selection };
        return { accepted: false, code: 'selection-locked', message: '这次交互已确认，原任务会使用已确认的偏好。如需修改，请在对话中说明并创建新的工作台。', selection };
      }
      selection = { status: 'selected', speed: values.speed, quality: values.quality, budget: values.budget };
      settle(selection);
      return { accepted: true, selection };
    }));
    ctx.effect(() => harness.registerTool(ctx, harness.defineTool({
      name: toolName,
      description: 'Wait for the user to confirm priorities in the open ColdX Decision Studio. Event-driven and cancellable. After receiving the selection, continue the original task.',
      parameters: {},
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(_args, execution) {
        if (execution.agent?.id !== owner) throw new Error('This interaction belongs to its owning session');
        if (disposed) return { status: 'closed' };
        if (execution.signal.aborted) return { status: 'cancelled' };
        if (selection) return selection;
        return new Promise((resolve) => {
          const finish = (value) => { waiters.delete(finish); execution.signal.removeEventListener('abort', abort); resolve(value); };
          const abort = () => finish({ status: 'cancelled' });
          waiters.add(finish);
          execution.signal.addEventListener('abort', abort, { once: true });
        });
      },
    })));
    ctx.effect(() => () => { disposed = true; settle({ status: 'closed' }); });
  } };
}

function clientPlugin(React, host, owner, surfaceId) {
  const h = React.createElement;
  const labels = { speed: '交付速度', quality: '完成质量', budget: '成本控制' };
  function Studio({ sessionId }) {
    const [values, setValues] = React.useState({ speed: 70, quality: 85, budget: 55 });
    const [status, setStatus] = React.useState('editing');
    const [error, setError] = React.useState('');
    if (sessionId !== owner) return null;
    const points = `${120},${110 - values.quality * .8} ${120 + values.speed * .78},${110 + values.speed * .45} ${120 - values.budget * .78},${110 + values.budget * .45}`;
    const text = (value, style = {}) => h('span', { style }, value);
    if (status === 'sent') return h('div', { role: 'status', style: { padding: 12, color: 'var(--dsw-alias-label-primary)' } }, '✓ 优先级已提交，ColdX 可以继续任务。');
    return h('section', { 'aria-label': 'ColdX 决策工作台', style: { margin: '0 8px 10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 18, padding: 20, background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', boxShadow: '0 8px 32px #00000008' } },
      h('header', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 } },
        h('div', null, h('div', { style: { color: '#15947a', fontSize: 10, fontWeight: 750, letterSpacing: '.15em' } }, 'COLDX / DECISION STUDIO'), h('h3', { style: { margin: '5px 0', fontSize: 19, letterSpacing: '-.03em' } }, '让取舍变得直观')),
        text('拖动 · 比较 · 确认', { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 })),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16 } },
        h('svg', { viewBox: '0 0 240 190', width: 230, height: 175, role: 'img', 'aria-label': `当前优先级：速度 ${values.speed}，质量 ${values.quality}，成本 ${values.budget}`, style: { flex: '1 1 180px', maxWidth: 280 } },
          ...[.33, .66, 1].map((scale) => h('polygon', { key: scale, points: `120,${110 - 80 * scale} ${120 + 78 * scale},${110 + 45 * scale} ${120 - 78 * scale},${110 + 45 * scale}`, fill: 'none', stroke: '#7a929533', strokeWidth: 1 })),
          h('polygon', { points, fill: '#21b69b33', stroke: '#15947a', strokeWidth: 2.5, strokeLinejoin: 'round' }),
          h('text', { x: 120, y: 18, textAnchor: 'middle', fill: 'currentColor', fontSize: 11 }, '质量'),
          h('text', { x: 211, y: 172, textAnchor: 'middle', fill: 'currentColor', fontSize: 11 }, '速度'),
          h('text', { x: 29, y: 172, textAnchor: 'middle', fill: 'currentColor', fontSize: 11 }, '成本')),
        h('div', { style: { flex: '2 1 210px', display: 'grid', gap: 13 } },
          ...Object.keys(labels).map((key) => h('label', { key, style: { display: 'grid', gap: 7, fontSize: 12 } },
            h('span', { style: { display: 'flex', justifyContent: 'space-between' } }, labels[key], text(values[key], { fontVariantNumeric: 'tabular-nums' })),
            h('input', { type: 'range', min: 0, max: 100, step: 1, value: values[key], 'aria-label': labels[key], disabled: status === 'sending', style: { width: '100%', accentColor: '#15947a' }, onChange: (event) => setValues({ ...values, [key]: Number(event.target.value) }) }))))),
      h('footer', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 10 } },
        text(error || '确认后将这组偏好交给当前任务。', { color: error ? '#c54f47' : 'var(--dsw-alias-label-tertiary)', fontSize: 11 }),
        h('button', { type: 'button', disabled: status === 'sending', style: { border: 0, borderRadius: 10, padding: '9px 14px', background: '#143c34', color: '#e5fff5', fontWeight: 650, cursor: 'pointer', whiteSpace: 'nowrap' }, onClick: async () => {
          setStatus('sending'); setError('');
          try { const result = await host.call('commit', values); if (!result.accepted) throw new Error(result.message || '未能提交，请重试'); setStatus('sent'); }
          catch (error) { setStatus('editing'); setError(error.message || '提交失败，请重试'); }
        } }, status === 'sending' ? '正在提交…' : '确认这组偏好 →')));
  }
  return { inject: ['slots'], apply(ctx) {
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: surfaceId, order: -50 }, Studio));
  } };
}

/** A native cordis_define input. Use its code unchanged; bind to the real session id. */
export function createDecisionStudio(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('A real owning session id is required');
  const toolName = 'coldx_decision_' + createHash('sha256').update(sessionId + randomUUID()).digest('hex').slice(0, 12);
  return {
    plugin: { kind: 'new', idPrefix: 'coldx' },
    name: 'ColdX Decision Studio',
    purpose: `Collect priorities interactively for this task. After cordis_run, call ${toolName} and continue using its result.`,
    toolName,
    code: {
      host: `return (${hostPlugin.toString()})(harness, ${JSON.stringify(sessionId)}, ${JSON.stringify(toolName)});`,
      client: `return (${clientPlugin.toString()})(React, host, ${JSON.stringify(sessionId)}, ${JSON.stringify(toolName)});`,
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { toolName, ...definition } = createDecisionStudio(process.argv[2]);
  process.stdout.write(JSON.stringify(definition, null, 2) + '\n');
}
