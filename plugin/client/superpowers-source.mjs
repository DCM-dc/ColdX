// Shared per-client status. Native Host settings and skill providers own behavior.
export function createSuperpowersComponents(React,rpc) {
  const h=React.createElement,listeners=new Set();
  let snapshot={value:null,error:'',busy:false},timer,reading,version=0,closed=false;
  const publish=next=>{if(closed)return;snapshot={...snapshot,...next};for(const listener of listeners)listener();};
  const valid=value=>value&&typeof value.enabled==='boolean'&&typeof value.autoCheck==='boolean'&&typeof value.active?.commit==='string';
  async function read(){if(closed||reading||snapshot.busy)return;const current=version,controller=new AbortController();reading=controller;try{const value=await rpc('state',{},controller.signal);if(!valid(value))throw Error('技能状态未完整返回。');if(current===version)publish({value,error:''});}catch(error){if(!controller.signal.aborted&&current===version)publish({error:error.message||String(error)});}finally{if(reading===controller)reading=undefined;}}
  const subscribe=listener=>{listeners.add(listener);if(listeners.size===1){void read();timer=setInterval(read,30_000);}return()=>{listeners.delete(listener);if(!listeners.size){clearInterval(timer);reading?.abort();reading=undefined;}};};
  async function action(method,request={}){
    if(snapshot.busy||closed)return;version++;reading?.abort();publish({busy:true,error:''});
    try{let value=await rpc(method,request);if(!valid(value))throw Error('技能状态未完整返回。');publish({value});if(method==='check'&&value.candidate&&['available','failed'].includes(value.candidate.status)){value=await rpc('stage',{candidateId:value.candidate.id});if(!valid(value))throw Error('下载状态未完整返回。');publish({value});}}
    catch(error){publish({error:error.message||String(error)});}
    finally{publish({busy:false});}
  }
  function useState(){return React.useSyncExternalStore(subscribe,()=>snapshot);}
  function Dumbbell(){return h('svg',{width:19,height:19,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.65,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},h('path',{d:'M3 9v6m3-8v10m3-8v6m6-6v6m3-8v10m3-8v6M9 12h6M3 9h3m0-2h3m6 0h3m0 2h3M3 15h3m0 2h3m6 0h3m0-2h3'}));}
  function Details({state,onClose}){
    const value=state.value,candidate=value?.candidate;
    return h('section',{className:'cx-superpowers-detail','aria-label':'Superpowers 更新',onClick:event=>event.stopPropagation(),onKeyDown:event=>{if(event.key==='Escape'&&onClose){event.preventDefault();event.stopPropagation();onClose();}}},
      h('header',null,h('strong',null,'Superpowers'),onClose&&h('button',{type:'button','aria-label':'关闭技能详情',onClick:onClose},'×')),
      h('p',null,'当前 ',value?.active?.version||'未加载',' · ',value?.enabled?'已开启':'已关闭'),
      h('p',{className:'cx-superpowers-hint'},'作用于此 ColdX 配置的所有任务；技能正文按需加载。'),
      candidate&&h('div',{className:'cx-superpowers-update'},h('strong',null,'发现版本 ',candidate.version),h('code',null,candidate.commit.slice(0,8)),h('p',null,candidate.status==='ready'?`${candidate.changedSkills?.length??0} 个资源变化，等待确认装载。`:candidate.status==='downloading'?'正在下载候选版本…':candidate.message||'可下载候选版本。'),
        candidate.status==='ready'?h('button',{type:'button',className:'cx-superpowers-primary','aria-disabled':state.busy,onClick:()=>action('activate',{candidateId:candidate.id,expectedActiveCommit:value.active.commit})},'装载更新'):h('button',{type:'button','aria-disabled':state.busy||candidate.status==='downloading',onClick:()=>{if(candidate.status!=='downloading')return action('stage',{candidateId:candidate.id});}},'下载候选')),
      value?.pinnedOlderTasks>0&&h('p',{role:'status'},`${value.pinnedOlderTasks} 个正在运行的任务将在空闲后使用新版。`),
      h('label',{className:'cx-superpowers-auto'},h('input',{type:'checkbox',checked:value?.autoCheck??false,disabled:!value,'aria-disabled':state.busy||!value,onClick:event=>{if(state.busy)event.preventDefault();},onChange:event=>action('setting',{autoCheck:event.target.checked,expectedRevision:value.revision})}),'自动检查并下载更新候选'),
      h('button',{type:'button','aria-disabled':state.busy,onClick:()=>action('check')},state.busy?'处理中…':'检查更新'),
      h('a',{href:'https://github.com/obra/superpowers',target:'_blank',rel:'noopener noreferrer'},'上游源码 · MIT'),
      (state.error||value?.notice)&&h('p',{className:'cx-superpowers-error',role:'alert'},state.error||value.notice));
  }
  function SuperpowersControl(){
    const state=useState(),value=state.value,[open,setOpen]=React.useState(false);
    return h('div',{className:'cx-superpowers-control'},
      // Native ModelSelect closes on focus leaving its card. A pending save
      // must not hard-disable the focused button; action() guards admission.
      h('button',{type:'button',className:'cx-superpowers-toggle','aria-label':value?.enabled?'关闭 Superpowers':'开启 Superpowers','aria-pressed':value?.enabled??false,'aria-busy':state.busy,'aria-disabled':state.busy||!value,title:state.error||`Superpowers · ${value?.enabled?'开启':'关闭'}（所有任务）`,disabled:!value,onClick:event=>{event.stopPropagation();if(value)void action('setting',{enabled:!value.enabled,expectedRevision:value.revision});}},h(Dumbbell)),
      h('button',{type:'button',className:'cx-superpowers-info','data-update':Boolean(value?.candidate),'aria-label':value?.candidate?'查看 Superpowers 更新':'Superpowers 版本与设置','aria-expanded':open,onClick:event=>{event.stopPropagation();setOpen(!open);}},value?.candidate?'●':'·'),
      open&&h(Details,{state,onClose:()=>setOpen(false)}));
  }
  function SuperpowersSettingsRow(){const state=useState(),value=state.value,[open,setOpen]=React.useState(false);return h('section',{className:'cx-superpowers-settings'},
    h('div',{className:'cx-superpowers-settings-line'},h('div',null,h('strong',null,'Superpowers'),h('p',null,'按需使用设计、调试、测试与审查技能')),h('button',{type:'button','aria-label':'切换 Superpowers','aria-pressed':value?.enabled??false,disabled:state.busy||!value,onClick:()=>action('setting',{enabled:!value.enabled,expectedRevision:value.revision})},value?.enabled?'已开启':'已关闭'),h('button',{type:'button','aria-expanded':open,onClick:()=>setOpen(!open)},value?.candidate?'有可用更新':'版本与更新')),
    open&&h(Details,{state}),!open&&(state.error||value?.notice)&&h('p',{role:'alert',className:'cx-superpowers-error'},state.error||value.notice));}
  return{SuperpowersControl,SuperpowersSettingsRow,dispose(){closed=true;clearInterval(timer);reading?.abort();listeners.clear();}};
}
