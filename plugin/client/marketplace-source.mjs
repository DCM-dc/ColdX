// Serialized into the DSH client; network/package operations stay in the native host service.
export function createMarketplaceComponents(React, primitives, api, options={}) {
  const h = React.createElement;
  const names = {installing:'正在安装',installed:'已安装',active:'已启用','needs-config':'需要配置','needs-restart':'需要重启',failed:'安装失败'};
  const installed = record => record && ['installed','active','needs-config','needs-restart'].includes(record.status);
  const keyFor = record => `${record.id}\n${record.packageId}`;
  const repairSession = record => record?.rootSessionId??record?.ownerSessionId;
  const updatedTime = value => typeof value==='number' && Number.isFinite(value) ? value : typeof value==='string' ? Date.parse(value) || 0 : 0;
  const message = error => typeof error?.message === 'string' ? error.message : '操作暂时无法完成，请重试。';
  const safeUrl = value => {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; }
    catch { return undefined; }
  };
  function Icon({kind='plugin',size=18}) {
    const paths = {
      plugin:'M9 3H4v5a2 2 0 1 1 0 4v5h5a2 2 0 1 0 4 0h5v-5a2 2 0 1 0 0-4V3h-5a2 2 0 1 1-4 0Z',
      close:'m6 6 12 12M18 6 6 18', search:'m20 20-4-4M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z',
      refresh:'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 11.5-1L20 9M4 15l2.5 3A7 7 0 0 0 18 17',
      arrow:'m14 6-6 6 6 6', external:'M13 5h6v6M19 5l-9 9M9 5H5v14h14v-4',
    };
    return h('svg',{width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.6,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true,focusable:false},h('path',{d:paths[kind]}));
  }
  function Link({url,children}) {
    const href = safeUrl(url);
    return href ? h('a',{href,target:'_blank',rel:'noopener noreferrer'},children,h(Icon,{kind:'external',size:13})) : null;
  }
  function Status({record,withMessage=true}) {
    if (!record) return null;
    return h('div',{className:'cx-marketplace-status','data-state':record.status,role:record.status==='failed'?'alert':'status'},
      h('span',{className:'cx-marketplace-status-label'},record.status==='installing' && h('span',{className:'cx-marketplace-spinner','aria-hidden':true}),names[record.status] ?? '状态待确认'),
      withMessage && record.message && h('p',null,record.message),
      withMessage && record.repairs?.length>0 && h('p',{className:'cx-marketplace-repair-status'},({queued:'AI 修复已排入原任务',running:'AI 正在诊断安装',completed:'AI 修复后已核实启用','needs-attention':'本轮修复尚未完成，请查看原任务'})[record.repairs.at(-1).status]));
  }

  function MarketplaceDialog({onClose,returnFocus,embedded=false}) {
    const dialog = React.useRef(null),searchInput = React.useRef(null),alive = React.useRef(true),busyKeys = React.useRef(new Set());
    const policyVersion = React.useRef(0),policyPending = React.useRef(false),catalogRefresh = React.useRef(0);
    const [query,setQuery] = React.useState(''),[page,setPage] = React.useState(1),[refresh,setRefresh] = React.useState(0);
    const [catalog,setCatalog] = React.useState({items:[],loading:true}),[selected,setSelected] = React.useState(null),[detail,setDetail] = React.useState(null);
    const [tab,setTab] = React.useState('discover'),[state,setState] = React.useState({installs:[],agentInstallEnabled:false}),[stateLoaded,setStateLoaded] = React.useState(false);
    const [stateError,setStateError] = React.useState(''),[actionErrors,setActionErrors] = React.useState({}),[busy,setBusy] = React.useState({}),[settingBusy,setSettingBusy] = React.useState(false);
    const acceptState = (snapshot, version=policyVersion.current, policyResult=false) => {
      if (!snapshot || !Array.isArray(snapshot.installs) || typeof snapshot.agentInstallEnabled !== 'boolean') throw new Error('插件状态未完整返回，请刷新。');
      if (!alive.current) return;
      setState(previous => {
        const records = new Map(previous.installs.map(record=>[keyFor(record),record]));
        for (const record of snapshot.installs) {
          const old = records.get(keyFor(record));
          // An earlier state response must not erase a job just accepted by install().
          if (!old || updatedTime(record.updatedAt) >= updatedTime(old.updatedAt)) records.set(keyFor(record),record);
        }
        return {...snapshot,agentInstallEnabled:policyResult || version===policyVersion.current && !policyPending.current ? snapshot.agentInstallEnabled : previous.agentInstallEnabled,installs:[...records.values()]};
      });
      setStateLoaded(true);setStateError('');
    };
    (React.useLayoutEffect ?? React.useEffect)(()=>{
      const node = dialog.current;alive.current = true;if(!embedded)node?.showModal();searchInput.current?.focus({preventScroll:true});
      return ()=>{alive.current=false;if(node?.open)node.close();returnFocus?.current?.focus?.({preventScroll:true});};
    },[]);
    React.useEffect(()=>{
      let disposed = false,current;
      const load = async()=>{
        if (disposed || current) return;
        current = new AbortController();const version=policyVersion.current;
        try {const value=await api('state',{},current.signal);if(!disposed)acceptState(value,version);}
        catch(error){if(!disposed && !current.signal.aborted)setStateError(message(error));}
        finally{current=null;}
      };
      load();const timer=setInterval(load,2000);
      return ()=>{disposed=true;clearInterval(timer);current?.abort();};
    },[refresh]);
    React.useEffect(()=>{
      const controller = new AbortController();
      setCatalog(previous=>({...previous,loading:true,error:''}));
      const timer = setTimeout(async()=>{
        try {
          const forceRefresh=catalogRefresh.current!==refresh;catalogRefresh.current=refresh;
          const result=await api('search',{query:query.trim(),page,refresh:forceRefresh},controller.signal);
          if(controller.signal.aborted)return;
          if(!Array.isArray(result?.items))throw new Error('插件目录未完整返回，请刷新。');
          setCatalog(previous=>({...result,loading:false,items:page===1?result.items:[...previous.items,...result.items.filter(item=>!previous.items.some(old=>old.id===item.id))]}));
        }catch(error){if(!controller.signal.aborted)setCatalog(previous=>({...previous,loading:false,error:message(error)}));}
      },query?220:0);
      return ()=>{clearTimeout(timer);controller.abort();};
    },[query,page,refresh]);
    React.useEffect(()=>{
      if(!selected){setDetail(null);return;}
      const controller=new AbortController();setDetail({id:selected,loading:true});
      api('detail',{id:selected},controller.signal).then(value=>{
        if(controller.signal.aborted)return;
        if(!value || !Array.isArray(value.packages))throw new Error('插件详情未完整返回，请重试。');
        setDetail({...value,loading:false});
      }).catch(error=>{if(!controller.signal.aborted)setDetail({id:selected,loading:false,error:message(error)});});
      return ()=>controller.abort();
    },[selected,refresh]);
    const getRecord = packageId => state.installs.find(record=>record.id===selected && record.packageId===packageId);
    async function installPackage(pkg) {
      const record=getRecord(pkg.id),id=keyFor({id:selected,packageId:pkg.id});
      if(!stateLoaded || !pkg.installable || installed(record) || record?.status==='installing' || busyKeys.current.has(id))return;
      busyKeys.current.add(id);setBusy(previous=>({...previous,[id]:true}));setActionErrors(previous=>({...previous,[id]:''}));
      try {
        const sessionId=options.getSessionId?.();
        const result=await api('install',{id:selected,packageId:pkg.id,...sessionId?{sessionId}:{}});
        if(!result || result.id!==selected || result.packageId!==pkg.id || !names[result.status])throw new Error('安装结果尚未确认，请刷新查看。');
        if(alive.current)setState(previous=>({...previous,installs:[...previous.installs.filter(old=>keyFor(old)!==id),result]}));
      }catch(error){if(alive.current)setActionErrors(previous=>({...previous,[id]:message(error)}));}
      finally{busyKeys.current.delete(id);if(alive.current)setBusy(previous=>({...previous,[id]:false}));}
    }
    async function repairPackage(pkg,record){
      const id=keyFor({id:selected,packageId:pkg?.id??'(repository)'}),sessionId=options.getSessionId?.();
      if(!sessionId){setActionErrors(previous=>({...previous,[id]:'请先打开一个会话，再让 AI 安装。'}));return;}
      if(repairSession(record)&&repairSession(record)!==sessionId){setActionErrors(previous=>({...previous,[id]:'请回到原任务后修复安装。'}));return;}
      if(!state.agentInstallEnabled||busyKeys.current.has(id))return;
      busyKeys.current.add(id);setBusy(previous=>({...previous,[id]:true}));setActionErrors(previous=>({...previous,[id]:''}));
      try{
        const request={sessionId,requestId:crypto.randomUUID(),...record?{jobId:record.jobId}:{id:selected,...pkg?{packageId:pkg.id}:{}}};
        const receipt=await api('repair',request);
        if(receipt?.ownerSessionId!==sessionId||typeof receipt.repairId!=='string')throw new Error('修复任务归属尚未确认，请刷新。');
        if(alive.current){acceptState(await api('state',{}));setActionErrors(previous=>({...previous,[id]:''}));}
      }catch(error){if(alive.current)setActionErrors(previous=>({...previous,[id]:message(error)}));}
      finally{busyKeys.current.delete(id);if(alive.current)setBusy(previous=>({...previous,[id]:false}));}
    }
    async function setAgentInstall(value) {
      if(policyPending.current || !stateLoaded)return;
      policyPending.current=true;const version=++policyVersion.current;setSettingBusy(true);
      try{acceptState(await api('setting',{agentInstallEnabled:value}),version,true);}
      catch(error){if(alive.current)setStateError(message(error));}
      finally{policyPending.current=false;if(alive.current)setSettingBusy(false);}
    }
    const selectTab = value => {setTab(value);setSelected(null);};
    const records = state.installs.filter(record=>tab==='installed' && [record.packageId,record.id,record.message].join(' ').toLowerCase().includes(query.trim().toLowerCase()));
    const refreshAll = ()=>{setPage(1);setRefresh(value=>value+1);};
    return h(embedded?'section':'dialog',{ref:dialog,className:'cx-marketplace-dialog','data-embedded':embedded,'aria-labelledby':'cx-marketplace-title','data-detail':Boolean(selected),onCancel:event=>{event.preventDefault();onClose();},onClick:event=>{
      if(event.target!==event.currentTarget)return;const bounds=event.currentTarget.getBoundingClientRect();
      if(event.clientX<bounds.left || event.clientX>bounds.right || event.clientY<bounds.top || event.clientY>bounds.bottom)onClose();
    }},
      h('header',{className:'cx-marketplace-header'},h('div',null,h('h2',{id:'cx-marketplace-title'},h(Icon,{size:21}),'插件市场'),h('p',null,'从 DSH 社区扩展你的工作能力。')),h('button',{type:'button',className:'cx-marketplace-icon-button','aria-label':'关闭插件市场',onClick:onClose},h(Icon,{kind:'close'}))),
      h('div',{className:'cx-marketplace-toolbar'},h('label',{className:'cx-marketplace-search'},h(Icon,{kind:'search',size:17}),h('input',{ref:searchInput,type:'search','aria-label':'搜索插件',placeholder:'搜索名称、描述或能力',value:query,onChange:event=>{setQuery(event.target.value);setPage(1);},maxLength:160})),h('button',{type:'button',className:'cx-marketplace-icon-button','aria-label':'刷新插件市场',onClick:refreshAll},h(Icon,{kind:'refresh'}))),
      h('div',{className:'cx-marketplace-navigation'},h('div',{role:'tablist','aria-label':'插件目录',onKeyDown:event=>{
        if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();
        const next=event.key==='Home'?'discover':event.key==='End'?'installed':tab==='discover'?'installed':'discover';selectTab(next);
        event.currentTarget.querySelector(`[data-market-tab="${next}"]`)?.focus();
      }},[['discover','发现'],['installed','已安装']].map(([id,label])=>h('button',{type:'button',key:id,role:'tab','data-market-tab':id,'aria-selected':tab===id,tabIndex:tab===id?0:-1,onClick:()=>selectTab(id)},label))),h(Link,{url:'https://github.com/topics/dsh-plugin'},'GitHub 社区')),
      stateError && h('div',{className:'cx-marketplace-notice',role:'alert'},stateError,h('button',{type:'button',onClick:refreshAll},'重试')),
      state.notice && h('div',{className:'cx-marketplace-notice',role:'status'},state.notice),
      h('div',{className:'cx-marketplace-body'},
        h('section',{className:'cx-marketplace-list','aria-label':tab==='discover'?'发现插件':'已安装插件','aria-busy':tab==='discover'&&catalog.loading},
          tab==='discover' ? h(React.Fragment,null,
            catalog.notice && h('p',{className:'cx-marketplace-notice',role:'status'},catalog.notice),
            catalog.stale && h('p',{className:'cx-marketplace-subtle'},'当前显示最近缓存的目录。'),
            catalog.error && h('div',{className:'cx-marketplace-empty',role:'alert'},catalog.error,h('button',{type:'button',onClick:refreshAll},'重新加载')),
            !catalog.items.length && !catalog.error && h('p',{className:'cx-marketplace-empty',role:'status'},catalog.loading?'正在读取社区目录…':'没有找到匹配的插件。'),
            catalog.items.map(repo=>h('button',{type:'button',key:repo.id,className:'cx-marketplace-repo','aria-label':`查看 ${repo.name}`,'aria-pressed':selected===repo.id,onClick:()=>setSelected(repo.id)},
              h('span',{className:'cx-marketplace-repo-icon'},h(Icon)),h('span',{className:'cx-marketplace-repo-copy'},h('strong',null,repo.name),h('span',{className:'cx-marketplace-description'},repo.description || '查看项目详情与可安装扩展'),h('span',{className:'cx-marketplace-meta'},repo.id,Number.isFinite(repo.stars)&&h('span',null,`☆ ${repo.stars}`))))),
            catalog.hasMore && h('button',{type:'button',className:'cx-marketplace-more',disabled:catalog.loading,onClick:()=>setPage(value=>value+1)},catalog.loading?'正在加载…':'加载更多')) : h(React.Fragment,null,
            !stateLoaded && h('p',{className:'cx-marketplace-empty',role:'status'},'正在读取安装状态…'),
            stateLoaded && !records.length && h('div',{className:'cx-marketplace-empty'},query?'没有匹配的安装记录。':'还没有安装社区插件。',!query&&h('button',{type:'button',onClick:()=>selectTab('discover')},'浏览社区插件')),
            records.map(record=>h('button',{type:'button',key:keyFor(record),className:'cx-marketplace-repo','aria-label':`查看 ${record.packageId}`,'aria-pressed':selected===record.id,onClick:()=>setSelected(record.id)},h('span',{className:'cx-marketplace-repo-icon'},h(Icon)),h('span',{className:'cx-marketplace-repo-copy'},h('strong',null,record.packageId),h('span',{className:'cx-marketplace-meta'},record.version || record.id),h(Status,{record,withMessage:false}))))
          )),
        h('section',{className:'cx-marketplace-detail','aria-label':'插件详情','aria-busy':Boolean(detail?.loading)},selected && h('button',{type:'button',className:'cx-marketplace-back','aria-label':'返回插件列表',onClick:()=>setSelected(null)},h(Icon,{kind:'arrow',size:16}),'返回'),
          !selected ? h('div',{className:'cx-marketplace-empty cx-marketplace-intro'},h(Icon,{size:32}),h('h3',null,'为工作流添加新能力'),h('p',null,'选择一个插件，查看介绍、发布包与安装状态。')) : detail?.loading ? h('p',{className:'cx-marketplace-empty',role:'status'},'正在读取插件详情…') : detail?.error ? h('div',{className:'cx-marketplace-empty',role:'alert'},detail.error,h('button',{type:'button',onClick:refreshAll},'重试详情')) : detail && h(React.Fragment,null,
            h('div',{className:'cx-marketplace-detail-title'},h('h3',null,detail.name),h(Link,{url:detail.url},'项目源码')),
            h('p',{className:'cx-marketplace-detail-description'},detail.description),detail.notice&&h('p',{className:'cx-marketplace-notice'},detail.notice),
            !detail.packages.length && h('div',{className:'cx-marketplace-notice'},h('p',null,'此项目还没有可直接安装的发布包。'),h('button',{type:'button',className:'cx-marketplace-ai-repair',disabled:!stateLoaded||!state.agentInstallEnabled||Boolean(busy[keyFor({id:selected,packageId:'(repository)'})]),onClick:()=>repairPackage(undefined,state.installs.find(item=>item.id===selected&&item.packageId==='(repository)'))},'让 AI 检查安装方法'),actionErrors[keyFor({id:selected,packageId:'(repository)'})]&&h('p',{role:'alert'},actionErrors[keyFor({id:selected,packageId:'(repository)'})])),
            detail.packages.map(pkg=>{
              const record=getRecord(pkg.id),id=keyFor({id:selected,packageId:pkg.id}),pending=busy[id] || record?.status==='installing';
              return h('article',{key:pkg.id,className:'cx-marketplace-package'},
                h('div',{className:'cx-marketplace-package-heading'},h('div',null,h('h4',null,pkg.name || pkg.id),h('span',{className:'cx-marketplace-meta'},pkg.version ? `v${pkg.version}` : '未发布',pkg.kind==='bundle'?' · 插件包':'')),
                  pkg.installable && !installed(record) && !pending && h('button',{type:'button',className:'cx-marketplace-install','aria-label':`${record?.status==='failed' || actionErrors[id]?'重试安装':'安装插件'} ${pkg.name || pkg.id}`,disabled:!stateLoaded,onClick:()=>installPackage(pkg)},record?.status==='failed' || actionErrors[id]?'重试安装':'安装'),
                  pending && !record && h('span',{role:'status',className:'cx-marketplace-pending'},'正在提交…')),
                pkg.description && h('p',null,pkg.description),!pkg.installable && h('p',{className:'cx-marketplace-unavailable'},pkg.reason || '暂不支持一键安装。'),
                h(Status,{record}),
                (!pkg.installable||record&&['failed','needs-config','needs-restart'].includes(record.status))&&h('div',{className:'cx-marketplace-repair-actions'},h('button',{type:'button',className:'cx-marketplace-ai-repair',disabled:!stateLoaded||!state.agentInstallEnabled||pending||record?.repairs?.some(item=>['queued','running'].includes(item.status)),onClick:()=>repairPackage(pkg,record)},record?'让 AI 修复安装':'让 AI 安装'),repairSession(record)&&options.openSession&&h('button',{type:'button',onClick:()=>{options.openSession(repairSession(record));onClose();}},'打开原任务')),
                actionErrors[id]&&h('p',{role:'alert',className:'cx-marketplace-error'},actionErrors[id]),
                record?.attempts?.length>0&&h('details',{className:'cx-marketplace-log'},h('summary',null,`之前的安装尝试（${record.attempts.length}）`),record.attempts.map(attempt=>h('div',{key:attempt.jobId},h('strong',null,attempt.version,' · ',names[attempt.status]??attempt.status),h('pre',null,attempt.log||attempt.message)))),
                h(Link,{url:pkg.sourceUrl},'发布信息'),record?.log&&h('details',{className:'cx-marketplace-log'},h('summary',null,'安装日志'),h('pre',null,record.log)));
            }),
            detail.readme && h('details',{className:'cx-marketplace-readme'},h('summary',null,'使用说明'),h('pre',null,detail.readme))
          )
        )
      ),
      h('footer',{className:'cx-marketplace-footer'},h('label',null,h('input',{type:'checkbox',checked:state.agentInstallEnabled,disabled:!stateLoaded||settingBusy,onChange:event=>setAgentInstall(event.target.checked)}),'允许 AI 按需安装插件'),h('span',null,'安装状态与 AI 共用；需要密钥的插件仍需配置。'))
    );
  }

  function MarketplaceEntry({wide=true}={}) {
    const [open,setOpen]=React.useState(false),trigger=React.useRef(null);
    return h('div',{className:'cx-marketplace-entry','data-wide':Boolean(wide)},
      h('button',{ref:trigger,type:'button',className:'cx-marketplace-trigger','aria-label':'插件市场','aria-haspopup':'dialog','aria-expanded':open,title:wide?undefined:'插件市场',onClick:()=>setOpen(true)},h(Icon,{size:18}),wide&&h('span',null,'插件市场')),
      open && h(MarketplaceDialog,{onClose:()=>setOpen(false),returnFocus:trigger}));
  }
  return {MarketplaceEntry,MarketplaceDialog};
}
