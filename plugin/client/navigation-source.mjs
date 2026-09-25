// Presentation over native DSH session/workspace services. No duplicate runtime.
export function createWorkbenchNavigation(React,ctx,{icon,api,Marketplace,Usage,files,pane}) {
  const h=React.createElement,listeners=new Set();let page=null,paletteOrigin=null,paletteReturnPage=null;
  const navigate=value=>{page=value;for(const listener of listeners)listener();};
  const openPalette=trigger=>{
    if(page==='search'){document.querySelector('.cx-command-search input')?.focus();return;}
    paletteOrigin=trigger??document.activeElement;paletteReturnPage=page;navigate('search');
  };
  const closePalette=(restoreFocus=true)=>{
    const origin=paletteOrigin,returnPage=restoreFocus?paletteReturnPage:null;
    document.querySelector('.cx-command-overlay[open]')?.close();
    paletteOrigin=null;paletteReturnPage=null;navigate(returnPage);
    if(restoreFocus)queueMicrotask(()=>{
      if(origin?.isConnected&&origin!==document.body&&origin!==document.documentElement)origin.focus({preventScroll:true});
      else document.querySelector('.cx-navigation-search, .cx-rebuild-icon[aria-label="搜索与命令"], .cx-workbench-page button, .cx-rebuild-sidebar button')?.focus({preventScroll:true});
    });
  };
  const showPage=id=>{paletteOrigin=null;paletteReturnPage=null;navigate(id);};
  const subscribe=listener=>{listeners.add(listener);return()=>listeners.delete(listener);};
  const usePage=()=>React.useSyncExternalStore(subscribe,()=>page,()=>null);
  const preference=ctx.settingsScope.bind({namespace:'coldx-navigation',decode:value=>value&&Array.isArray(value.pinned)?{pinned:value.pinned.filter(x=>typeof x==='string')}:undefined});
  const subscribePreferences=listener=>preference.subscribe(listener),readPreferences=()=>preference.getSnapshot();
  const usePreferences=()=>React.useSyncExternalStore(subscribePreferences,readPreferences,readPreferences);
  const useList=()=>React.useSyncExternalStore(ctx.sessions.list.subscribe,ctx.sessions.list.getSnapshot,ctx.sessions.list.getSnapshot);
  const useSpaces=()=>React.useSyncExternalStore(ctx.workspaces.list.subscribe,ctx.workspaces.list.getSnapshot,ctx.workspaces.list.getSnapshot);
  function open(id){navigate(null);ctx.sessions.open(id);}
  function Nav({wide=true}) {
    const active=usePage(),[more,setMore]=React.useState(false);
    const button=(id,label,glyph)=>h('button',{key:id,type:'button',className:'cx-rebuild-nav','aria-current':active===id?'page':undefined,title:wide?undefined:label,onClick:()=>{setMore(false);navigate(id);}},icon(glyph),wide&&h('span',null,label));
    return h(React.Fragment,null,
      h('button',{type:'button',className:'cx-navigation-search cx-rebuild-icon','aria-label':'搜索与命令',title:'搜索与命令 · Ctrl+K',onClick:event=>openPalette(event.currentTarget)},icon('search')),
      button('pullRequests','Pull Request','branch'),button('schedules','定时任务','clock'),button('plugins','插件','plugin'),
      h('div',{className:'cx-navigation-more'},h('button',{type:'button',className:'cx-rebuild-nav','aria-expanded':more,onClick:()=>setMore(!more)},icon('more'),wide&&h('span',null,'探索')),
        more&&h('div',{className:'cx-navigation-popover',onKeyDown:event=>{if(event.key==='Escape')setMore(false);}},button('usage','用量与活动','chart'),h('button',{type:'button',className:'cx-rebuild-nav',onClick:()=>{setMore(false);navigate(null);const id=ctx.sessions.list.getSnapshot().current;if(id)files.open(id,'.');}},icon('file'),'工作区文件'))));
  }
  function TaskList({wide=true}) {
    const sessions=useList(),spaces=useSpaces(),prefs=usePreferences(),pins=prefs.value?.pinned??[];
    const [menu,setMenu]=React.useState(null),[editing,setEditing]=React.useState(null),[title,setTitle]=React.useState(''),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false),[expanded,setExpanded]=React.useState({});
    const menuRef=React.useRef(null);
    React.useEffect(()=>{if(!menu)return;menuRef.current?.querySelector('[role="menuitem"]')?.focus();const dismiss=event=>{if(!menuRef.current?.contains(event.target))setMenu(null);};document.addEventListener('pointerdown',dismiss);return()=>document.removeEventListener('pointerdown',dismiss);},[menu]);
    const perform=fn=>async()=>{if(busy)return;setBusy(true);setError('');try{await fn();setMenu(null);}catch(e){setError(e.message||'操作失败，请重试。');}finally{setBusy(false);}};
    const archived=new Set(spaces.archivedSessionIds),rows=sessions.ids.map(id=>sessions.byId[id]).filter(row=>row&&!row.parentId&&row.origin!=='subagent'&&!archived.has(row.id)&&(!row.blank||row.id===sessions.current));
    const row=item=>h('div',{key:item.id,className:'cx-navigation-task','data-selected':sessions.current===item.id,onContextMenu:event=>{event.preventDefault();setMenu({id:item.id,trigger:event.currentTarget.querySelector('button'),x:Math.min(event.clientX,window.innerWidth-250),y:Math.min(event.clientY,window.innerHeight-310)});}},
      h('button',{type:'button',onClick:()=>open(item.id),title:item.displayTitle,'aria-current':sessions.current===item.id?'page':undefined},h('span',null,item.displayTitle||'新对话'),item.running?h('span',{className:'cx-navigation-running','aria-label':'运行中'}):item.pendingInteraction?h('span',{className:'cx-navigation-wait','aria-label':'等待确认'},'●'):null),
      h('button',{type:'button',className:'cx-navigation-task-menu','aria-label':`${item.displayTitle} 的操作`,onClick:event=>{const box=event.currentTarget.getBoundingClientRect();setMenu({id:item.id,trigger:event.currentTarget,x:Math.min(box.right,window.innerWidth-250),y:Math.min(box.top,window.innerHeight-310)});}},icon('more')));
    const label=(text,action)=>h('div',{className:'cx-navigation-section'},h('span',null,text),action);
    const addProject=perform(async()=>{const path=await ctx.workspaces.pickDirectory();if(path)await ctx.workspaces.create({path});});
    const selected=menu&&sessions.byId[menu.id];
    if(!wide)return h('button',{type:'button',className:'cx-rebuild-icon','aria-label':'搜索与命令',onClick:event=>openPalette(event.currentTarget)},icon('search'));
    return h('div',{className:'cx-navigation-tree'},
      pins.some(id=>rows.some(row=>row.id===id))&&h('section',null,label('置顶'),pins.map(id=>rows.find(item=>item.id===id)).filter(Boolean).map(row)),
      h('section',null,label('项目',h('button',{type:'button',className:'cx-rebuild-icon','aria-label':'添加项目',onClick:addProject,disabled:busy},icon('plus'))),
        !spaces.items.length&&h('p',{className:'cx-navigation-empty'},'没有项目'),spaces.items.map(space=>h('div',{key:space.workspaceId},h('div',{className:'cx-navigation-project'},h('button',{type:'button','aria-expanded':Boolean(expanded[space.workspaceId]),onClick:()=>setExpanded({...expanded,[space.workspaceId]:!expanded[space.workspaceId]})},icon('folder'),h('span',null,space.title||space.path?.split(/[\\/]/).pop()||'项目')),h('button',{type:'button',className:'cx-rebuild-icon','aria-label':`在 ${space.title||'项目'} 中新建对话`,onClick:()=>{navigate(null);ctx.workspaces.startSession(space.workspaceId);}},icon('plus'))),expanded[space.workspaceId]&&h('div',{className:'cx-navigation-project-tasks'},rows.filter(item=>space.sessionIds?.includes(item.id)).map(row))))),
      h('section',null,label('最近'),rows.filter(item=>!pins.includes(item.id)).sort((a,b)=>b.updatedAt-a.updatedAt).map(row)),
      error&&h('p',{role:'alert',className:'cx-navigation-error'},error),
      selected&&h('div',{ref:menuRef,className:'cx-navigation-context',role:'menu','aria-label':'会话操作',style:{left:menu.x,top:menu.y},onKeyDown:event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();menu.trigger?.focus?.();setMenu(null);}else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const items=[...event.currentTarget.querySelectorAll('[role="menuitem"]:not(:disabled)')],index=items.indexOf(document.activeElement);items[event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:items.length-1))%items.length]?.focus();}}},
        [['重命名','edit',()=>{setEditing(selected.id);setTitle(selected.displayTitle);setMenu(null);}],
          [pins.includes(selected.id)?'取消置顶':'置顶','pin',async()=>{await preference.set('pinned',pins.includes(selected.id)?pins.filter(id=>id!==selected.id):[...pins,selected.id]);const result=preference.getSnapshot();if(result.error)throw Error(result.error.message||'置顶未能保存，请重试。');}],
          ['归档','archive',()=>ctx.workspaces.archiveSession(selected.id)],
          ['分叉对话','branch',async()=>open(await ctx.sessions.fork({sessionId:selected.id,increaseTitle:true}))],
          ['复制会话 ID','copy',()=>navigator.clipboard.writeText(selected.id)]].map(([text,glyph,action])=>h('button',{type:'button',key:text,role:'menuitem',disabled:busy,onClick:perform(action)},icon(glyph),text))),
      editing&&h('form',{className:'cx-navigation-rename',onSubmit:event=>{event.preventDefault();perform(async()=>{const result=await ctx.sessions.binding(editing)?.session.rename(title.trim());if(!result?.ok)throw Error(result?.error?.message||'重命名失败。');setEditing(null);})();}},h('label',null,'重命名对话',h('input',{autoFocus:true,value:title,onChange:event=>setTitle(event.target.value),maxLength:200})),h('div',null,h('button',{type:'button',onClick:()=>setEditing(null)},'取消'),h('button',{type:'submit',disabled:busy||!title.trim()},'保存'))));
  }
  function useLoad(method,request,key){
    const [state,setState]=React.useState({loading:true}),[revision,refresh]=React.useState(0);
    React.useEffect(()=>{const controller=new AbortController();setState({loading:true});api(method,request,controller.signal).then(data=>{if(!controller.signal.aborted)setState({data});},error=>{if(!controller.signal.aborted)setState({error:error.message});});return()=>controller.abort();},[key,revision]);
    return [state,()=>refresh(value=>value+1)];
  }
  function intro(eyebrow,title,description,actions) {
    return h('div',{className:'cx-page-heading cx-navpage-heading'},
      h('div',{className:'cx-navpage-heading-copy'},h('span',{className:'cx-navpage-eyebrow'},eyebrow),
        h('h1',null,title),description&&h('p',null,description)),
      actions&&h('div',{className:'cx-navpage-heading-actions'},actions));
  }
  function empty(glyph,title,description,action) {
    return h('div',{className:'cx-page-empty cx-navpage-empty'},h('span',{className:'cx-navpage-empty-icon','aria-hidden':true},icon(glyph)),
      h('strong',null,title),h('p',null,description),action);
  }
  function status(message,kind='loading',action) {
    return h('div',{className:'cx-navpage-status','data-kind':kind,role:kind==='error'?'alert':'status'},
      kind==='loading'?h('span',{className:'cx-navpage-spinner','aria-hidden':true}):icon(kind==='error'?'close':'file'),
      h('span',null,message),action);
  }
  function safeExternalUrl(value) {
    try { const url=new URL(value);return url.protocol==='https:'||url.protocol==='http:'?url.href:null; }
    catch { return null; }
  }
  function Search(){
    const [query,setQuery]=React.useState(''),[matches,setMatches]=React.useState(null),
      [loading,setLoading]=React.useState(false),[revision,refresh]=React.useState(0),
      [selected,setSelected]=React.useState(0),[error,setError]=React.useState(''),
      [fileMatches,setFileMatches]=React.useState({owner:null,query:'',items:[]}),[fileLoading,setFileLoading]=React.useState(false),[fileError,setFileError]=React.useState(''),
      sessions=useList(),spaces=useSpaces(),searchRef=React.useRef(null),commandBusy=React.useRef(false);
    React.useEffect(()=>{searchRef.current?.focus({preventScroll:true});},[]);
    React.useEffect(()=>{
      setMatches(null);setLoading(Boolean(query.trim()));
      if(!query.trim())return;
      const controller=new AbortController();
      const timer=setTimeout(()=>ctx.sessions.search(query,controller.signal).then(value=>{
        if(!controller.signal.aborted){setMatches(value);setLoading(false);}
      },error=>{
        if(!controller.signal.aborted){setMatches({ok:false,error:{message:error.message}});setLoading(false);}
      }),180);
      return()=>{clearTimeout(timer);controller.abort();};
    },[query,revision]);
    React.useEffect(()=>{
      setFileMatches({owner:null,query:'',items:[]});setFileError('');setFileLoading(false);
      const owner=sessions.current;
      if(!query.trim()||!owner||ctx.sessions.subagentAddress?.(owner))return;
      const controller=new AbortController();setFileLoading(true);
      const timer=setTimeout(()=>{
        Promise.resolve().then(()=>ctx.remote.fileReferences.list(owner,query.trim(),controller.signal)).then(receipt=>{
          if(controller.signal.aborted)return;
          if(!receipt?.ok||!Array.isArray(receipt.value))throw Error(receipt?.error?.message||'文件搜索失败。');
          setFileMatches({owner,query:query.trim(),items:receipt.value.filter(item=>item.kind==='file'&&typeof item.path==='string').slice(0,12)});setFileLoading(false);
        }).catch(reason=>{if(!controller.signal.aborted){setFileError(reason?.message||'文件搜索失败。');setFileLoading(false);}});
      },120);
      return()=>{clearTimeout(timer);controller.abort();};
    },[query,sessions.current,revision]);
    const archived=new Set(spaces.archivedSessionIds??[]);
    const recent=sessions.ids.map(id=>sessions.byId[id]).filter(row=>row&&!row.blank&&!row.parentId&&row.origin!=='subagent'&&!archived.has(row.id))
      .sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
    const term=query.trim().toLocaleLowerCase();
    const titleMatches=term?recent.filter(row=>row.displayTitle?.toLocaleLowerCase().includes(term)):[];
    const ids=term?[...new Set([...titleMatches.map(item=>item.id),...(matches?.ok?matches.value.items.map(item=>item.sessionId):[])])]:
      recent.slice(0,8).map(item=>item.id);
    const sessionItems=ids.filter(id=>!archived.has(id)).map(id=>{
      const row=sessions.byId[id],found=matches?.ok&&matches.value.items.find(item=>item.sessionId===id);
      return {key:`session-${id}`,group:'会话',label:row?.displayTitle||id,detail:found?.snippet,id,
        glyph:'chat',run:()=>{ctx.sessions.open(id);closePalette(false);}};
    });
    const currentFiles=fileMatches.owner===sessions.current&&fileMatches.query===query.trim()?fileMatches.items:[];
    const fileItems=currentFiles.map(item=>({key:`file-${item.path}`,label:item.path.split(/[\\/]/).pop()||item.path,
      detail:item.path,path:item.path,glyph:'file',run:async()=>{await files.open(sessions.current,item.path);closePalette(false);}}));
    const commands=[
      {key:'new',label:'新对话',detail:'在当前工作区开始',glyph:'edit',run:async()=>{await ctx.workspaces.startSession();closePalette(false);}},
      {key:'add-project',label:'添加项目',detail:'选择本机文件夹',glyph:'folder',run:async()=>{const path=await ctx.workspaces.pickDirectory();if(path){await ctx.workspaces.create({path});closePalette(false);}}},
      ...spaces.items.map(space=>({key:`project-${space.workspaceId}`,label:`在 ${space.title||space.path?.split(/[\\/]/).pop()||'项目'} 中新建对话`,detail:space.path,glyph:'folder',run:async()=>{await ctx.workspaces.startSession(space.workspaceId);closePalette(false);}})),
      {key:'pullRequests',label:'Pull Request',glyph:'branch',run:()=>showPage('pullRequests')},
      {key:'schedules',label:'定时任务',glyph:'clock',run:()=>showPage('schedules')},
      {key:'plugins',label:'插件',glyph:'plugin',run:()=>showPage('plugins')},
      {key:'usage',label:'用量与活动',glyph:'chart',run:()=>showPage('usage')},
    ].filter(item=>!term||`${item.label} ${item.detail||''}`.toLocaleLowerCase().includes(term));
    const items=[...sessionItems,...fileItems,...commands],active=Math.min(selected,items.length-1);
    const execute=item=>{
      if(!item||commandBusy.current)return;
      commandBusy.current=true;
      setError('');
      try{Promise.resolve(item.run()).then(()=>{commandBusy.current=false;},problem=>{
        commandBusy.current=false;setError(problem?.message||'操作失败，请重试。');
      });}
      catch(problem){commandBusy.current=false;setError(problem?.message||'操作失败，请重试。');}
    };
    const keyDown=event=>{
      if(event.nativeEvent?.isComposing||event.isComposing)return;
      if(event.key==='ArrowDown'||event.key==='ArrowUp'||event.key==='Home'||event.key==='End'){
        event.preventDefault();
        setSelected(value=>event.key==='Home'?0:event.key==='End'?Math.max(0,items.length-1):Math.max(0,Math.min(items.length-1,value+(event.key==='ArrowDown'?1:-1))));
      }else if(event.key==='Enter'){
        event.preventDefault();execute(items[active]);
      }else if(event.key==='Escape'){
        event.preventDefault();event.stopPropagation();closePalette();
      }
    };
    const renderItem=(item,index)=>h('button',{key:item.key,id:`cx-command-${index}`,type:'button',role:'option','aria-selected':active===index,
      'aria-label':item.path?`文件：${item.path}`:item.detail?`${item.label}，${item.detail}`:item.label,
      'data-session-id':item.id,'data-file-path':item.path,className:'cx-command-row',onMouseEnter:()=>setSelected(index),onClick:()=>execute(item)},
      h('span',{className:'cx-command-icon'},icon(item.glyph)),
      h('span',{className:'cx-command-copy'},h('span',{className:'cx-command-title'},item.label),item.detail&&h('small',null,item.detail)),
      item.shortcut&&h('kbd',null,item.shortcut),icon('chevron'));
    return h('div',{className:'cx-command-content'},
      h('div',{className:'cx-command-search'},icon('search'),
        h('input',{ref:searchRef,type:'search',role:'combobox','aria-label':'搜索会话与命令','aria-controls':'cx-command-results',
          'aria-expanded':true,'aria-autocomplete':'list','aria-activedescendant':items.length?`cx-command-${active}`:undefined,
          autoFocus:true,placeholder:'搜索会话、项目与命令',value:query,onChange:event=>{setQuery(event.target.value);setSelected(0);},onKeyDown:keyDown})),
      h('div',{className:'cx-command-results',id:'cx-command-results',role:'listbox','aria-label':'搜索结果'},
        sessionItems.length>0&&h('div',{className:'cx-command-group',role:'group','aria-label':term?'搜索结果':'最近会话'},
          h('div',{className:'cx-command-group-title'},term?'搜索结果':'最近会话'),sessionItems.map((item,index)=>renderItem(item,index))),
        fileItems.length>0&&h('div',{className:'cx-command-group',role:'group','aria-label':'工作区文件'},
          h('div',{className:'cx-command-group-title'},'工作区文件'),fileItems.map((item,index)=>renderItem(item,sessionItems.length+index))),
        commands.length>0&&h('div',{className:'cx-command-group',role:'group','aria-label':'命令'},
          h('div',{className:'cx-command-group-title'},'命令'),commands.map((item,index)=>renderItem(item,sessionItems.length+fileItems.length+index))),
        !items.length&&!loading&&!fileLoading&&h('p',{className:'cx-command-empty'},'没有找到匹配的会话、文件或命令。')),
      (loading||fileLoading||matches?.ok===false||fileError||error||matches?.ok&&matches.value.hasMore)&&h('div',{className:'cx-command-status',role:matches?.ok===false||fileError||error?'alert':'status'},
        error||fileError&&`文件搜索失败：${fileError}${sessionItems.length?'；会话结果仍可使用。':''}`||matches?.ok===false&&`会话搜索失败：${matches.error?.message||'请重试。'}${fileItems.length?'；文件结果仍可使用。':''}`||(loading||fileLoading)&&'正在搜索…'||'结果较多，请缩小搜索范围。',
        (matches?.ok===false||fileError)&&h('button',{type:'button',onClick:()=>refresh(value=>value+1)},'重试')),
      h('div',{className:'cx-command-footer'},h('span',null,'↑↓ 选择'),h('span',null,'Enter 打开'),h('span',null,'Esc 关闭')));
  }
  function Schedules(){
    const [state,refresh]=useLoad('schedules',{},'schedules'),sessions=useList();
    const [query,setQuery]=React.useState(''),[create,setCreate]=React.useState(false),
      [owner,setOwner]=React.useState(sessions.current||''),[prompt,setPrompt]=React.useState(''),
      [frequency,setFrequency]=React.useState('daily'),
      [date,setDate]=React.useState(()=>{
        const time=new Date(Date.now()+300000);
        return new Date(time.getTime()-time.getTimezoneOffset()*60000).toISOString().slice(0,16);
      }),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false);
    const refreshRef=React.useRef(refresh);refreshRef.current=refresh;
    React.useEffect(()=>{
      const update=()=>{if(document.visibilityState==='visible')refreshRef.current();};
      const timer=setInterval(update,30000);
      document.addEventListener('visibilitychange',update);
      return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',update);};
    },[]);
    const submit=async request=>{
      if(busy)return;setBusy(true);setError('');
      try { await api('schedule',request);refresh();setCreate(false);setPrompt(''); }
      catch(e) { setError(e.message||'操作失败，请重试。'); }
      finally { setBusy(false); }
    };
    const items=state.data?.items??[],term=query.trim().toLocaleLowerCase(),
      visible=items.filter(item=>((item.prompt||'')+' '+(item.title||'')).toLocaleLowerCase().includes(term));
    const sessionOptions=sessions.ids.map(id=>sessions.byId[id]).filter(item=>item&&!item.parentId);
    return h('div',{className:'cx-navpage cx-navpage-schedules'},
      intro('自动化','定时任务','让会话按约定时间继续工作',
        h(React.Fragment,null,
          h('button',{type:'button',className:'cx-navpage-icon-button','aria-label':'刷新定时任务',onClick:refresh},icon('refresh')),
          h('button',{type:'button',className:'cx-page-primary cx-navpage-primary',onClick:()=>{setError('');setCreate(true);}},icon('plus'),'新建任务'))),
      h('div',{className:'cx-navpage-overview'},h('span',null,h('strong',null,items.length),' 已安排'),
        h('span',null,h('strong',null,items.filter(item=>item.live).length),' 个所属会话已加载')),
      h('div',{className:'cx-navpage-searchbox cx-navpage-filter'},icon('search'),
        h('input',{type:'search',placeholder:'筛选定时任务','aria-label':'搜索已安排任务',value:query,onChange:event=>setQuery(event.target.value)})),
      h('p',{className:'cx-page-note cx-navpage-note'},'由原生 DSH 执行；ColdX 运行且所属会话已打开时才会触发。'),
      create&&h('form',{className:'cx-page-form cx-navpage-create',onSubmit:event=>{
        event.preventDefault();const at=new Date(date);
        if(frequency==='once'&&(!Number.isFinite(at.getTime())||at.getTime()<=Date.now())){setError('请选择未来的有效时间。');return;}
        submit({operation:'create',sessionId:owner,prompt,...frequency==='once'?{at:at.toISOString()}:{everySeconds:frequency==='hourly'?3600:86400}});
      }},
        h('div',{className:'cx-navpage-create-heading'},h('div',null,h('h2',null,'新建定时任务'),h('p',null,'任务会在所选会话中执行。')),
          h('button',{type:'button',className:'cx-navpage-icon-button','aria-label':'关闭新建任务',onClick:()=>setCreate(false)},icon('close'))),
        h('label',null,'所属会话',h('select',{value:owner,onChange:event=>setOwner(event.target.value)},
          h('option',{value:''},'选择会话'),sessionOptions.map(item=>h('option',{key:item.id,value:item.id},item.displayTitle)))),
        h('label',null,'任务内容',h('textarea',{autoFocus:true,required:true,value:prompt,onChange:event=>setPrompt(event.target.value),
          maxLength:16000,placeholder:'描述要定期完成的工作'})),
        h('label',null,'执行频率',h('select',{value:frequency,onChange:event=>setFrequency(event.target.value)},
          h('option',{value:'daily'},'每 24 小时'),h('option',{value:'hourly'},'每小时'),h('option',{value:'once'},'指定时间（一次）'))),
        frequency==='once'&&h('label',null,'执行时间',h('input',{type:'datetime-local',required:true,'aria-label':'执行时间',
          value:date,onChange:event=>setDate(event.target.value)})),
        h('div',{className:'cx-navpage-form-actions'},
          h('button',{type:'button',onClick:()=>setCreate(false)},'取消'),
          h('button',{type:'submit',className:'cx-page-primary',disabled:busy||!owner||!prompt.trim()},busy?'创建中…':'创建任务'))),
      error&&status(error,'error'),
      state.error&&status(state.error,'error',h('button',{type:'button',onClick:refresh},'重试')),
      state.loading&&status('正在读取定时任务…'),
      state.data&&(state.data.unavailable>0||state.data.truncated)&&status('部分历史未能读取，当前列表可能不完整。','info'),
      state.data&&h('div',{className:'cx-navpage-section-title'},h('h2',null,'已安排'),h('span',null,visible.length+' 项')),
      state.data&&(visible.length?h('div',{className:'cx-navpage-list'},visible.map(item=>{
        const when=new Date(item.scheduledAt),time=Number.isFinite(when.getTime())?when.toLocaleString():'时间未知';
        const cadence=item.kind==='every'?'每 '+(item.everySeconds/60)+' 分钟':'执行一次';
        return h('article',{key:item.sessionId+item.id,className:'cx-page-schedule cx-navpage-schedule'},
          h('div',{className:'cx-navpage-schedule-top'},
            h('span',{className:'cx-navpage-row-icon'},icon('clock')),
            h('span',{className:'cx-navpage-badge','data-live':Boolean(item.live)},item.live?'会话已加载':'等待会话打开')),
          h('h3',null,item.prompt||'未命名任务'),
          h('p',{className:'cx-navpage-schedule-meta'},sessions.byId[item.sessionId]?.displayTitle||item.title||'所属会话',' · ',time,' · ',cadence),
          h('div',{className:'cx-navpage-schedule-actions'},
            h('button',{type:'button',onClick:()=>open(item.sessionId)},'打开会话'),
            h('button',{type:'button',disabled:busy||!item.live,onClick:()=>submit({operation:'delete',sessionId:item.sessionId,id:item.id})},'取消安排')));
      })):empty('clock',term?'没有匹配的定时任务':'还没有定时任务',
        term?'清除筛选词，查看全部已安排任务。':'新建任务后，它会在这里显示。')));
  }
  function PullRequests(){
    const sessions=useList(),[id,setId]=React.useState(sessions.current||'');
    const [state,refresh]=useLoad('pullRequests',{sessionId:id},id);
    const rows=state.data?.items??[];
    return h('div',{className:'cx-navpage cx-navpage-pr'},
      intro('代码协作','Pull Request','查看当前项目中的代码审查',
        h('button',{type:'button',className:'cx-navpage-icon-button','aria-label':'刷新 Pull Request',onClick:refresh},icon('refresh'))),
      h('div',{className:'cx-navpage-pr-picker'},
        h('label',null,'项目会话',h('select',{'aria-label':'选择项目会话',value:id,onChange:event=>setId(event.target.value)},
          h('option',{value:''},'选择项目会话'),
          sessions.ids.map(key=>sessions.byId[key]).filter(row=>row&&!row.parentId)
            .map(row=>h('option',{key:row.id,value:row.id},row.displayTitle))))),
      state.loading&&status('正在读取 Pull Request…'),
      state.error&&status(state.error,'error',h('button',{type:'button',onClick:refresh},'重试')),
      state.data?.unavailable?empty('branch','无法读取 Pull Request',state.data.message,
        h('button',{type:'button',onClick:refresh},'再次检查')):
      state.data&&h(React.Fragment,null,
        h('div',{className:'cx-navpage-section-title'},h('h2',null,'开放的 Pull Request'),h('span',null,rows.length+' 项')),
        rows.length?h('div',{className:'cx-navpage-list'},rows.map(item=>{
          const href=safeExternalUrl(item.url);
          const content=h(React.Fragment,null,
            h('span',{className:'cx-navpage-row-icon'},icon('branch')),
            h('span',{className:'cx-navpage-row-body'},h('strong',null,item.title),
              h('small',null,'#'+item.number+' · '+(item.headRefName||'分支未知'))),
            item.isDraft&&h('span',{className:'cx-navpage-badge'},'草稿'),
            href&&h('span',{className:'cx-navpage-row-chevron','aria-hidden':true},icon('link')));
          return href?
            h('a',{key:item.number,className:'cx-page-list-row cx-navpage-row',href,target:'_blank',rel:'noopener noreferrer'},content):
            h('div',{key:item.number,className:'cx-page-list-row cx-navpage-row','aria-label':'链接不可用'},content,
              h('small',{className:'cx-navpage-link-error'},'链接不可用'));
        })):empty('branch','暂无开放的 Pull Request','这个项目还没有开放的代码审查。'),
        state.data.limited&&status('显示最近 50 项。','info')));
  }
  function Pages(){
    const current=usePage(),root=React.useRef(null),paletteRef=React.useRef(null);
    React.useEffect(()=>{
      const shortcut=event=>{
        if(event.defaultPrevented||event.isComposing||event.altKey||event.shiftKey||!(event.ctrlKey||event.metaKey))return;
        const key=event.key.toLocaleLowerCase();
        if(key==='k'||key==='p'){event.preventDefault();openPalette(document.activeElement);}
      };
      document.addEventListener('keydown',shortcut);
      return()=>document.removeEventListener('keydown',shortcut);
    },[]);
    React.useEffect(()=>{
      if(!current)return;
      const conversation=document.querySelector('.wSkVaW_root'),original=conversation?.inert;
      if(conversation)conversation.inert=true;
      if(current==='search')return()=>{if(conversation)conversation.inert=original;};
      const center=document.querySelector('.pI_x6G_centerCol');
      const align=()=>{if(!center||!root.current)return;const rect=center.getBoundingClientRect();Object.assign(root.current.style,{left:`${rect.left}px`,top:`${rect.top}px`,width:`${rect.width}px`,height:`${rect.height}px`});};
      align();const observer=new ResizeObserver(align);if(center)observer.observe(center);window.addEventListener('resize',align);
      if(!root.current?.contains(document.activeElement))root.current?.focus();
      return()=>{observer.disconnect();window.removeEventListener('resize',align);if(conversation)conversation.inert=original;};
    },[current]);
    React.useEffect(()=>{
      if(current!=='search')return;
      const dialog=paletteRef.current;
      dialog?.showModal();
      return()=>{if(dialog?.open)dialog.close();};
    },[current]);
    if(!current)return null;
    if(current==='search')return h('dialog',{ref:paletteRef,role:'dialog','aria-modal':true,'aria-label':'搜索与命令',className:'cx-command-overlay',onCancel:event=>{event.preventDefault();closePalette();},onClick:event=>{if(event.target===event.currentTarget)closePalette();},onKeyDown:event=>{
        if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closePalette();}
        if(event.key==='Tab'){
          const focusable=[...event.currentTarget.querySelectorAll('input,button:not(:disabled)')];
          if(!focusable.length)return;
          if(event.shiftKey&&document.activeElement===focusable[0]){event.preventDefault();focusable.at(-1).focus();}
          else if(!event.shiftKey&&document.activeElement===focusable.at(-1)){event.preventDefault();focusable[0].focus();}
        }
      }},h('div',{className:'cx-command-dialog'},h(Search)));
    const title={plugins:'插件',usage:'用量与活动',schedules:'定时任务',pullRequests:'Pull Request'}[current];
    return h('section',{ref:root,className:'cx-workbench-page',tabIndex:-1,'aria-label':title,onKeyDown:event=>{if(event.key==='Escape')navigate(null);}},h('header',null,h('span',null,title),h('button',{type:'button',className:'cx-rebuild-icon','aria-label':'返回对话',onClick:()=>navigate(null)},icon('close'))),
      current==='plugins'?h(Marketplace,{embedded:true,onClose:()=>navigate(null)}):current==='usage'?h(Usage,{embedded:true,onClose:()=>navigate(null)}):h('div',{className:'cx-workbench-page-body'},current==='schedules'?h(Schedules):h(PullRequests)));
  }
  const start=()=>navigate(null);
  return {Nav,TaskList,Pages,navigate,start};
}
