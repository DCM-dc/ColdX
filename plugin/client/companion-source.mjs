// Serialized into the native DSH client. No model calls, polling or chat writes.
export function createCompanionComponents(React, settings, bodyHref) {
  const h=React.createElement;
  const labels={idle:'慢慢来，我在呢。',busy:'你忙你的，我陪着。',waiting:'等你点点头。',problem:'卡住也没关系，一起看看。'};
  const greetings=['摸到一团好心情。','给你一点毛茸茸的勇气。','今天也可以按自己的节奏来。'];
  let snapshot={sessionId:null,mood:'idle',caption:labels.idle};
  const listeners=new Set();
  const getSnapshot=()=>snapshot;
  const subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn);};
  function observe({sessionId=null,running=false,pending=0,lastKind}={}) {
    const mood=pending?'waiting':running?'busy':lastKind==='turn-error'?'problem':'idle';
    if(snapshot.sessionId===sessionId&&snapshot.mood===mood)return;
    snapshot={sessionId,mood,caption:labels[mood]};
    for(const listener of listeners)listener();
  }
  function forget(sessionId){if(snapshot.sessionId===sessionId)observe();}
  const petCaption=(mood,index)=>mood==='idle'?greetings[index%greetings.length]:labels[mood];
  function useSettings(){return React.useSyncExternalStore(fn=>settings.subscribe(fn),()=>settings.getSnapshot(),()=>settings.getSnapshot());}

  function Companion({wide=true}={}) {
    const preferences=useSettings();
    const enabled=preferences.status==='ready'&&preferences.value?.enabled===true;
    // Unmounting the creature stops every listener, timeout and animation.
    return enabled?h(Creature,{wide,canHide:preferences.writable===true}):null;
  }
  function Creature({wide,canHide}) {
    const state=React.useSyncExternalStore(subscribe,getSnapshot,getSnapshot);
    const [touch,setTouch]=React.useState(null),[saving,setSaving]=React.useState(false),[error,setError]=React.useState('');
    const [awake,setAwake]=React.useState(()=>!document.hidden);
    const body=React.useRef(null),eyes=React.useRef([]),animation=React.useRef(null),timer=React.useRef(null),touchCount=React.useRef(0);
    React.useEffect(()=>{
      const visible=()=>setAwake(!document.hidden);
      document.addEventListener('visibilitychange',visible);
      return()=>{document.removeEventListener('visibilitychange',visible);clearTimeout(timer.current);animation.current?.cancel();};
    },[]);
    React.useEffect(()=>{setTouch(null);clearTimeout(timer.current);},[state.sessionId,state.mood]);
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
      setTouch(petCaption(state.mood,touchCount.current++));
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
    const caption=error||touch||state.caption;
    return h('div',{className:'cx-companion','data-wide':wide,'data-mood':state.mood,'data-awake':awake,'data-petted':touch!==null},
      h('button',{type:'button',className:'cx-companion-pet',onClick:pet,'aria-label':'摸摸小绒','aria-description':caption,title:wide?'摸摸小绒':caption},
        h('span',{className:'cx-companion-body',ref:body,'aria-hidden':true},
          h('img',{src:bodyHref,alt:'',draggable:false,width:88,height:88}),
          h('span',{className:'cx-companion-eyes'},[0,1].map(index=>h('span',{key:index,className:'cx-companion-eye'},h('span',{className:'cx-companion-pupil',ref:node=>{eyes.current[index]=node;}},h('i'))))),
          h('span',{className:'cx-companion-spark','aria-hidden':true},'♡'))),
      wide&&h('div',{className:'cx-companion-copy'},h('span',{className:'cx-companion-name'},'小绒'),h('span',{className:'cx-companion-caption','aria-live':'polite','aria-atomic':true},caption)),
      wide&&canHide&&h('button',{className:'cx-companion-hide',type:'button','aria-label':'收起小绒，可在设置中重新开启',title:'收起小绒',disabled:saving,onClick:hide},'×'));
  }
  function CompanionSettingsRow(){
    const pref=useSettings(),[saving,setSaving]=React.useState(false),[error,setError]=React.useState('');
    const enabled=pref.status==='ready'&&pref.value?.enabled===true;
    async function toggle(){
      if(saving||pref.status!=='ready'||!pref.writable)return;
      setSaving(true);setError('');
      try{await settings.set('enabled',!enabled);}catch{setError('保存失败，请重试。');}finally{setSaving(false);}
    }
    return h('div',{className:'cx-terminal-settings cx-companion-settings'},
      h('div',{className:'cx-terminal-settings-copy'},h('span',{className:'cx-terminal-settings-title'},'小绒 · 毛球伙伴'),h('span',{className:'cx-terminal-settings-description'},'在侧栏陪你工作，点一下摸摸它。无声音，不消耗模型 Token。')),
      h('button',{type:'button',className:'cx-terminal-switch',role:'switch','aria-label':'显示毛球伙伴','aria-checked':enabled,'data-on':String(enabled),disabled:saving||pref.status!=='ready'||!pref.writable,onClick:toggle},h('span',{className:'cx-terminal-switch-thumb','aria-hidden':true})),
      error&&h('p',{className:'cx-terminal-settings-error',role:'alert'},error));
  }
  function SessionObserver({sessionId,session}) {
    const running=session?.running===true,pending=session?.pending?.length??0;
    const lastKey=session?.chat?.order?.at(-1),lastKind=session?.chat?.nodes?.get(lastKey)?.kind;
    React.useEffect(()=>{observe({sessionId,running,pending,lastKind});},[sessionId,running,pending,lastKind]);
    React.useEffect(()=>()=>forget(sessionId),[sessionId]);
    return null;
  }
  return {Companion,CompanionSettingsRow,SessionObserver,observe,forget,getSnapshot,subscribe,labels,petCaption,dispose(){listeners.clear();}};
}
