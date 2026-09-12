// Serialized into the existing DSH client; RPC reads never capture or operate a browser.
export function createComputerComponents(React, rpc) {
  const h = React.createElement;
  const empty = Object.freeze({ version: 1, records: [], browserOpen: false, loading: true });
  function previewUrl(attachment) {
    if (!attachment || !['image/png', 'image/jpeg', 'image/webp'].includes(attachment.mime)
      || typeof attachment.base64 !== 'string' || !attachment.base64.length || attachment.base64.length > 12 * 1024 * 1024
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(attachment.base64) || attachment.base64.length % 4 !== 0) return undefined;
    return `data:${attachment.mime};base64,${attachment.base64}`;
  }
  function useComputer(sessionId) {
    const [state, setState] = React.useState(() => ({ sessionId, snapshot: empty }));
    const [closing, setClosing] = React.useState(() => ({ sessionId, pending: false, error: '' }));
    const owner = React.useRef(null);
    const owns = current => owner.current === current && !current.controller.signal.aborted;
    function acceptSnapshot(current, result) {
      if (!owns(current)) return;
      if (result?.version !== 1 || !Number.isSafeInteger(result.revision) || result.revision < 0 || !Array.isArray(result.records)) throw new Error('无效的浏览器状态');
      // Reads can settle after a close response. Both belong to the same
      // revision stream; an older response must not reopen the displayed state.
      if (result.revision < current.revision) return;
      current.revision = result.revision;
      setState({ sessionId: current.sessionId, snapshot: { ...result, loading: false, error: '' } });
    }
    React.useEffect(() => {
      const controller = new AbortController();
      const current = { sessionId, controller, revision: -1, closePending: false }; owner.current = current;
      const cleanup = () => { controller.abort(); if (owner.current === current) owner.current = null; };
      if (typeof sessionId !== 'string' || !sessionId) return cleanup;
      setState({ sessionId, snapshot: empty }); setClosing({ sessionId, pending: false, error: '' });
      let failures = 0;
      const delay = ms => new Promise(resolve => {
        if (controller.signal.aborted) { resolve(); return; }
        const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, ms); controller.signal.addEventListener('abort', done, { once: true });
      });
      (async () => {
        while (!controller.signal.aborted) {
          try {
            const result = await rpc(sessionId, 'read', { afterRevision: current.revision, waitMs: 20_000 }, controller.signal);
            if (!owns(current)) break;
            acceptSnapshot(current, result); failures = 0;
            await delay(150);
          } catch {
            if (controller.signal.aborted) break;
            setState(value => ({ sessionId, snapshot: { ...(value.sessionId === sessionId ? value.snapshot : empty), loading: false, error: '浏览器状态连接中断，正在重连。' } }));
            await delay(Math.min(15_000, 1500 * 2 ** Math.min(failures++, 4)));
          }
        }
      })();
      return cleanup;
    }, [sessionId]);
    const snapshot = state.sessionId === sessionId ? state.snapshot : empty;
    const closeState = closing.sessionId === sessionId ? closing : { pending: false, error: '' };
    async function close() {
      const current = owner.current;
      if (!current || current.sessionId !== sessionId || !owns(current) || current.closePending) return;
      current.closePending = true;
      setClosing({ sessionId, pending: true, error: '' });
      try {
        const result = await rpc(sessionId, 'close', {}, current.controller.signal);
        if (!owns(current)) return;
        acceptSnapshot(current, result);
        setClosing({ sessionId, pending: false, error: '' });
      } catch (error) {
        if (!owns(current)) return;
        setClosing({ sessionId, pending: false, error: error?.message || '关闭失败，请重试。' });
      } finally { current.closePending = false; }
    }
    return { snapshot, close, closing: closeState.pending, closeError: closeState.error };
  }
  function ComputerStatus({ state }) {
    const snapshot = state.snapshot;
    if (!snapshot.connected && !snapshot.browserOpen && !snapshot.records.length && !snapshot.error && snapshot.available !== false) return null;
    const closed = !snapshot.browserOpen && snapshot.records.some(record => record.status === 'completed'
      && (record.operation === 'browser_close' || record.surfaceLabel === '关闭浏览器'));
    return h('div', { className: 'cx-computer-controls' },
      h('div', null, h('strong', null, '浏览器操作'), h('small', null, snapshot.browserOpen ? '独立会话 · 画面随工具操作更新' : closed ? '浏览器已关闭 · 保留本次操作记录' : snapshot.connected ? '浏览器已就绪，等待打开网页' : snapshot.availabilityMessage || '浏览器已关闭 · 保留本次操作记录')),
      (snapshot.connected || snapshot.browserOpen) && h('button', { type: 'button', disabled: state.closing, onClick: state.close }, state.closing ? '正在结束…' : '结束浏览器会话'),
      (snapshot.error || state.closeError) && h('p', { role: 'status' }, state.closeError || snapshot.error));
  }
  function ComputerPreview({ record, latest = true }) {
    const url = previewUrl(record.previewAttachment);
    const viewportId = React.useId();
    const viewport = React.useRef(null);
    const [size, setSize] = React.useState(() => ({ callId: record.callId, url, actual: false }));
    const actual = size.callId === record.callId && size.url === url && size.actual;
    const centerImage = () => {
      const node = viewport.current;
      if (!node || !actual) return;
      node.scrollLeft = Math.max(0, (node.scrollWidth - node.clientWidth) / 2);
      node.scrollTop = Math.max(0, (node.scrollHeight - node.clientHeight) / 2);
    };
    (React.useLayoutEffect ?? React.useEffect)(centerImage, [actual, record.callId, url]);
    if (!url) return h('small', null, '此次操作的截图不可用。');
    const content = h('figure', { className: 'cx-computer-preview', 'data-zoom': actual ? 'actual' : 'fit' },
      h('figcaption', null,
        h('span', null, '操作截图', Number.isFinite(record.finishedAt ?? record.startedAt) ? ` · ${new Date(record.finishedAt ?? record.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : ''),
        h('button', { type: 'button', 'aria-controls': viewportId, 'aria-pressed': actual,
          onClick: () => setSize(value => ({callId:record.callId,url,actual:!(value.callId === record.callId && value.url === url && value.actual)})) }, actual ? '适合宽度' : '放大截图')),
      h('div', { id: viewportId, ref: viewport, className: 'cx-computer-image-viewport', role: 'region', tabIndex: actual ? 0 : -1,
        'aria-label': actual ? '截图原尺寸查看，可使用方向键滚动' : '截图适合宽度查看' },
        h('img', { src: url, alt: `${record.surfaceLabel}的操作截图`, loading: 'lazy', onLoad: centerImage })),
      actual && h('small', { className: 'cx-computer-image-hint' }, '原尺寸 · 可用方向键、滚动条或触控板查看'));
    return latest ? content : h('details', { className: 'cx-computer-older-preview' }, h('summary', null, '查看此次操作截图'), content);
  }
  return { useComputer, ComputerStatus, ComputerPreview, previewUrl };
}
