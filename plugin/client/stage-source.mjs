// Each generated interface is rendered at its native tool-call position.
// DSH owns ordering, scrolling and the composer; there is no separate page dock.
export function createPageStage(React, buildPageDocument, createPageSubmitter, readTheme, _MarkdownText, QuestionFrame, createWorkspaceModel, createMotionRuntime, subscribeTheme) {
  const h = React.createElement;
  const EMPTY = [];
  const label = { waiting: '等待你的选择', selected: '已确认', displayed: '已呈现', cancelled: '已停止', interrupted: '已中断' };

  function PageFrame({ page, carrier, submit, sessionId }) {
    const iframe = React.useRef(null), panel = React.useRef(null), motion = React.useRef(null);
    const entered = React.useRef(false);
    React.useLayoutEffect(() => {
      const runtime = createMotionRuntime?.(); motion.current = runtime;
      if (!entered.current && !['selected', 'cancelled', 'interrupted'].includes(page.status)) {
        entered.current = true; runtime?.materialize(panel.current);
      }
      return () => { runtime?.dispose(); motion.current = null; };
    }, []);
    const live = React.useRef({ page, carrier });
    live.current = { page, carrier };
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const [accepted, setAccepted] = React.useState(false);
    const [frameHeight, setFrameHeight] = React.useState(360);
    const channel = React.useRef(null);
    if (!channel.current) channel.current = 'coldx-' + crypto.randomUUID();
    // A theme change is a message to the current document, never new srcDoc.
    const source = React.useMemo(() => buildPageDocument({
      html: page.html, css: page.css, script: page.script, channel: channel.current, theme: readTheme(),
    }), [page.html, page.css, page.script]);
    const syncTheme = () => iframe.current?.contentWindow?.postMessage({ type: 'coldx:theme', channel: channel.current, theme: readTheme() }, '*');
    React.useEffect(() => {
      const unsubscribe = subscribeTheme?.(syncTheme);
      syncTheme();
      return () => unsubscribe?.();
    }, []);
    const [readySource, setReadySource] = React.useState(null);
    const ready = readySource === source;
    React.useEffect(() => {
      let mounted = true;
      const size = data => {
        if (!Number.isFinite(data.height) || data.height <= 0) return;
        const height = Math.max(220, Math.min(20_000, Math.ceil(data.height)));
        // Ignore viewport echoes from 100vh documents; genuine growth changes
        // this message's height and is observed by DSH's native scroll manager.
        const current = iframe.current?.clientHeight ?? 0;
        if (current > 0 && Math.abs(current - height) <= 2) return;
        if (mounted) setFrameHeight(previous => previous === height ? previous : height);
      };
      const receive = async event => {
        const data = event.data;
        if (event.source !== iframe.current?.contentWindow || !data || data.channel !== channel.current) return;
        if (data.type === 'coldx:ready') { syncTheme(); size(data); if (mounted) setReadySource(source); return; }
        if (data.type === 'coldx:resize') { size(data); return; }
        if (data.type !== 'coldx:submit' || typeof data.requestId !== 'string') return;
        const target = event.source;
        const submittedPageId = live.current.page.pageId;
        const reply = result => target?.postMessage({ type: 'coldx:result', channel: channel.current, requestId: data.requestId, ...result }, '*');
        setBusy(true); setError('');
        try {
          const value = await submit({ ...live.current, active: true, sessionId, value: data.value });
          reply({ ok: true, value });
          if (mounted && live.current.page.pageId === submittedPageId && !['cancelled', 'interrupted'].includes(live.current.page.status)) setAccepted(true);
        } catch (err) {
          const message = err instanceof Error ? err.message : '提交失败，请重试。';
          reply({ ok: false, error: message });
          if (mounted) setError(message);
        } finally { if (mounted) setBusy(false); }
      };
      window.addEventListener('message', receive);
      return () => { mounted = false; window.removeEventListener('message', receive); };
    }, [submit, sessionId, source]);
    const unavailable = page.status === 'cancelled' || page.status === 'interrupted';
    const settled = !unavailable && (page.status === 'selected' || accepted);
    const previousSettled = React.useRef(settled);
    React.useLayoutEffect(() => {
      if (!previousSettled.current && settled) motion.current?.confirm(panel.current);
      previousSettled.current = settled;
    }, [settled]);
    const frameState = unavailable ? page.status : settled ? 'settled' : 'active';
    const visibleError = !settled && !unavailable && error;
    const note = settled ? '选择已送达，AI 将继续任务。'
      : unavailable ? '这次交互已结束。可以在下方继续对话。'
      : visibleError || (busy ? '正在确认…' : !ready ? '正在连接页面…'
      : page.status === 'displayed' ? '可以查看和探索这一页。'
      : carrier ? '在页面中完成选择，接下来交给 AI。' : '页面已就绪。');
    return h('div', { className: 'coldx-page-panel', ref: panel, 'data-state': frameState, role: 'group', 'aria-label': page.title },
      h('div', { className: 'coldx-page-titlebar' },
        h('div', null, h('h2', { className: 'coldx-page-title' }, page.title),
          page.subtitle && h('p', { className: 'coldx-page-subtitle' }, page.subtitle)),
        h('span', { className: 'coldx-page-state' }, unavailable ? label[page.status] : settled ? label.selected : label[page.status])),
      h('div', { className: 'coldx-frame-area' },
        h('iframe', { ref: iframe, className: 'coldx-page-frame', title: page.title,
          sandbox: 'allow-scripts', referrerPolicy: 'no-referrer', srcDoc: source,
          style: { height: frameHeight }, 'data-ready': ready, 'aria-busy': !ready,
          'aria-hidden': !ready, inert: !ready || settled || unavailable ? '' : undefined, tabIndex: ready && !settled && !unavailable ? 0 : -1, 'data-state': frameState,
          onLoad: () => { syncTheme(); setReadySource(source); } }),
        (settled || unavailable) && h('div', { className: 'coldx-page-unavailable' }, h('span', null, settled ? '已确认 · 内容仍可回看' : '交互已结束 · 内容仍可回看'))),
      h('div', { className: 'coldx-page-foot', 'data-error': Boolean(visibleError), 'data-settled': settled, role: 'status' },
        h('span', { className: 'coldx-page-dot', 'aria-hidden': true }), note));
  }

  function InlineSessionTool({ useProjection, useSession, sessionId, callId, toolName, block, inspect }) {
    const projection = useProjection('coldx.pages');
    const flow = useProjection('coldx.flow');
    const pending = useSession(state => state.pending) ?? EMPTY;
    const model = React.useMemo(() => createWorkspaceModel(), []);
    const submit = React.useMemo(() => createPageSubmitter(), []);
    const { entries } = model({ pages: projection?.pages ?? EMPTY, flow, pending, sessionId });
    // Associate by the complete native call identity, never the latest page.
    const page = entries.find(entry => entry.pageId === callId
      && (toolName === 'coldx_present_page' ? entry.kind === 'page' : entry.kind === 'question'));
    // Projection delivery can trail the native call row. Keep the keyed seat
    // visible until it arrives; a failed call has an honest recoverable state.
    if (!page) {
      const settled = Boolean(block && 'kind' in block);
      return h('div', { className: 'coldx-inline-message coldx-inline-pending', 'data-coldx-call-id': callId, role: 'status' },
        h('span', null, settled ? '这次交互未能恢复。' : '正在准备交互…'),
        inspect && h('button', { type: 'button', className: 'coldx-inline-details', onClick: inspect }, '查看调用详情'));
    }
    return h('article', { className: 'coldx-inline-message', 'data-coldx-call-id': callId, 'data-state': page.status, 'aria-label': page.title },
      h('div', { className: 'coldx-page-shell' }, page.kind === 'question'
        ? h(QuestionFrame, { page, inline: true, active: true, carrier: page.carrier, sessionId })
        : h(PageFrame, { page, carrier: page.carrier, submit, sessionId })),
      inspect && h('button', { type: 'button', className: 'coldx-inline-details', onClick: inspect }, '执行详情'));
  }

  // Session switching or a different call owns a new document; lifecycle
  // updates for the same call preserve the iframe and any local draft.
  function InlineTool(props) {
    return h(InlineSessionTool, { ...props, key: props.sessionId + ':' + props.callId });
  }
  return { InlineTool };
}
