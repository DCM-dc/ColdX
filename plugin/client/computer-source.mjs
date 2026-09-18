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
    const [operation,setOperation]=React.useState(()=>({sessionId,pending:false,error:''}));
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
    const operationState=operation.sessionId===sessionId?operation:{pending:false,error:''};
    async function action(method,request={}) {
      const current=owner.current;if(!current || current.sessionId!==sessionId || !owns(current))return;
      if(current.actionPending && !['desktopStop','desktopPause'].includes(method) && !(method==='browserAction'&&request.action==='pause'))return;
      current.actionPending=true;setOperation({sessionId,pending:true,error:''});
      try {const result=await rpc(sessionId,method,request,current.controller.signal);if(!owns(current))return;acceptSnapshot(current,result);setOperation({sessionId,pending:false,error:''});return result;}
      catch(error){if(owns(current))setOperation({sessionId,pending:false,error:error?.message||'操作失败，请重新观察后重试。'});}
      finally{current.actionPending=false;}
    }
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
    return { snapshot, close, closing: closeState.pending, closeError: closeState.error,action,pending:operationState.pending,actionError:operationState.error };
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
  function ComputerWorkspace({sessionId,state,pane,view}) {
    const paneState=pane?.usePane?.(sessionId);
    const active=view??paneState?.active;
    const desktop=active==='desktop';const shown=active==='desktop'||active==='browser';
    const panelRef=React.useRef(null),pointer=React.useRef(null),imageRef=React.useRef(null),wheelRef=React.useRef(null),viewportRef=React.useRef(null);
    const [address,setAddress]=React.useState(''),[text,setText]=React.useState(''),[zoom,setZoom]=React.useState({key:'',actual:false});
    const snapshot=state?.snapshot??empty, browser=snapshot.browser??{tabs:[]}, control=snapshot.desktop??{};
    React.useEffect(()=>{setAddress(browser.url??'');},[sessionId,browser.url]);
    React.useEffect(()=>{setText('');pointer.current=null;},[sessionId,active]);
    const close=()=>pane?.close(sessionId,active);
    const panelEvents=pane?.usePanel?.({sessionId,panelRef,present:true,visible:shown,onClose:close});
    const run=(method,request)=>!snapshot.readOnly&&state?.action?.(method,request);
    const browserAction=request=>run('browserAction',request);
    const desktopAction=request=>run('desktopAction',{windowId:control.window?.id,observationId:control.observation?.id,...request});
    const paused=desktop?control.paused:browser.paused;
    const connected=desktop?control.active:browser.connected;
    const attachment=desktop?control.observation?.previewAttachment:browser.latestPreview;
    const imageUrl=previewUrl(attachment);
    const operating=desktop?Boolean(control.busy):snapshot.records.some(record=>record.surface!=='desktop'&&['running','stopping'].includes(record.status));
    const handingOver=paused&&(operating||state?.pending);
    const interactive=Boolean(!snapshot.readOnly && paused && !operating && !state?.pending && imageUrl && (!desktop || control.observation));
    const zoomKey=`${sessionId}:${active}:${desktop?control.window?.id:browser.activeTabId}`,actual=zoom.key===zoomKey&&zoom.actual;
    const viewportId=React.useId();
    (React.useLayoutEffect??React.useEffect)(()=>{const node=viewportRef.current;if(!node)return;node.scrollLeft=actual?Math.max(0,(node.scrollWidth-node.clientWidth)/2):0;node.scrollTop=actual?Math.max(0,(node.scrollHeight-node.clientHeight)/2):0;},[actual,zoomKey]);
    const imagePoint=(event)=>{const rect=event.currentTarget.getBoundingClientRect(),image=event.currentTarget;return {x:Math.max(0,Math.min(image.naturalWidth-1,Math.floor((event.clientX-rect.left)/rect.width*image.naturalWidth))),y:Math.max(0,Math.min(image.naturalHeight-1,Math.floor((event.clientY-rect.top)/rect.height*image.naturalHeight)))};};
    const input=request=>desktop?desktopAction(request):browserAction(request);
    wheelRef.current=event=>{if(!interactive)return;event.preventDefault();input({action:'scroll',...desktop?imagePoint(event):{},deltaX:Math.round(Math.max(-2400,Math.min(2400,event.deltaX))),deltaY:Math.round(Math.max(-2400,Math.min(2400,event.deltaY)))});};
    React.useEffect(()=>{const node=imageRef.current;if(!node)return;const wheel=event=>wheelRef.current?.(event);node.addEventListener('wheel',wheel,{passive:false});return()=>node.removeEventListener('wheel',wheel);},[imageUrl,active]);
    const key=event=>{
      if(!interactive||event.isComposing||['Control','Alt','Shift','Meta'].includes(event.key))return;
      const modifiers=[event.ctrlKey?'Control':null,event.altKey?'Alt':null,event.shiftKey?'Shift':null,event.metaKey?'Meta':null].filter(Boolean);
      if(event.key.length===1 && !/[a-z0-9 ]/i.test(event.key) && !event.ctrlKey&&!event.altKey&&!event.metaKey){event.preventDefault();input({action:'type',text:event.key});return;}
      const value=event.key===' '?'Space':event.key.length===1?event.key.toUpperCase():event.key;
      if(!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-2]))$/.test(value)&&!['Enter','Escape','Tab','Backspace','Delete','Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(value))return;
      event.preventDefault();input(desktop?{action:'key',keys:[...modifiers,value]}:{action:'key',key:[...modifiers,value].join('+')});
    };
    const button=(label,onClick,disabled=false,extra={})=>h('button',{type:'button',onClick,disabled:disabled||Boolean(snapshot.readOnly),...extra},label);
    const body=h('div',{className:'cx-computer-workspace-body'},
      h('div',{className:'cx-computer-toolbar'},h('span',{className:'cx-computer-state',role:'status'},snapshot.readOnly?'子任务已结束 · 历史记录':connected?(handingOver?'等待当前操作完成':paused?'由你操作':'AI 可操作'):desktop?'尚未连接电脑':'独立浏览器'),
        connected&&button(paused?'交回 AI':'手动接管',()=>desktop?run('desktopPause',{paused:!paused}):browserAction({action:'pause',paused:!paused}),handingOver,{'aria-pressed':Boolean(paused)}),
        connected&&button('停止',()=>desktop?run('desktopStop'):state.close(),false,{className:'cx-computer-stop'})),
      desktop?h('div',{className:'cx-desktop-target'},
        snapshot.capabilities?.desktop?.available===false?h('p',{role:'status'},snapshot.capabilities.desktop.reason):
          h(React.Fragment,null,button(control.active?'刷新窗口':'连接电脑并列出窗口',async()=>{if(!control.active)await run('desktopEnable');await run('desktopWindows');},state?.pending),
            h('label',null,h('span',null,'操作窗口'),h('select',{'aria-label':'选择电脑窗口',value:control.window?.id??'',disabled:snapshot.readOnly||state?.pending||!control.active,onChange:event=>desktopAction({action:'focus',windowId:event.target.value})},h('option',{value:''},'选择运行中的应用'),(control.windows??[]).map(window=>h('option',{key:window.id,value:window.id},`${window.processName} · ${window.title}`)))),
            control.window&&h('div',{className:'cx-computer-target-name'},h('strong',null,control.window.title),button('重新观察',()=>run('desktopObserve',{windowId:control.window.id}),state?.pending)))):
        h(React.Fragment,null,
          h('div',{className:'cx-browser-tabs',role:'tablist','aria-label':'浏览器标签页'},(browser.tabs??[]).map(tab=>h('div',{key:tab.id,className:'cx-browser-tab'},button(tab.title||tab.url||'新标签页',()=>browserAction({action:'select',index:tab.index}),state?.pending,{role:'tab','aria-selected':tab.active,title:tab.url}),button('×',()=>browserAction({action:'closeTab',index:tab.index}),state?.pending,{'aria-label':`关闭标签页 ${tab.title||tab.index+1}`}))),button('+',()=>browserAction({action:'new'}),state?.pending,{'aria-label':'新建浏览器标签页'})),
          h('form',{className:'cx-browser-navigation',onSubmit:event=>{event.preventDefault();let url=address.trim();if(!/^https?:\/\//i.test(url)&&url!=='about:blank')url='https://'+url;browserAction({action:'navigate',url});}},
            button('←',()=>browserAction({action:'back'}),state?.pending||!browser.tabs?.length,{'aria-label':'浏览器后退'}),button('→',()=>browserAction({action:'forward'}),state?.pending||!browser.tabs?.length,{'aria-label':'浏览器前进'}),button('↻',()=>browserAction({action:'reload'}),state?.pending||!browser.tabs?.length,{'aria-label':'刷新网页'}),
            h('input',{type:'text',value:address,onChange:event=>setAddress(event.target.value),placeholder:'输入网址','aria-label':'浏览器地址',spellCheck:false,disabled:snapshot.readOnly}),h('button',{type:'submit',disabled:snapshot.readOnly||state?.pending||!address.trim()},'前往'))),
      (state?.actionError||state?.closeError||snapshot.error||control.error)&&h('p',{className:'cx-computer-error',role:'alert'},state.actionError||state.closeError||snapshot.error||control.error),
      imageUrl?h(React.Fragment,null,h('div',{className:'cx-computer-zoom-controls'},h('span',null,actual?'原尺寸 · 可滚动查看':'适合宽度'),button(actual?'适合宽度':'100%',()=>setZoom({key:zoomKey,actual:!actual}),false,{disabled:false,'aria-label':actual?'截图适合宽度':'按原尺寸查看截图','aria-pressed':actual,'aria-controls':viewportId})),
        h('div',{id:viewportId,ref:viewportRef,role:'region','aria-label':actual?'截图原尺寸，可使用滚动条或方向键查看':'截图适合宽度',tabIndex:actual?0:-1,className:'cx-computer-live-frame','data-interactive':interactive,'data-zoom':actual?'actual':'fit'},h('img',{ref:imageRef,src:imageUrl,alt:desktop?'所选窗口的可见屏幕截图':'当前浏览器页面截图',draggable:false,tabIndex:interactive?0:-1,onKeyDown:key,
        onPointerDown:event=>{if(!interactive)return;event.preventDefault();event.currentTarget.focus();pointer.current=imagePoint(event);event.currentTarget.setPointerCapture?.(event.pointerId);},
        onPointerUp:event=>{if(!interactive||!pointer.current)return;const start=pointer.current;pointer.current=null;const end=imagePoint(event);input(Math.hypot(start.x-end.x,start.y-end.y)>8?{action:'drag',...start,endX:end.x,endY:end.y}:{action:'click',...end});},
        onPointerCancel:()=>{pointer.current=null;}}))):
        h('div',{className:'cx-computer-empty'},h('strong',null,desktop?'选择一个应用窗口':'在这里查看浏览器操作'),h('p',null,desktop?'连接后可观察画面、让 AI 操作，也可以随时接管。':'打开网页后，页面画面与操作记录会显示在这里。')),
      connected&&h('p',{className:'cx-computer-caption'},desktop?'可见屏幕截图 · 遮挡窗口会出现在画面中 · 停止不会关闭你的软件':'独立会话 · 画面在操作完成后更新',paused?' · 点击画面定位，拖动或使用键盘操作':''),
      interactive&&h('form',{className:'cx-computer-text-input',onSubmit:async event=>{event.preventDefault();if(!text)return;await input({action:'type',text});setText('');}},h('input',{'aria-label':'向所选输入框键入文字',value:text,onChange:event=>setText(event.target.value),placeholder:'先点击画面中的输入框，再输入文字',maxLength:20000}),h('button',{type:'submit',disabled:state?.pending||!text},'键入')),
      h('details',{className:'cx-computer-history'},h('summary',null,'最近操作'),h('ol',null,snapshot.records.filter(record=>record.surface===(desktop?'desktop':'browser')||(!desktop&&!record.surface)).slice(-12).reverse().map(record=>h('li',{key:record.callId},h('span',null,record.surfaceLabel),h('small',null,{running:'进行中',stopping:'停止中',completed:'完成',failed:'失败',cancelled:'已取消'}[record.status]||record.status))))));
    if(!pane)return shown?h('section',{className:'cx-computer-workspace','aria-label':desktop?'电脑操作':'浏览器操作'},body):null;
    return h('dialog',{ref:panelRef,className:'cx-workbench-panel cx-computer-workspace','data-open':shown?'true':'false','aria-label':desktop?'电脑工作面板':'浏览器工作面板',...panelEvents},
      h('header',{className:'cx-workbench-header'},h('strong',null,'工作面板'),button('×',close,false,{'aria-label':'关闭工作面板',disabled:false})),h(pane.Tabs,{sessionId}),shown&&body);
  }
  return { useComputer, ComputerStatus, ComputerPreview, ComputerWorkspace, previewUrl };
}
