// Serialized by the client build. DSH remains the source of theme changes.
export function createHtmlPreviewComponents(React, buildPageDocument, readTheme, subscribeTheme) {
  const h = React.createElement;
  function HtmlPreview({ identity, html, title, className }) {
    const iframe = React.useRef(null);
    const document = React.useMemo(() => {
      const channel = 'coldx-file-' + crypto.randomUUID();
      return { channel, source: buildPageDocument({ html, channel, theme: readTheme(), rawDocument: true }) };
    }, [identity, html]);
    const syncTheme = () => iframe.current?.contentWindow?.postMessage({ type: 'coldx:theme', channel: document.channel, theme: readTheme() }, '*');
    React.useEffect(() => {
      const receive = event => {
        const data = event.data;
        if (event.source !== iframe.current?.contentWindow || !data || data.channel !== document.channel) return;
        if (data.type === 'coldx:ready') { syncTheme(); return; }
        // An exported HTML file may contain ColdX.submit. Previewing it must not
        // mutate the conversation, and its promise must not hang for 30 seconds.
        if (data.type === 'coldx:submit' && typeof data.requestId === 'string') {
          event.source.postMessage({ type: 'coldx:result', channel: document.channel, requestId: data.requestId, ok: false, error: '文件预览不能提交任务，请在对话中继续。' }, '*');
        }
      };
      window.addEventListener('message', receive);
      const unsubscribe = subscribeTheme?.(syncTheme);
      syncTheme();
      return () => { window.removeEventListener('message', receive); unsubscribe?.(); };
    }, [document]);
    return h('iframe', { key: identity, ref: iframe, title, className, srcDoc: document.source,
      sandbox: 'allow-scripts', referrerPolicy: 'no-referrer', onLoad: syncTheme });
  }
  return { HtmlPreview };
}
