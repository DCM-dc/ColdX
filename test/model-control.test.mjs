import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createModelControlComponents} from '../plugin/client/model-control-source.mjs';

const levels=[{id:'off',name:'Off'},{id:'low',name:'Low'},{id:'high',name:'High'},{id:'max',name:'Max'}];
const initial=()=>({current:{provider:'deepseek',model:'flash',reasoningEffort:'high'},groups:[{id:'deepseek',name:'DeepSeek',models:[{id:'flash',name:'DeepSeek Flash',reasoning:{efforts:levels,defaultEffort:'high'}}]}],failures:[],routable:true,status:'ready',error:null});
function nodes(node){return !node || typeof node!=='object' ? [] : [node,...(node.props?.children??[]).flatMap(nodes)];}
const range=tree=>nodes(tree).find(node=>node.type==='input');
const button=(tree,label)=>nodes(tree).find(node=>node.type==='button' && node.props['aria-label']===label);
const event=(value,extra={})=>({currentTarget:{value:String(value),setPointerCapture(){},releasePointerCapture(){}},preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...extra});
function fixture({snapshot=initial(),select}={}){
  let cursor=0,effects=[],disposed=false,late=0,loads=0,opened=0;const cells=[],calls=[];
  const cell=make=>cells[cursor++]??=make();
  const React={createElement:(type,props,...children)=>({type,props:{...props,children:children.flat(Infinity)}}),
    useRef:value=>cell(()=>({current:value})),useId:()=>cell(()=>`model-${cursor}`),
    useState(initial){const item=cell(()=>({value:typeof initial==='function'?initial():initial}));return[item.value,value=>{if(disposed){late++;return;}item.value=typeof value==='function'?value(item.value):value;}];},
    useEffect(setup,deps){const item=cell(()=>({}));if(!item.deps || deps.some((value,i)=>!Object.is(value,item.deps[i]))){item.deps=deps;effects.push(()=>{item.cleanup?.();item.cleanup=setup();});}},
    useSyncExternalStore:(_subscribe,read)=>read(),
  };
  const api=createModelControlComponents(React), directory={getSnapshot:()=>snapshot,subscribe:()=>()=>{}};
  const props={sessionId:'one',available:true,locked:false,directory,load(){loads++;},openModels(){opened++;},async select(value){calls.push(value);if(select)return select(value,{set:value=>{snapshot=value;},get:()=>snapshot});snapshot={...snapshot,current:{...value},status:'ready'};return true;}};
  return {api,props,calls,get snapshot(){return snapshot;},setSnapshot(value){snapshot=value;},get late(){return late;},get loads(){return loads;},get opened(){return opened;},
    render(overrides={}){cursor=0;effects=[];const tree=api.ModelControl({...props,...overrides});for(const effect of effects)effect();return tree;},
    dispose(){for(const item of cells)item.cleanup?.();disposed=true;}};
}

test('model card uses the native exact-model effort catalog and native model navigation',()=>{
  const f=fixture(),tree=f.render();
  assert.equal(range(tree).props.max,3);
  assert.equal(range(tree).props['aria-valuetext'],'High');
  assert.doesNotMatch(JSON.stringify(tree),/Ultra|token|成本|价格/);
  button(tree,'选择模型，当前 DeepSeek Flash').props.onClick();assert.equal(f.opened,1);assert.equal(f.loads,0);
  const unsupported=initial();delete unsupported.groups[0].models[0].reasoning;f.setSnapshot(unsupported);
  assert.equal(range(f.render()).props.disabled,true);
  assert.match(JSON.stringify(f.render()),/未提供可调推理档位/);
  f.dispose();
});

test('profile workflow toggle is independent of the native model selection and slider draft',()=>{
  const f=fixture();let toggles=0;
  const control={type:'button',props:{'aria-label':'Superpowers',onClick:()=>{toggles++;},children:[]}};
  const tree=f.render({superpowersControl:control});
  assert.ok(nodes(tree).includes(control));
  button(tree,'Superpowers').props.onClick();assert.equal(toggles,1);assert.deepEqual(f.calls,[]);
  assert.equal(range(f.render({superpowersControl:control})).props['aria-valuetext'],'High');assert.equal(f.opened,0);f.dispose();
});

test('dragging previews immediately but admits exactly once on release',async()=>{
  const f=fixture();let tree=f.render(),input=range(tree);
  input.props.onPointerDown(event(2,{pointerId:8}));input.props.onChange(event(3));
  tree=f.render();assert.equal(range(tree).props['aria-valuetext'],'Max');assert.deepEqual(f.calls,[]);
  await range(tree).props.onPointerUp(event(3,{pointerId:8}));
  await input.props.onPointerUp(event(3,{pointerId:8}));
  assert.deepEqual(f.calls,[{provider:'deepseek',model:'flash',reasoningEffort:'max'}]);
  assert.equal(range(f.render()).props['aria-valuetext'],'Max');f.dispose();
});

