// Serialized into DSH's existing React client. The native ModelDirectory owns
// catalog, current selection and RPC; this component owns only unsent gestures.
export function createModelControlComponents(React) {
  const h=React.createElement;
  function modelEffortState(state) {
    const current=state?.current;
    const group=state?.groups?.find(item=>item.id===current?.provider);
    const model=group?.models?.find(item=>item.id===current?.model);
    const reasoning=model?.reasoning;
    const seen=new Set();
    const levels=(Array.isArray(reasoning?.efforts)?reasoning.efforts:[]).filter(level=>{
      if(typeof level?.id!=='string' || !level.id || typeof level.name!=='string' || !level.name || seen.has(level.id)) return false;
      seen.add(level.id);return true;
    });
    const effectiveEffort=current?.reasoningEffort ?? reasoning?.defaultEffort;
    const index=levels.findIndex(level=>level.id===effectiveEffort);
    return {current,levels,index,effectiveEffort,defaultEffort:reasoning?.defaultEffort,
      modelLabel:model?.name ?? current?.model ?? '选择模型',
      effortLabel:levels[index]?.name ?? (effectiveEffort===undefined?'默认':effectiveEffort),
      description:levels[index]?.description,
      adjustable:Boolean(model && levels.length>1),
      signature:JSON.stringify([reasoning?.defaultEffort,levels.map(level=>level.id)]),
    };
  }
  const gestureKeys=new Set(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown']);
  function ModelControl({sessionId,locked=false,available=true,directory,load,select,openModels,superpowersControl}) {
    const state=React.useSyncExternalStore(listener=>directory.subscribe(listener),()=>directory.getSnapshot());
    const model=modelEffortState(state);
    const identity=JSON.stringify([sessionId,model.current?.provider,model.current?.model]);
    const [preview,setPreview]=React.useState(null);
    const [pending,setPending]=React.useState(null);
    const [failure,setFailure]=React.useState(null);
    const [position,setPosition]=React.useState(null);
    const [sparkle,setSparkle]=React.useState(null);
    const [confirmed,setConfirmed]=React.useState(null);
    const mounted=React.useRef(true), live=React.useRef(null), draft=React.useRef(null), pointer=React.useRef(null), request=React.useRef(null);
    const id=React.useId();
    live.current={identity,directory,locked,available};
    const owns=()=>mounted.current && live.current?.identity===identity && live.current.directory===directory;
    const ownValue=value=>value?.identity===identity && value.directory===directory;
    const activePreview=ownValue(preview) && preview.baseline===model.effectiveEffort && preview.signature===model.signature ? preview : null;
    // A native settings refresh may supersede the save's directory update.
    // Keep the accepted value visible only while that refresh is outstanding.
    const activeConfirmed=state.status==='loading' && ownValue(confirmed) && confirmed.loadingSnapshot===state && confirmed.baseline===model.effectiveEffort && confirmed.signature===model.signature ? confirmed : null;
    const busy=state.status==='selecting' || ownValue(pending);
    const blocked=locked || !available || busy || state.status==='loading';
    // Native settings updates refresh this directory after a successful save.
    // Hard-disabling a focused control would blur and close ModelSelect; retain
    // focus with the known catalog while aria-disabled + guards block edits.
    const disabled=locked || !available || state.status==='loading' && !model.current;
    const activeFailure=ownValue(failure)?failure:null;
    const displayed=activePreview ?? activeConfirmed;
    const shownIndex=displayed?.index ?? Math.max(0,model.index);
    const shownLabel=displayed ? model.levels[shownIndex]?.name ?? model.effortLabel : model.effortLabel;
    const shownDescription=displayed ? model.levels[shownIndex]?.description : model.description;
    const activePosition=ownValue(position)?position:null;
    const fraction=activePosition?.fraction ?? (model.levels.length>1?shownIndex/(model.levels.length-1):0);
    const maximum=model.adjustable && shownIndex===model.levels.length-1 && fraction>=.999;
    const activeSparkle=ownValue(sparkle) && maximum?sparkle:null;
    React.useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;draft.current=null;pointer.current=null;request.current=null;};},[]);
    React.useEffect(()=>{
      draft.current=null;pointer.current=null;setPreview(null);setFailure(null);setPosition(null);
    },[identity,directory,model.effectiveEffort,model.signature]);
    React.useEffect(()=>{if(confirmed && !activeConfirmed)setConfirmed(null);},[confirmed,activeConfirmed]);
    function cancelPreview() {
      if(!owns()) return;
      draft.current=null;pointer.current=null;setPreview(null);setPosition(null);
    }
    function canEdit() {
      return owns() && !live.current.locked && live.current.available && !ownValue(request.current)
        && !['loading','selecting'].includes(directory.getSnapshot().status);
    }
    async function applyEffort(effort) {
      if(!canEdit()) return;
      const fresh=modelEffortState(directory.getSnapshot());
      if(!fresh.current || fresh.current.provider!==model.current?.provider || fresh.current.model!==model.current?.model) {cancelPreview();return;}
      if(effort!==undefined && !fresh.levels.some(level=>level.id===effort)) {cancelPreview();return;}
      if((effort ?? fresh.defaultEffort)===fresh.effectiveEffort) {cancelPreview();return;}
      const ticket={identity,directory,effort};request.current=ticket;setPending(ticket);setFailure(null);setSparkle(null);setConfirmed(null);
      try {
        const accepted=await select({provider:fresh.current.provider,model:fresh.current.model,...effort===undefined?{}:{reasoningEffort:effort}});
        if(!owns() || request.current!==ticket) return;
        if(accepted!==true) throw new Error(directory.getSnapshot().error || '推理强度设置失败，请重试。');
        const index=fresh.levels.findIndex(level=>level.id===(effort ?? fresh.defaultEffort));
        const loadingSnapshot=directory.getSnapshot();
        if(loadingSnapshot.status==='loading' && index>=0) setConfirmed({...ticket,index,baseline:fresh.effectiveEffort,signature:fresh.signature,loadingSnapshot});
        if(fresh.levels.length>1 && effort===fresh.levels.at(-1)?.id) setSparkle(ticket);
      } catch(error) {
        if(owns() && request.current===ticket) setFailure({...ticket,message:error?.message || String(error)});
      } finally {
        if(request.current===ticket) request.current=null;
        if(owns()) {setPending(null);cancelPreview();}
      }
    }
    function previewValue(event) {
      if(!canEdit() || !model.adjustable) {event.currentTarget.value=String(shownIndex);return;}
      const index=Number(event.currentTarget.value);
      if(!Number.isInteger(index) || index<0 || index>=model.levels.length) return;
      const value={identity,directory,index,baseline:model.effectiveEffort,signature:model.signature};
      draft.current=value;setPreview(value);setFailure(null);
    }
    function commitPreview() {
      const value=draft.current;
      if(!ownValue(value) || value.baseline!==model.effectiveEffort || value.signature!==model.signature) return;
      const effort=model.levels[value.index]?.id;
      if(effort===undefined) return;
      return applyEffort(effort);
    }
    function pointerDown(event) {
      if(!canEdit() || !model.adjustable || event.button!==undefined && event.button!==0) {event.preventDefault();return;}
      pointer.current={identity,directory,id:event.pointerId};
      setSparkle(null);
      event.currentTarget.setPointerCapture?.(event.pointerId);
      movePointer(event);
    }
    // The transparent native range still owns the value, focus and keyboard.
    // Only the decorative thumb follows continuous pointer coordinates; on
    // release it settles onto the exact supported native effort stop.
    function movePointer(event) {
      if(!owns() || !ownValue(pointer.current) || pointer.current.id!==event.pointerId || !canEdit()) return;
      const rect=event.currentTarget.getBoundingClientRect?.();
      if(!rect || rect.width<=24 || !Number.isFinite(event.clientX)) return;
      setPosition({identity,directory,fraction:Math.max(0,Math.min(1,(event.clientX-rect.left-12)/(rect.width-24)))});
    }
    function pointerUp(event) {
      if(!owns() || !ownValue(pointer.current) || pointer.current.id!==event.pointerId) return;
      pointer.current=null;
      setPosition(null);
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      return commitPreview();
    }
    function keyDown(event) {
      if(event.key==='Escape' && ownValue(draft.current)) {event.preventDefault();event.stopPropagation();cancelPreview();return;}
      if(gestureKeys.has(event.key)) {event.stopPropagation();if(!canEdit() || !model.adjustable)event.preventDefault();}
      if(event.key==='Enter' && ownValue(draft.current)) {event.preventDefault();event.stopPropagation();return commitPreview();}
    }
    function keyUp(event) {
      if(!gestureKeys.has(event.key)) return;
      event.stopPropagation();if(canEdit() && model.adjustable)return commitPreview();
    }
    if(!available) return null;
    const resetDisabled=blocked || !model.current || model.effectiveEffort===model.defaultEffort;
    const message=activeFailure?.message ?? state.error;
    return h('section',{className:'cx-model-control','aria-label':'模型与推理强度','aria-busy':busy,'data-preview':activePreview?'true':undefined,'data-dragging':activePosition?'true':undefined,'data-max':maximum?'true':undefined},
      h('header',{className:'cx-model-control-head','data-superpowers':Boolean(superpowersControl)},
        superpowersControl && h('div',{className:'cx-model-control-workflow'},superpowersControl),
        h('button',{type:'button',className:'cx-model-control-model','aria-label':`选择模型，当前 ${model.modelLabel}`,title:model.modelLabel,disabled,'aria-disabled':blocked,onClick:()=>{if(canEdit()){cancelPreview();openModels();}}},
          h('span',{className:'cx-model-control-name'},model.modelLabel),h('svg',{width:12,height:12,viewBox:'0 0 16 16',fill:'none','aria-hidden':true},h('path',{d:'m4 6 4 4 4-4',stroke:'currentColor',strokeWidth:1.5,strokeLinecap:'round',strokeLinejoin:'round'}))),
        h('button',{type:'button',className:'cx-model-control-reset','aria-label':'恢复模型默认强度',title:'恢复模型默认强度',disabled,'aria-disabled':resetDisabled,'data-at-default':model.effectiveEffort===model.defaultEffort?'true':undefined,onClick:()=>applyEffort(undefined)},
          h('svg',{width:18,height:18,viewBox:'0 0 24 24',fill:'none','aria-hidden':true},h('path',{d:'M4 10a8 8 0 1 1 1.9 8M4 4v6h6',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round'})))),
      h('div',{className:'cx-model-control-setting'},
        h('span',{className:'cx-model-control-caption'},'推理强度'),
        h('span',{className:'cx-model-control-value'},busy && h('span',{className:'cx-model-control-saving','aria-hidden':true},'保存中'),h('strong',{className:'cx-model-control-effort'},shownLabel))),
      h('div',{className:'cx-model-control-slider','data-unset':model.index<0 && !activePreview?'true':undefined},
        h('div',{className:'cx-model-control-track','aria-hidden':true},
          h('span',{className:'cx-model-control-fill',style:{clipPath:`inset(0 ${(1-fraction)*100}% 0 0 round 999px)`}}),
          h('span',{className:'cx-model-control-ticks'},model.levels.map((level,index)=>h('i',{key:level.id,'data-filled':index<=shownIndex?'true':undefined,style:{left:`${model.levels.length>1?index/(model.levels.length-1)*100:0}%`}}))),
          activeSparkle && h('span',{className:'cx-model-control-particles',onAnimationEnd:event=>{if(event.target===event.currentTarget && owns())setSparkle(value=>value===activeSparkle?null:value);}},Array.from({length:6},(_,index)=>h('i',{key:index,style:{left:`${9+index*16}%`,top:`${index%2?20:55}%`}})))),
        h('div',{className:'cx-model-control-thumb-lane','aria-hidden':true},h('span',{className:'cx-model-control-thumb-position',style:{transform:`translateX(${fraction*100}%)`}},h('span',{className:'cx-model-control-thumb'}))),
        h('input',{type:'range',min:0,max:Math.max(0,model.levels.length-1),step:1,value:shownIndex,disabled:disabled || !model.adjustable,'aria-disabled':blocked || !model.adjustable,
          'aria-label':'推理强度','aria-valuetext':shownLabel,'aria-describedby':`${id}-detail`,onChange:previewValue,
          onPointerDown:pointerDown,onPointerMove:movePointer,onPointerUp:pointerUp,onPointerCancel:cancelPreview,
          onLostPointerCapture:()=>{if(ownValue(pointer.current)) cancelPreview();},
          onKeyDown:keyDown,onKeyUp:keyUp,onBlur:()=>{if(!ownValue(request.current))cancelPreview();}})),
      h('p',{id:`${id}-detail`,className:'cx-model-control-detail',role:busy?'status':undefined},
        busy?'正在应用…':!model.adjustable?'此模型未提供可调推理档位。':activePreview?'预览中 · 松手应用，Esc 取消':shownDescription || (model.index<0?'使用模型默认强度；拖动可指定档位。':'拖动或使用方向键调整')),
      message && h('div',{className:'cx-model-control-error',role:'alert'},h('span',null,message),
        h('button',{type:'button',disabled,'aria-disabled':blocked,'aria-label':activeFailure?'重试推理强度设置':'重新加载模型目录',onClick:()=>{if(!blocked)return activeFailure?applyEffort(activeFailure.effort):load();}},'重试')));
  }
  return {ModelControl,modelEffortState};
}
