// Self-contained native client factory. The Host remains the only filesystem reader.
export function createFileViewComponents(React, MarkdownText, requestFile, openNative, {HtmlPreview,PdfPreview,getReferenceTarget,pane} = {}) {
  const h = React.createElement;
  const states = new Map(), listeners = new Set(), inputs = new Map();
  const knownFiles = new Map();
  const pendingReferences = new Map();
  const empty = Object.freeze({ open: false, path: '.', tabs: [], line: undefined });
  const get = id => states.get(id) ?? empty;
  const update = (id, change) => { states.set(id, { ...get(id), ...change }); for (const listener of listeners) listener(); };
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  const leaf = path => path.replaceAll('\\', '/').split('/').at(-1) || path;
  function parseLocalFileLink(href, base = '.') {
    if (typeof href !== 'string' || !href || href.startsWith('#') || href.startsWith('//')) return null;
    if (/^[a-z][a-z0-9+.-]*:/iu.test(href) && !/^file:\/\/\//iu.test(href) && !/^[a-z]:[\\/]/iu.test(href)) return null;
    const match = /(?::|#L?)(\d+)$/u.exec(href);
    const raw = match ? href.slice(0,match.index) : href.split('#')[0];
    let path;
    try { path = decodeURIComponent(raw.replace(/^file:\/\//iu, '')).replace(/^\/([a-z]:[\\/])/iu,'$1'); } catch { return null; }
    if (!path || /[\u0000-\u001f]/u.test(path)) return null;
    if (!/^(?:[a-z]:[\\/]|\/|\\\\)/iu.test(path) && base !== '.') {
      const directory = base.replaceAll('\\','/').split('/').slice(0,-1).join('/');
      path = `${directory ? `${directory}/` : ''}${path}`;
    }
    return {path,line:match ? Number(match[1]) : undefined};
  }
  function open(sessionId, path = '.', line) {
    if (typeof sessionId !== 'string' || typeof path !== 'string') return false;
    update(sessionId, { open: true, path, line, tabs: path === '.' ? get(sessionId).tabs : [...new Set([...get(sessionId).tabs, path])].slice(-12) });
    if (path === '.') pane?.open(sessionId, 'files');
    else pane?.openDocument(sessionId, path);
    return true;
  }
  function closeTab(sessionId, path) {
    const state = get(sessionId), index = state.tabs.indexOf(path);
    if (index < 0) return false;
    const tabs = state.tabs.filter(item => item !== path);
    const next = tabs[Math.max(0, index-1)] ?? '.';
    update(sessionId, { tabs, ...(state.path === path ? {path:next,line:undefined} : {}) });
    pane?.closeDocument(sessionId, path, {prefer:next === '.' ? null : next});
    return true;
  }
  pane?.bindFiles({open,close:closeTab});
  function reference(sessionId, path, selection) {
    const destination = getReferenceTarget?.(sessionId);
    const input = destination ? undefined : inputs.get(sessionId);
    if (/["\u0000-\u001f]/u.test(path)) throw new Error('文件名包含无法引用的字符，请先重命名文件。');
    const mention = `@${JSON.stringify(path)}`;
    const text = selection ? `${mention}\n> ${selection.trim().slice(0, 6000).replaceAll('\n', '\n> ')}\n` : `${mention} `;
    if (!input) {
      const target = destination;
      if (!target || target.sessionId === sessionId) throw new Error('当前会话输入框未就绪。');
      pendingReferences.set(target.sessionId, text);
      try { target.open(); } catch (error) { pendingReferences.delete(target.sessionId); throw error; }
      return;
    }
    input.setDraft(`${input.draft}${input.draft && !/\s$/u.test(input.draft) ? '\n' : ''}${text}`);
  }
  function InputReferenceBridge({ sessionId, input, inputActions }) {
    React.useEffect(() => {
      const value = { draft: input?.draft ?? '', setDraft: value => inputActions?.setDraft?.(value) };
      inputs.set(sessionId, value);
      const pending = pendingReferences.get(sessionId);
      if (pending && inputActions?.setDraft) {
        pendingReferences.delete(sessionId);
        value.setDraft(`${value.draft}${value.draft && !/\s$/u.test(value.draft) ? '\n' : ''}${pending}`);
      }
      return () => { if (inputs.get(sessionId) === value) inputs.delete(sessionId); };
    }, [sessionId, input?.draft, inputActions]);
    return null;
  }
  function safeHtml(text) {
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'"></head><body>${text}</body></html>`;
  }
  // Each open file owns its preview instance. Hiding the workbench or selecting
  // another tab must not reset PDF page/zoom, iframe state, or the text selection.
  function FileDocument({ sessionId, filePath, active, line }) {
    const owner = `${sessionId}\u0000${filePath}`;
    const [loaded, setLoaded] = React.useState(null), [failure, setFailure] = React.useState(null);
    const entry = loaded?.owner === owner ? loaded.value : null;
    const error = failure?.owner === owner ? failure.message : '';
    const setError = message => setFailure({owner,message});
    const [loading, setLoading] = React.useState(false), [source, setSource] = React.useState(false), [selection, setSelection] = React.useState('');
    const [query, setQuery] = React.useState('');
    const body = React.useRef(null);
    React.useEffect(() => {
      const controller = new AbortController();
      setLoaded(null); setError(''); setLoading(true); setSelection(''); setSource(false); setQuery('');
      (async () => {
        try {
          let value;
          try { value = await requestFile(sessionId, 'readFile', filePath, controller.signal); }
          catch (reason) {
            controller.signal.throwIfAborted();
            try { value = await requestFile(sessionId, 'listFiles', filePath, controller.signal); }
            catch { throw reason; }
          }
          if (!controller.signal.aborted) {
            setLoaded({owner,value});
            if (value.entries && get(sessionId).tabs.includes(filePath)) {
              update(sessionId,{tabs:get(sessionId).tabs.filter(path=>path!==filePath)});
              pane?.closeDocument(sessionId,filePath,{prefer:null});
            }
          }
        } catch (reason) { if (!controller.signal.aborted) setError(reason?.message || String(reason)); }
        finally { if (!controller.signal.aborted) setLoading(false); }
      })();
      return () => controller.abort();
    }, [sessionId, filePath]);
    React.useEffect(() => {
      if (active && line && entry?.text) body.current?.querySelector(`[data-line="${Math.max(1, Math.floor(line))}"]`)?.scrollIntoView({ block: 'center' });
    }, [entry, line, source, active]);
    const [blob, setBlob] = React.useState(null);
    const blobUrl = blob?.entry === entry ? blob.url : null;
    React.useEffect(() => {
      if (!entry || entry.entries || entry.truncated) { setBlob(null); return; }
      const original = entry.downloadBase64 ?? entry.base64;
      const bytes = original ? Uint8Array.from(atob(original), char => char.charCodeAt(0)) : entry.text;
      const url = URL.createObjectURL(new Blob([bytes], { type: entry.mime }));
      setBlob({ entry, url });
      return () => URL.revokeObjectURL(url);
    }, [entry]);
    const captureSelection = () => {
      const selected = window.getSelection();
      setSelection(selected && body.current?.contains(selected.anchorNode) && body.current?.contains(selected.focusNode) ? selected.toString().slice(0,6000) : '');
    };
    function cite() {
      try {
        reference(sessionId, entry.path, selection);
        // Keep the source alongside a writable conversation. A narrow modal
        // drawer must close first so the referenced draft is reachable.
        const panel = body.current?.closest?.('.cx-workbench-panel');
        if (panel?.dataset.mode === 'drawer') pane?.close(sessionId, 'files');
        else panel?.closest?.('.wSkVaW_root')?.querySelector?.('.uV2eYG_input')?.focus?.({ preventScroll: true });
      }
      catch (reason) { setError(reason.message); }
    }
    const path = entry?.path ?? filePath;
    const segments = path.replaceAll('\\','/').split('/').filter(part => part !== '.');
    function renderBody() {
      if (loading) return h('p', { role: 'status', className: 'cx-file-empty' }, '正在读取文件…');
      if (!entry) return null;
      if (entry.entries) {
        const matches = entry.entries.filter(item => item.name.toLowerCase().includes(query.toLowerCase()));
        return h(React.Fragment, null,
        h('input', { className: 'cx-file-search', 'aria-label': '筛选当前文件夹', value: query, onChange: event => setQuery(event.target.value), placeholder: '筛选当前文件夹' }),
        h('div', { className: 'cx-file-list' }, matches.map(item => h('button', {
          key: item.path, type:'button', onClick: () => open(sessionId, item.path), className: 'cx-file-item', title: item.path,
        }, h('span', { 'aria-hidden':true }, item.kind === 'directory' ? '▱' : '▤'), h('span', null, item.name), h('span', null, item.kind === 'directory' ? '打开文件夹' : '预览')))),
        matches.length === 0 && h('p', { className:'cx-file-empty', role:'status', 'aria-label':'文件筛选结果' }, entry.entries.length === 0 ? '文件夹为空。' : '没有匹配的文件。请尝试其他名称。'));
      }
      if (!source && entry.kind === 'image' && blobUrl) return h('img', { className:'cx-file-image', src:blobUrl, alt:entry.name });
      if (!source && entry.kind === 'pdf' && !entry.truncated && PdfPreview) return h(PdfPreview, {key:`${sessionId}\u0000${entry.path}`,base64:entry.base64,name:entry.name});
      if (!source && entry.kind === 'html' && HtmlPreview) return h(HtmlPreview, {identity:`${sessionId}\u0000${entry.path}`,html:entry.text,title:entry.name,className:'cx-file-frame'});
      if (!source && !line && entry.kind === 'markdown') return h('div', { className:'cx-file-markdown' }, h(MarkdownText, { text:entry.text }));
      if (typeof entry.text === 'string') return h('pre', { className:'cx-file-code', tabIndex:0 }, entry.text.split('\n').map((value,index) => h('div', { key:index, 'data-line':index+1, 'data-highlighted':Number(line) === index+1 }, h('span', { className:'cx-file-line', 'aria-hidden':true }, index+1), value || '\u200b')));
      return h('p', { className:'cx-file-empty' }, entry.truncated ? '文件较大，无法在面板中完整预览。' : '此文件格式暂不支持预览，可下载后打开。');
    }
    return h('section', { className:'cx-file-document', hidden:!active, 'aria-label':entry?.name ?? leaf(filePath) },
          h('div', { className:'cx-file-toolbar' }, h('nav', { className:'cx-file-breadcrumb', 'aria-label':'文件路径' }, h('button', { type:'button', onClick:()=>open(sessionId,'.') }, '工作区'), ...segments.map((segment,index)=>h('button', { key:index, type:'button', disabled:!entry, title:segments.slice(0,index+1).join('/'), onClick:()=>open(sessionId,segments.slice(0,index+1).join('/')) }, segment))),
            entry && !entry.entries && h('div', { className:'cx-file-actions' },
              typeof entry.text === 'string' && h('button', { type:'button', onClick:()=>setSource(!source), 'aria-pressed':source }, source ? '查看预览' : '查看源码'),
              h('button', { type:'button', onClick:cite }, getReferenceTarget?.(sessionId) ? (selection ? '引用选文到父会话' : '引用到父会话') : selection ? '引用选中文字' : '引用文件'),
              openNative && h('button', {type:'button',onClick:async()=>{try{await openNative(entry.absolutePath);}catch(reason){setError(reason?.message || '本机打开失败。');}}}, '在本机打开'),
              blobUrl && h('a', { href:blobUrl, download:entry.name }, '下载'))),
          error && h('p', { className:'cx-file-error', role:'alert' }, error),
          entry?.replacedNulls > 0 && h('p',{className:'cx-file-notice'},'原文件含不可见 NUL 字符，预览以 � 显示。'),
          entry?.truncated && h('p', { className:'cx-file-notice' }, entry.entries ? '当前显示前 500 项；筛选仅覆盖已加载的文件。可进入子文件夹继续浏览。' : `预览内容已截断，原文件 ${(entry.bytes/1024/1024).toFixed(1)} MB。`),
          h('div', { ref:body, className:'cx-file-body', onMouseUp:captureSelection, onKeyUp:captureSelection, onClick:event=>{
            if (!entry || entry.entries || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            const anchor = event.target.closest?.('a[href]');
            const local = parseLocalFileLink(anchor?.getAttribute('href'),entry.path);
            if (!local) return;
            event.preventDefault(); event.stopPropagation(); open(sessionId,local.path,local.line);
          } }, renderBody()));
  }
  function FileWorkspace({ sessionId }) {
    const state = React.useSyncExternalStore(subscribe, () => get(sessionId), () => empty);
    const paneState = pane?.usePane(sessionId);
    const visible = pane ? paneState.active === 'files' : state.open;
    const present = state.open || visible;
    const panelRef = React.useRef(null), tabsRef = React.useRef(null);
    const close = () => pane ? pane.close(sessionId, 'files') : update(sessionId, { open:false });
    const panelEvents = pane?.usePanel({sessionId,panelRef,present,visible,onClose:close});
    React.useEffect(() => {
      if (visible && !state.open) update(sessionId, {open:true});
      if (pane || !panelRef.current) return;
      if (visible) panelRef.current.show(); else panelRef.current.close();
    }, [visible, sessionId, state.open]);
    React.useEffect(() => {
      const rail = tabsRef.current, tab = rail?.querySelector?.('[data-active="true"]');
      if (pane || !visible || !tab) return;
      const edge = rail.getBoundingClientRect(), selected = tab.getBoundingClientRect();
      if (selected.left < edge.left) rail.scrollLeft += selected.left - edge.left;
      else if (selected.right > edge.right) rail.scrollLeft += selected.right - edge.right;
    }, [visible, state.path, state.tabs]);
    const paths = [...new Set([...state.tabs, state.path])];
    return h(React.Fragment, null,
      // Browsing starts in the shared work panel's Files tab; explicit file
      // links still open this same persistent view through open().
      present && h('dialog', { ref:panelRef, className:'cx-file-workspace cx-workbench-panel', 'data-open':visible ? 'true' : 'false', 'aria-label':'工作面板 · 文件', ...panelEvents },
        h('header', { className:'cx-file-header cx-workbench-header' }, h('strong', null, '工作面板'), h('button', { type:'button', onClick:close, 'aria-label':'关闭文件预览' }, '×')),
        pane && h(pane.Tabs, {sessionId}),
        !pane && state.tabs.length > 0 && h('nav', { ref:tabsRef, className:'cx-file-tabs', 'aria-label':'已打开文件' }, state.tabs.map(tab => h('div', { key:tab, 'data-active':tab === state.path },
          h('button', { type:'button', title:tab, 'aria-current':tab === state.path ? 'page' : undefined, onClick:()=>open(sessionId,tab) }, leaf(tab)),
          h('button', { type:'button', 'aria-label':`关闭 ${leaf(tab)}`, onClick:()=>closeTab(sessionId,tab) }, '×')))),
        h('div', {className:'cx-file-documents'}, paths.map(path => h(FileDocument, {key:`${sessionId}\u0000${path}`,sessionId,filePath:path,active:state.path===path,line:state.path===path ? state.line : undefined})))));
  }
  function setKnown(sessionId, paths) { knownFiles.set(sessionId, [...new Set(paths)].slice(-500)); }
  function resolveMention(sessionId, value) {
    const paths = knownFiles.get(sessionId) ?? [];
    const candidates = paths.includes(value) ? [value] : paths.filter(path => leaf(path) === value);
    if (candidates.length !== 1) return undefined;
    const path = candidates[0];
    return {open:()=>open(sessionId,path),title:path,label:`打开 ${path}`};
  }
  return { FileWorkspace, InputReferenceBridge, open, reference, safeHtml, setKnown, resolve:resolveMention, parseLocalFileLink };
}
