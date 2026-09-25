// Serialized into the native DSH client. The controller polls host state; team actions use native RPC.
export function createCompanionComponents(React, settings, bodyHref, {rpc,openTask,getSessionId,ensureParent}={}) {
  const h=React.createElement;
  const labels={idle:'慢慢来，我在呢。',busy:'你忙你的，我陪着。',thinking:'让我先理理思路。',working:'正在一步一步往前走。',reading:'找到线索了，我仔细看看。',speaking:'正在把想法整理给你。',listening:'收到，我认真听着。',waiting:'等你点点头。',celebrating:'这一轮结束啦，来看看结果。',problem:'卡住也没关系，一起看看。',stopped:'已经停下，按你的节奏来。',sleeping:'先歇一会儿，需要时叫我。'};
  const greetings=['摸到一团好心情。','给你一点毛茸茸的勇气。','今天也可以按自己的节奏来。','收到摸摸，充电一下。','陪你把大事情分成小事情。'];
  let snapshot={sessionId:null,mood:'idle',caption:labels.idle};
  const listeners=new Set();
  const liveListeners=new Set();
  const groupListeners=new Set(),drafts=new Map();
  let groupView=null,groupError='',groupNavigation=0,groupAbort=null;
  const getGroupView=()=>groupView;
  const subscribeGroup=fn=>{groupListeners.add(fn);return()=>groupListeners.delete(fn);};
  function setGroupView(view){
    if(groupView?.teamId===view?.teamId&&groupView?.parentSessionId===view?.parentSessionId)return groupView;
    groupView=view;for(const fn of groupListeners)fn();return groupView;
  }
  function currentParent(){const current=getSessionId?.();return live.tasks.find(task=>task.id===current)?.parentSessionId||current||groupView?.parentSessionId||null;}
  async function openGroup(id='new'){
    groupAbort?.abort();const abort=new AbortController();groupAbort=abort;
    const serial=++groupNavigation,team=live.teams.find(item=>item.id===id);
    groupError='';updateLive(live,liveError);
    try{
      if(id!=='new'&&!team)throw Error('这个群组暂时无法打开，请刷新后重试。');
      const requestedParent=team?.parentSessionId||currentParent();
      const parentSessionId=ensureParent?await ensureParent(requestedParent,{signal:abort.signal}):requestedParent;
      if(serial!==groupNavigation||abort.signal.aborted)return null;
      if(team&&parentSessionId!==team.parentSessionId)throw Error('群组的原任务暂时无法打开，请重试。');
      return setGroupView({teamId:id,parentSessionId:parentSessionId||null});
    }catch(error){if(serial===groupNavigation&&!abort.signal.aborted&&error?.name!=='AbortError'){groupError=error?.message||'群组暂时无法打开，请重试。';updateLive(live,liveError);}return null;}
    finally{if(groupAbort===abort)groupAbort=null;}
  }
  function closeGroup(){groupNavigation++;groupAbort?.abort();groupAbort=null;setGroupView(null);}
  function openCurrentGroup(){const parent=currentParent();openGroup(live.teams.find(team=>team.parentSessionId===parent)?.id||'new');}
  const emptyLive={version:1,tasks:[],teams:[]};
  let live=emptyLive,liveError='',generation=0,active=false,controllerCount=0,pollTimer=null,pollAbort=null;
  const palette=['coral','peach','gold','mint','sky','lilac','pink','blue'];
  const colorHex={coral:'#ef6f70',peach:'#f8ad82',gold:'#edc568',mint:'#69cba7',sky:'#7dbce9',lilac:'#ad9fe4',pink:'#ef9fc4',blue:'#7598d9'};
  const moods=new Set(['idle','thinking','working','reading','waiting','speaking','listening','celebrating','problem','stopped','sleeping']);
  const roleLabels={research:'研究',design:'设计',review:'审阅'};
  const colorNames={coral:'珊瑚',peach:'蜜桃',gold:'奶黄',mint:'薄荷',sky:'晴空',lilac:'丁香',pink:'樱粉',blue:'雾蓝'};
  const hues={lilac:'0deg',pink:'35deg',coral:'80deg',peach:'115deg',gold:'150deg',mint:'245deg',sky:'295deg',blue:'325deg'};
  const liveSnapshot=()=>({data:live,error:liveError});
  let liveView=liveSnapshot();
  const subscribeLive=fn=>{liveListeners.add(fn);return()=>liveListeners.delete(fn);};
  const getLive=()=>liveView;
  function updateLive(data,error=''){
    live=data;liveError=error;liveView=liveSnapshot();for(const fn of liveListeners)fn();
  }
  function clearLive(error=''){generation++;pollAbort?.abort();pollAbort=null;updateLive(emptyLive,error);}
  async function refresh(){
    if(!active||typeof rpc!=='function')return;
    if(pollAbort)return;
    const serial=++generation,abort=new AbortController();pollAbort=abort;
    try{
      const data=await rpc('snapshot',{},abort.signal);
      if(!active||serial!==generation||abort.signal.aborted)return;
      if(data?.version!==1||!Array.isArray(data.tasks)||!Array.isArray(data.teams))throw Error('Invalid companion snapshot');
      const tasks=data.tasks.slice(0,24).filter(t=>typeof t?.id==='string').map(t=>{
        let hash=0;for(const char of t.id)hash=(hash*31+char.charCodeAt(0))>>>0;
        return {...t,mood:t.pendingId?'waiting':moods.has(t.mood)?t.mood:'problem',color:palette.includes(t.color)?t.color:palette[hash%palette.length],caption:String(t.caption||'').slice(0,120)};
      });
      updateLive({version:1,tasks,teams:data.teams.slice(0,8)},String(data.error||''));
    }catch(error){if(active&&serial===generation&&!abort.signal.aborted)clearLive('伙伴暂时无法连接，请稍后重试。');}
    finally{if(pollAbort===abort)pollAbort=null;}
  }
  function start(){if(active||typeof rpc!=='function')return;active=true;refresh();pollTimer=setInterval(refresh,2000);}
  function stop(){active=false;clearInterval(pollTimer);pollTimer=null;clearLive();}
  function Controller(){React.useEffect(()=>{controllerCount++;if(controllerCount===1)start();return()=>{controllerCount--;if(controllerCount===0)stop();};},[]);return null;}
  const getSnapshot=()=>snapshot;
  const subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn);};
  function observe({sessionId=null,running=false,pending=0,lastKind}={}) {
    const mood=pending?'waiting':running?'busy':lastKind==='turn-error'?'problem':'idle';
    if(snapshot.sessionId===sessionId&&snapshot.mood===mood)return;
    snapshot={sessionId,mood,caption:labels[mood]};
    for(const listener of listeners)listener();
  }
  function forget(sessionId){if(snapshot.sessionId===sessionId)observe();}
  const petCaption=(mood,index)=>['idle','celebrating','sleeping'].includes(mood)?greetings[index%greetings.length]:labels[mood]||labels.idle;
  function useSettings(){return React.useSyncExternalStore(fn=>settings.subscribe(fn),()=>settings.getSnapshot(),()=>settings.getSnapshot());}

  function Companion({wide=true}={}) {
    const preferences=useSettings();
    const enabled=preferences.status==='ready'&&preferences.value?.enabled!==false;
    // Unmounting the creature stops every listener, timeout and animation.
    return enabled?h(Creature,{wide,canHide:preferences.writable===true}):null;
  }
  function Creature({wide,canHide}) {
    const state=React.useSyncExternalStore(subscribe,getSnapshot,getSnapshot);
    const projected=React.useSyncExternalStore(subscribeLive,getLive,getLive);
    const selected=typeof rpc==='function'&&(projected.data.tasks.find(task=>task.pendingId)||projected.data.tasks.find(task=>task.id===getSessionId?.()));
    const shown=selected||state;
    const [touch,setTouch]=React.useState(null),[saving,setSaving]=React.useState(false),[error,setError]=React.useState('');
    const [awake,setAwake]=React.useState(()=>!document.hidden);
    const body=React.useRef(null),eyes=React.useRef([]),animation=React.useRef(null),timer=React.useRef(null),touchCount=React.useRef(0);
    React.useEffect(()=>{
      const visible=()=>setAwake(!document.hidden);
      document.addEventListener('visibilitychange',visible);
      return()=>{document.removeEventListener('visibilitychange',visible);clearTimeout(timer.current);animation.current?.cancel();};
    },[]);
    React.useEffect(()=>{setTouch(null);clearTimeout(timer.current);},[shown.id,shown.sessionId,shown.mood]);
    React.useEffect(()=>{
      const motion=matchMedia('(prefers-reduced-motion: reduce)'),fine=matchMedia('(pointer: fine)');
      let frame=0,point=null,attached=false;
      const reset=()=>{cancelAnimationFrame(frame);frame=0;point=null;for(const eye of eyes.current)if(eye)eye.style.transform='';};
      const draw=()=>{
        frame=0;if(!point||!body.current)return;
        const r=body.current.getBoundingClientRect(),dx=point.x-(r.left+r.width/2),dy=point.y-(r.top+r.height/2);
        const length=Math.hypot(dx,dy),distance=Math.min(3,length/45);
        for(const eye of eyes.current)if(eye)eye.style.transform=`translate(${length?dx/length*distance:0}px,${length?dy/length*distance:0}px)`;
      };
      const move=e=>{point={x:e.clientX,y:e.clientY};if(!frame)frame=requestAnimationFrame(draw);};
      const stop=()=>{document.removeEventListener('pointermove',move);window.removeEventListener('blur',reset);document.documentElement.removeEventListener('pointerleave',reset);cancelAnimationFrame(frame);frame=0;attached=false;reset();animation.current?.cancel();};
      const sync=()=>{stop();if(awake&&!motion.matches&&fine.matches){document.addEventListener('pointermove',move,{passive:true});window.addEventListener('blur',reset);document.documentElement.addEventListener('pointerleave',reset);attached=true;}};
      motion.addEventListener('change',sync);fine.addEventListener('change',sync);sync();
      return()=>{if(attached||frame)stop();motion.removeEventListener('change',sync);fine.removeEventListener('change',sync);};
    },[awake]);
    function pet(event){
      clearTimeout(timer.current);
      setTouch(petCaption(shown.mood,touchCount.current++));
      timer.current=setTimeout(()=>setTouch(null),4200);
      animation.current?.cancel();
      if(event.detail!==0&&!matchMedia('(prefers-reduced-motion: reduce)').matches) {
        animation.current=body.current?.animate([
          {transform:'translateY(0) scale(1,1)'},
          {transform:'translateY(2px) scale(1.1,.9)',offset:.2},
          {transform:'translateY(-7px) scale(.96,1.04)',offset:.55},
          {transform:'translateY(0) scale(1,1)'},
        ],{duration:500,easing:'cubic-bezier(.23,1,.32,1)'});
      }
    }
    async function hide(){
      if(saving||!canHide)return;
      setSaving(true);setError('');
      try{await settings.set('enabled',false);}
      catch{setError('没能收起，请在设置里重试。');}
      finally{setSaving(false);}
    }
    const caption=error||(shown.mood==='waiting'?shown.caption||labels.waiting:shown.mood==='problem'?labels.problem:touch||labels[shown.mood]||labels.idle);
    return h('div',{className:'cx-companion','data-wide':wide,'data-mood':shown.mood,'data-awake':awake,'data-petted':touch!==null,style:{'--cx-pet-color':colorHex[selected?.color]||colorHex.lilac,'--cx-pet-hue':hues[selected?.color]||'0deg'}},
      h('button',{type:'button',className:'cx-companion-pet',onClick:pet,'aria-label':'摸摸小绒','aria-description':caption,title:wide?'摸摸小绒':caption},
        h('span',{className:'cx-companion-body',ref:body,'aria-hidden':true},
          h('img',{src:bodyHref,alt:'',draggable:false,width:88,height:88}),
          h('span',{className:'cx-companion-eyes'},[0,1].map(index=>h('span',{key:index,className:'cx-companion-eye'},h('span',{className:'cx-companion-pupil',ref:node=>{eyes.current[index]=node;}},h('i'))))),
          h('span',{className:'cx-companion-mouth','aria-hidden':true}),h('span',{className:'cx-companion-spark','aria-hidden':true},'♡'))),
      wide&&h('div',{className:'cx-companion-copy'},h('span',{className:'cx-companion-name'},'小绒'),h('span',{className:'cx-companion-caption','aria-live':'polite','aria-atomic':true},caption),typeof rpc==='function'&&h('div',{className:'cx-companion-links'},h('button',{className:'cx-companion-team-control',type:'button',onClick:openCurrentGroup,'aria-label':'打开伙伴群组'},'群组'),selected?.pendingId&&h('button',{className:'cx-companion-team-control',type:'button',onClick:async()=>{try{await openTask?.(selected.id,selected);closeGroup();}catch{setError('暂时打不开，请在任务列表中重试。');}}},'去看看'))),
      !wide&&typeof rpc==='function'&&h('button',{className:'cx-companion-team-control cx-companion-rail-control',type:'button',onClick:openCurrentGroup,'aria-label':'打开伙伴群组'},'⋯'),
      wide&&canHide&&h('button',{className:'cx-companion-hide',type:'button','aria-label':'收起小绒，可在设置中重新开启',title:'收起小绒',disabled:saving,onClick:hide},'×'));
  }
  function CompanionSettingsRow(){
    const pref=useSettings(),[saving,setSaving]=React.useState(false),[error,setError]=React.useState('');
    const enabled=pref.status==='ready'&&pref.value?.enabled!==false;
    async function toggle(key,value){
      if(saving||pref.status!=='ready'||!pref.writable)return;
      setSaving(true);setError('');
      try{await settings.set(key,value);}catch{setError('保存失败，请重试。');}finally{setSaving(false);}
    }
    return h('div',{className:'cx-terminal-settings cx-companion-settings'},
      h('div',{className:'cx-terminal-settings-copy'},h('span',{className:'cx-terminal-settings-title'},'小绒 · 应用内伙伴'),h('span',{className:'cx-terminal-settings-description'},'在侧栏陪你工作，点一下摸摸它。表情不消耗 Token；群组讨论按模型实际调用计费。')),
      h('label',{className:'cx-companion-setting'},h('span',null,'显示毛球伙伴'),h('button',{type:'button',className:'cx-terminal-switch',role:'switch','aria-label':'显示毛球伙伴','aria-checked':enabled,'data-on':String(enabled),disabled:saving||pref.status!=='ready'||!pref.writable,onClick:()=>toggle('enabled',!enabled)},h('span',{className:'cx-terminal-switch-thumb','aria-hidden':true}))),
      error&&h('p',{className:'cx-terminal-settings-error',role:'alert'},error));
  }
  const trio=()=>[{name:'小探',role:'research',color:'lilac'},{name:'小画',role:'design',color:'peach'},{name:'小验',role:'review',color:'mint'}];
  function Furball({color='lilac',mood='idle',size=36}){
    return h('span',{className:'cx-group-avatar','data-mood':mood,style:{'--cx-avatar-size':`${size}px`,'--cx-pet-color':colorHex[color]||colorHex.lilac,'--cx-pet-hue':hues[color]||'0deg'},'aria-hidden':true},
      h('span',{className:'cx-companion-body'},h('img',{src:bodyHref,alt:'',draggable:false,width:size,height:size}),
        h('span',{className:'cx-companion-eyes'},[0,1].map(i=>h('span',{className:'cx-companion-eye',key:i},h('span',{className:'cx-companion-pupil'},h('i'))))),h('span',{className:'cx-companion-mouth'})));
  }
  function useAwake(){
    const [awake,setAwake]=React.useState(()=>!document.hidden);
    React.useEffect(()=>{const visible=()=>setAwake(!document.hidden);document.addEventListener('visibilitychange',visible);return()=>document.removeEventListener('visibilitychange',visible);},[]);
    return awake;
  }
  function teamStatus(team,tasks){
    if(team.members.some(member=>tasks.some(task=>task.id===member.id&&task.pendingId)))return '等待你确认';
    if(team.status==='running')return team.round?.phase==='synthesizing'?'正在汇总':'讨论中';
    return ({idle:'等待开始',completed:'本轮已结束',failed:'部分成员未完成',stopped:'已停止',interrupted:'讨论已中断'})[team.status]||'状态未知';
  }
  function GroupSidebar({wide=true}={}){
    const {data,error}=React.useSyncExternalStore(subscribeLive,getLive,getLive);
    const view=React.useSyncExternalStore(subscribeGroup,getGroupView,getGroupView),awake=useAwake();
    if(typeof rpc!=='function')return null;
    return h('section',{className:'cx-group-sidebar','aria-label':'群组','data-wide':wide,'data-awake':awake},
      h('div',{className:'cx-group-sidebar-heading'},wide&&h('span',null,'群组'),h('button',{type:'button',onClick:()=>openGroup('new'),'aria-label':'新建群组',title:'新建群组'},'+')),
      (groupError||error)&&h('p',{className:'cx-group-sidebar-error',role:'alert','aria-label':groupError||error,title:groupError||error},wide?groupError||error:'!'),
      h('div',{className:'cx-group-sidebar-list'},data.teams.map(team=>h('button',{type:'button',key:team.id,className:'cx-group-row','aria-label':`打开群组 ${team.name}`,'aria-current':view?.teamId===team.id?'page':undefined,'data-selected':view?.teamId===team.id,onClick:()=>openGroup(team.id),title:wide?undefined:team.name},
        h(Furball,{color:team.members[0]?.color,size:24}),wide&&h('span',{className:'cx-group-row-copy'},h('span',{className:'cx-group-row-name'},team.name),h('span',{className:'cx-group-row-status'},teamStatus(team,data.tasks)))))),
      wide&&!data.teams.length&&!error&&h('p',{className:'cx-group-sidebar-empty'},'和几位小绒一起聊聊'));
  }
  function GroupPage(){
    const view=React.useSyncExternalStore(subscribeGroup,getGroupView,getGroupView);
    return view?h(GroupConversation,{key:JSON.stringify([view.parentSessionId,view.teamId]),view}):null;
  }
  function GroupConversation({view}){
    const {data,error}=React.useSyncExternalStore(subscribeLive,getLive,getLive),awake=useAwake();
    const team=data.teams.find(item=>item.id===view.teamId&&item.parentSessionId===view.parentSessionId);
    const creating=view.teamId==='new',draftKey=JSON.stringify([view.parentSessionId,view.teamId]);
    const [draft,setDraftState]=React.useState(()=>drafts.get(draftKey)||'');
    const [name,setName]=React.useState('我的小绒群组'),[members,setMembers]=React.useState(trio);
    const [busy,setBusy]=React.useState(false),[actionError,setActionError]=React.useState('');
    const op=React.useRef(null),navigation=React.useRef(null),scroll=React.useRef(null),pinned=React.useRef(true);
    const setDraft=value=>{drafts.set(draftKey,value);setDraftState(value);};
    const genes=team?.genes||[];
    React.useEffect(()=>()=>{op.current?.abort();navigation.current?.abort();},[]);
    React.useEffect(()=>{if(pinned.current&&scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[team?.messages?.length,team?.status]);
    async function invoke(method,request,acceptedDraft){
      if(op.current)return;
      const abort=new AbortController();op.current=abort;setBusy(true);setActionError('');
      try{
        const result=await rpc(method,request,abort.signal);
        if(abort.signal.aborted)return;
        if(method==='send'&&drafts.get(draftKey)===acceptedDraft)setDraft('');
        if(method==='removeTeam'){drafts.delete(draftKey);closeGroup();return;}
        if(method==='createTeam'){
          if(typeof result?.teamId!=='string')throw Error('群组创建结果暂时无法确认，请刷新后重试。');
          setGroupView({teamId:result.teamId,parentSessionId:view.parentSessionId});
        }
        await refresh();
      }catch(reason){if(!abort.signal.aborted)setActionError(reason?.message||'操作失败，请重试。');}
      finally{if(op.current===abort)op.current=null;if(!abort.signal.aborted)setBusy(false);}
    }
    async function navigate(task){
      if(!task||!openTask){setActionError('这个来源任务暂时无法打开，请刷新后重试。');return;}
      navigation.current?.abort();const abort=new AbortController();navigation.current=abort;
      try{await openTask(task.id,task,abort.signal);if(!abort.signal.aborted&&getGroupView()===view)closeGroup();}
      catch(reason){if(!abort.signal.aborted)setActionError(reason?.message||'无法打开任务，请重试。');}
      finally{if(navigation.current===abort)navigation.current=null;}
    }
    const sourceTask=id=>data.tasks.find(task=>task.id===id)||(team?.members.some(member=>member.id===id)?{id,parentSessionId:team.parentSessionId,mode:'continuable'}:undefined);
    const edit=(index,key,value)=>setMembers(old=>old.map((member,i)=>i===index?{...member,[key]:value}:member));
    const send=()=>{if(team&&!busy&&team.status!=='running'&&draft.trim())invoke('send',{teamId:team.id,text:draft.trim()},draft);};
    const pageError=actionError||groupError||error;
    return h('main',{className:'cx-group-page','aria-label':creating?'新建群组':'群组聊天','data-awake':awake},
      h('header',{className:'cx-group-header'},h('button',{type:'button',className:'cx-group-back',onClick:closeGroup,'aria-label':'返回普通聊天',title:'返回普通聊天'},'←'),
        h('div',{className:'cx-group-heading'},h('h2',null,creating?'新建群组':team?.name||'群组'),h('p',{role:'status'},creating?'给这次讨论选几位伙伴':team?`${team.members.length} 位伙伴 · ${teamStatus(team,data.tasks)}`:error?'正在等待重新连接':'正在载入群组…')),
        team&&h('div',{className:'cx-group-header-avatars','aria-label':'群组成员'},team.members.map(member=>{
          const task=data.tasks.find(item=>item.id===member.id);
          return h('button',{type:'button',key:member.id,disabled:!task,onClick:()=>navigate(task),title:`${member.name} · ${roleLabels[member.role]||member.role}${task?.pendingId?' · 等待你确认':''}`,'aria-label':`打开 ${member.name} 的任务${task?.pendingId?'，等待你确认':''}`,'data-pending':Boolean(task?.pendingId)},h(Furball,{color:member.color,mood:task?.mood||'idle',size:36}));
        }))),
      pageError&&h('p',{role:'alert',className:'cx-group-error'},pageError),
      team?.error&&h('p',{role:'alert',className:'cx-group-error'},team.error),
      creating?h('div',{className:'cx-group-scroll cx-group-create'},
        h('form',{onSubmit:event=>{event.preventDefault();if(!busy&&view.parentSessionId&&name.trim()&&!members.some(member=>!member.name.trim()))invoke('createTeam',{parentSessionId:view.parentSessionId,name:name.trim(),members:members.map(member=>({...member,name:member.name.trim()}))});}},
          !view.parentSessionId&&h('p',{role:'alert',className:'cx-group-error'},'请先打开一个任务，再新建群组。'),
          h('label',null,'群组名称',h('input',{value:name,maxLength:80,disabled:busy,onChange:event=>setName(event.target.value)})),
          h('div',{className:'cx-group-form-heading'},h('h3',null,'群组成员'),h('span',null,'1–4 位伙伴')),
          h('div',{className:'cx-group-member-editor'},members.map((member,index)=>h('div',{className:'cx-group-member-form',key:index},h(Furball,{color:member.color,size:36}),
            h('label',null,'名字',h('input',{value:member.name,maxLength:60,disabled:busy,onChange:event=>edit(index,'name',event.target.value)})),
            h('label',null,'分工',h('select',{value:member.role,disabled:busy,onChange:event=>edit(index,'role',event.target.value)},Object.entries(roleLabels).map(([value,label])=>h('option',{value,key:value},label)))),
            h('label',null,'颜色',h('select',{value:member.color,disabled:busy,onChange:event=>edit(index,'color',event.target.value)},palette.map(color=>h('option',{value:color,key:color},colorNames[color])))),
            h('button',{type:'button',disabled:busy||members.length===1,'aria-label':`移除 ${member.name}`,onClick:()=>setMembers(old=>old.filter((_,i)=>i!==index))},'×')))),
          h('button',{type:'button',disabled:busy||members.length>=4,onClick:()=>setMembers(old=>[...old,{name:`小绒 ${old.length+1}`,role:'review',color:palette[(old.length+1)%palette.length]}])},'添加伙伴'),
          h('div',{className:'cx-group-form-footer'},h('p',null,'每位伙伴独立探索，再汇总成一份回复。讨论按模型实际用量计费。'),h('button',{type:'submit',className:'cx-group-primary',disabled:busy||!view.parentSessionId||!name.trim()||members.some(member=>!member.name.trim())},busy?'正在创建…':'创建群组')))):
        team?h(React.Fragment,null,
          h('div',{className:'cx-group-scroll',ref:scroll,onScroll:event=>{const node=event.currentTarget;pinned.current=node.scrollHeight-node.scrollTop-node.clientHeight<72;}},
            h('div',{className:'cx-group-timeline',role:'log','aria-label':'群组对话'},team.messages?.length?team.messages.map(message=>{
              const member=team.members.find(item=>item.id===message.taskId),task=sourceTask(message.taskId);
              return h('article',{className:'cx-group-message',key:message.id,'data-human':!message.taskId},message.taskId?h(Furball,{color:member?.color||data.tasks.find(item=>item.id===message.taskId)?.color,size:36}):h('span',{className:'cx-group-human-avatar','aria-hidden':true},'你'),
                h('div',{className:'cx-group-message-body'},h('div',{className:'cx-group-message-heading'},h('strong',null,message.name||'你'),message.taskId&&h('button',{type:'button',onClick:()=>navigate(task)},'打开任务')),h('p',null,message.text)));
            }):h('div',{className:'cx-group-empty'},h('p',null,'大家到齐了。发一条消息，开始讨论吧。'))),
            h('details',{className:'cx-group-info'},h('summary',null,`群组信息与经验${genes.length?` · ${genes.length}`:''}`),
              h('p',null,'经验来自已完成的讨论，试用后才用于本群组后续轮次。使用次数不代表成功率。'),
              genes.length?genes.map(gene=>h('article',{className:'cx-group-gene',key:gene.id,'data-active':gene.status==='active'},
                h('div',{className:'cx-group-gene-heading'},h('h3',null,gene.title),h('span',null,({active:'试用中',paused:'已停用',candidate:'待验证'})[gene.status]||'待验证')),
                h('p',null,'适用于：',gene.when),h('p',null,gene.practice),h('footer',null,h('span',null,`已用于 ${Number.isSafeInteger(gene.uses)?gene.uses:0} 次讨论`),h('button',{type:'button',onClick:()=>navigate(sourceTask(gene.sourceTaskId))},'查看来源'),h('button',{type:'button',disabled:busy,onClick:()=>invoke('updateGene',{teamId:team.id,geneId:gene.id,status:gene.status==='active'?'paused':'active'})},gene.status==='active'?'停用':'试用这条经验')))):
                h('p',{className:'cx-group-info-empty'},'这一轮若提炼出可复用的方法，会留在这里。没有提炼出经验时不会凑数。'),
              h('button',{type:'button',disabled:busy||team.status==='running',onClick:()=>invoke('removeTeam',{teamId:team.id})},'移除群组'))),
          h('form',{className:'cx-group-composer',onSubmit:event=>{event.preventDefault();send();}},h('label',null,'发给群组',h('textarea',{value:draft,maxLength:2000,rows:2,placeholder:'发一条消息…',onChange:event=>setDraft(event.target.value),onKeyDown:event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)&&!event.nativeEvent?.isComposing){event.preventDefault();send();}}})),
            h('div',{className:'cx-group-composer-actions'},h('span',null,'每次发送运行一轮 · 按实际用量计费'),team.status==='running'?h('button',{type:'button',disabled:busy,onClick:()=>invoke('stop',{teamId:team.id})},'停止'):h('button',{type:'submit',className:'cx-group-primary',disabled:busy||!draft.trim()},'发送')))):
          h('div',{className:'cx-group-scroll cx-group-empty'},h('p',null,error?'连接恢复后会继续显示原群组，草稿已保留。':'这个群组暂时没有可显示的记录。'),h('button',{type:'button',onClick:()=>refresh()},'重新加载')));
  }
  function SessionObserver({sessionId,session}) {
    const running=session?.running===true,pending=session?.pending?.length??0;
    const lastKey=session?.chat?.order?.at(-1),lastKind=session?.chat?.nodes?.get(lastKey)?.kind;
    React.useEffect(()=>{observe({sessionId,running,pending,lastKind});},[sessionId,running,pending,lastKind]);
    React.useEffect(()=>()=>forget(sessionId),[sessionId]);
    return null;
  }
  return {Controller,Companion,CompanionSettingsRow,GroupSidebar,GroupPage,getGroupView,subscribeGroup,openGroup,closeGroup,SessionObserver,observe,forget,getSnapshot,subscribe,getLive,refresh,labels,petCaption,dispose(){closeGroup();stop();drafts.clear();listeners.clear();liveListeners.clear();groupListeners.clear();}};
}