test('keyboard submits on keyup while Escape and cancelled pointer gestures discard unsent values',async()=>{
  const f=fixture();let input=range(f.render());
  const down=event(2,{key:'ArrowLeft'});input.props.onKeyDown(down);assert.equal(down.stopped,true);assert.notEqual(down.prevented,true);
  input.props.onChange(event(1));assert.equal(f.calls.length,0);
  await range(f.render()).props.onKeyUp(event(1,{key:'ArrowLeft'}));
  assert.equal(f.calls[0].reasoningEffort,'low');
  input=range(f.render());input.props.onPointerDown(event(1,{pointerId:1}));input.props.onChange(event(3));
  const escape=event(3,{key:'Escape'});range(f.render()).props.onKeyDown(escape);
  await range(f.render()).props.onPointerUp(event(3,{pointerId:1}));
  assert.equal(f.calls.length,1);assert.equal(escape.prevented,true);assert.equal(range(f.render()).props['aria-valuetext'],'Low');
  input=range(f.render());input.props.onPointerDown(event(1,{pointerId:2}));input.props.onChange(event(0));input.props.onPointerCancel(event(0,{pointerId:2}));
  await input.props.onPointerUp(event(0,{pointerId:2}));assert.equal(f.calls.length,1);f.dispose();
});

test('reset removes the explicit override and a failed update keeps the authoritative effort with a retry',async()=>{
  const snap=initial();snap.current.reasoningEffort='max';const f=fixture({snapshot:snap});
  await button(f.render(),'恢复模型默认强度').props.onClick();
  assert.deepEqual(f.calls,[{provider:'deepseek',model:'flash'}]);assert.equal(range(f.render()).props['aria-valuetext'],'High');f.dispose();
  let fail=true;const g=fixture({select:async(selection,store)=>{if(fail){store.set({...store.get(),status:'error',error:'模型拒绝此档位'});return false;}store.set({...store.get(),current:selection,status:'ready',error:null});return true;}});
  let input=range(g.render());input.props.onChange(event(3));await input.props.onKeyUp(event(3,{key:'ArrowRight'}));
  const failed=g.render();assert.match(JSON.stringify(failed),/模型拒绝此档位/);assert.equal(range(failed).props['aria-valuetext'],'High');
  fail=false;await button(failed,'重试推理强度设置').props.onClick();assert.equal(range(g.render()).props['aria-valuetext'],'Max');g.dispose();
});

test('in-flight and stale-session callbacks cannot issue another selection or leak feedback',async()=>{
  let finish;const f=fixture({select:()=>new Promise(resolve=>{finish=resolve;})});
  const input=range(f.render());input.props.onChange(event(3));const pending=input.props.onKeyUp(event(3,{key:'ArrowRight'}));
  await input.props.onKeyUp(event(3,{key:'ArrowRight'}));assert.equal(f.calls.length,1);assert.equal(range(f.render()).props['aria-disabled'],true);
  f.render({sessionId:'two'});finish(false);await pending;
  assert.doesNotMatch(JSON.stringify(f.render({sessionId:'two'})),/设置失败/);
  input.props.onChange(event(0));await input.props.onKeyUp(event(0,{key:'ArrowLeft'}));assert.equal(f.calls.length,1);
  f.dispose();assert.equal(f.late,0);
});

test('external model changes cancel a local preview and unavailable addressed sessions cannot mutate',async()=>{
  const f=fixture();const input=range(f.render());input.props.onPointerDown(event(2,{pointerId:2}));input.props.onChange(event(3));
  const next=initial();next.current={provider:'deepseek',model:'other'};f.setSnapshot(next);f.render();
  await input.props.onPointerUp(event(3,{pointerId:2}));assert.deepEqual(f.calls,[]);
  const hidden=f.render({available:false});assert.equal(hidden,null);f.dispose();
});

test('accepted effort stays visible during refresh but a failed refresh cannot revive it on a later load',async()=>{
  let finish;const f=fixture({select:()=>new Promise(resolve=>{finish=resolve;})});
  const input=range(f.render());input.props.onChange(event(1));const save=input.props.onKeyUp(event(1,{key:'ArrowLeft'}));
  f.setSnapshot({...f.snapshot,status:'loading'});f.render();
  finish(true);await save;
  assert.equal(range(f.render()).props['aria-valuetext'],'Low');
  f.setSnapshot({...f.snapshot,status:'ready'});f.setSnapshot({...f.snapshot,status:'loading'});
  assert.equal(range(f.render()).props['aria-valuetext'],'High','a batched ready-to-loading transition must not reuse the old refresh confirmation');
  f.setSnapshot({...f.snapshot,status:'error',error:'目录刷新失败'});
  const failed=f.render();assert.equal(range(failed).props['aria-valuetext'],'High');assert.match(JSON.stringify(failed),/目录刷新失败/);
  f.setSnapshot({...f.snapshot,status:'loading',error:null});
  assert.equal(range(f.render()).props['aria-valuetext'],'High','a later load must not resurrect a previously held effort');
  f.dispose();
});

test('serialized model factory has no external module dependencies',()=>{
  const factory=vm.runInNewContext(`(${createModelControlComponents.toString()})`);
  const api=factory({createElement(){}});assert.equal(api.modelEffortState(initial()).effortLabel,'High');
});
