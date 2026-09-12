import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createFileViewComponents } from '../plugin/client/file-view-source.mjs';
import { createWorkbenchPane } from '../plugin/client/workbench-pane-source.mjs';
import { createActivityComponents } from '../plugin/client/activity-source.mjs';

function mountFiles(responses = {}) {
  const instances=new Map(), effects=[], requests=[], mounted=[], destroyed=[];
  let current,cursor,dirty=true,tree,draft='继续',root;
  const cell=init=>current.hooks[cursor++]??=init();
  const React={Fragment:'fragment',createElement:(type,props,...children)=>({type,props:{...props,children:children.flat(Infinity)}}),
    useRef:value=>cell(()=>({current:value})),useState(initial){const owner=current,slot=cell(()=>({value:typeof initial==='function'?initial():initial}));return[slot.value,value=>{if(!owner.active)return;const next=typeof value==='function'?value(slot.value):value;if(!Object.is(next,slot.value)){slot.value=next;dirty=true;}}];},
    useEffect(setup,deps){const hook=cell(()=>({}));if(!hook.deps||deps.some((value,index)=>!Object.is(value,hook.deps[index]))){hook.deps=deps;effects.push(()=>{hook.cleanup?.();hook.cleanup=setup();});}},
    useSyncExternalStore(subscribe,read){const hook=cell(()=>({}));hook.read=read;hook.value=read();if(!hook.cleanup)hook.cleanup=subscribe(()=>{const next=hook.read();if(!Object.is(next,hook.value)){hook.value=next;dirty=true;}});return hook.value;},
  };
  const pane=createWorkbenchPane(React);
  // Geometry and native focus are covered by workbench-pane.test. This fixture
  // checks reconciliation, real request ownership and persistent preview state.
  pane.usePanel=()=>({});
  function Preview({name,title}) {
    const id=name??title,[value,setValue]=React.useState(1);
    React.useEffect(()=>{mounted.push(id);return()=>destroyed.push(id);},[]);
    return React.createElement('button',{'aria-label':`preview ${id}`,onClick:()=>setValue(value+1)},String(value));
  }
  const api=createFileViewComponents(React,()=>null,(sessionId,method,path,signal)=>{
    const request={sessionId,method,path,signal};requests.push(request);
    if(responses[path]) return Promise.resolve(responses[path]);
    if(path==='pending.txt')return new Promise(()=>{});
    return Promise.resolve({path,name:path,kind:path.endsWith('.pdf')?'pdf':'html',mime:path.endsWith('.pdf')?'application/pdf':'text/html',...(path.endsWith('.pdf')?{base64:'cGRm'}:{text:'<p>page</p>'})});
  },undefined,{pane,PdfPreview:Preview,HtmlPreview:Preview});
  const activity=createActivityComponents(React);
  const snapshot={sessionId:'a',session:{sessionId:'a',composerPhase:'active',chat:{order:[],nodes:new Map()}}};
  function App(){return React.createElement(React.Fragment,null,
    React.createElement(api.InputReferenceBridge,{sessionId:'a',input:{draft},inputActions:{setDraft:value=>{draft=value;dirty=true;}}}),
    React.createElement(api.FileWorkspace,{sessionId:'a'}),React.createElement(activity.ActivityLens,{sessionId:'a',snapshot,pane}));}
  const resolve=(vnode,path)=>{
    if(vnode==null||typeof vnode==='boolean')return null;
    if(typeof vnode!=='object')return String(vnode);
    if(typeof vnode.type==='function'){
      const key=`${path}:${vnode.type.name}`,instance=instances.get(key)??{hooks:[]};instances.set(key,instance);instance.active=true;instance.seen=true;current=instance;cursor=0;
      return resolve(vnode.type(vnode.props),`${key}/`);
    }
    const node={type:vnode.type,props:vnode.props,closest:()=>null,querySelector:()=>null};
    if(vnode.props.ref)vnode.props.ref.current=node;
    node.children=vnode.props.children.map((child,index)=>resolve(child,`${path}/${child?.props?.key??index}`)).filter(value=>value!==null);
    return node;
  };
  function render(){let rounds=0;while(dirty){assert.ok(++rounds<30,'file workspace settles');dirty=false;effects.length=0;for(const instance of instances.values())instance.seen=false;tree=resolve(React.createElement(App), 'root');for(const[key,instance]of instances){if(!instance.seen){instance.active=false;for(const hook of instance.hooks)hook.cleanup?.();instances.delete(key);}}for(const effect of [...effects])effect();}}
  const flatten=node=>typeof node==='object'&&node?[node,...node.children.flatMap(flatten)]:[];
  const text=node=>typeof node==='string'?node:node.children.map(text).join('');
  render();
  return{api,pane,requests,mounted,destroyed,get draft(){return draft;},get all(){return flatten(tree);},node:label=>flatten(tree).find(node=>node.props['aria-label']===label),text,
    render,async flush(){await delay(0);render();await delay(0);render();},click(node){node.props.onClick({detail:1,currentTarget:node});render();},
    dispose(){for(const instance of instances.values()){instance.active=false;for(const hook of instance.hooks)hook.cleanup?.();}instances.clear();}};
}

test('file tabs preserve PDF and HTML state through workbench switches and release closed tabs',async t=>{
  const f=mountFiles();t.after(()=>f.dispose());
  f.api.open('a','a.pdf');await f.flush();f.click(f.node('preview a.pdf'));assert.equal(f.text(f.node('preview a.pdf')),'2');
  f.api.open('a','b.html');await f.flush();f.click(f.node('preview b.html'));
  f.pane.open('a','timeline');f.render();assert.equal(f.all.find(node=>node.type==='dialog').props['data-open'],'false');
  assert.equal(f.all.filter(node=>node.type==='dialog'&&node.props['data-open']==='true').length,1,'progress replaces the file surface');
  f.pane.open('a','evidence');f.render();assert.equal(f.all.filter(node=>node.type==='dialog'&&node.props['data-open']==='true').length,1);
  f.pane.open('a','files');f.render();f.api.open('a','a.pdf');await f.flush();
  assert.equal(f.all.filter(node=>node.type==='dialog'&&node.props['data-open']==='true').length,1,'file selection cannot leave a second activity panel open');
  assert.equal(f.text(f.node('preview a.pdf')),'2');assert.equal(f.text(f.node('preview b.html')),'2');
  assert.deepEqual(f.mounted,['a.pdf','b.html']);assert.equal(f.requests.length,2,'revisiting tabs or progress does not reread files');
  f.api.reference('a','a.pdf','chosen text');f.render();assert.equal(f.pane.get('a').active,'files');assert.match(f.draft,/@"a.pdf"\n> chosen text/);
  f.click(f.node('关闭 a.pdf'));await f.flush();assert.deepEqual(f.destroyed,['a.pdf']);assert.equal(f.text(f.node('preview b.html')),'2');
  f.pane.close('a','files');f.render();f.pane.open('a','timeline');f.render();
  f.click(f.all.find(node=>node.props['data-workbench-tab']==='files'));await f.flush();assert.equal(f.requests.length,2);
});

test('the work panel files tab opens the workspace without a separate header button',async t=>{
  const f=mountFiles({'.':{path:'.',entries:[{path:'report.md',name:'report.md',kind:'file'}]}});t.after(()=>f.dispose());
  assert.equal(f.node('查看工作区文件'),undefined,'the duplicate entry is absent from the rendered tree, not CSS-hidden');
  assert.equal(f.requests.length,0,'an unopened file view must not read the workspace');
  f.pane.open('a','timeline');f.render();
  f.click(f.all.find(node=>node.props['data-workbench-tab']==='files'));await f.flush();
  assert.equal(f.pane.get('a').active,'files');
  assert.equal(f.all.filter(node=>node.type==='dialog'&&node.props['data-open']==='true').length,1);
  assert.ok(f.all.some(node=>node.props.title==='report.md'),'the first Files visit browses the workspace root');
  assert.deepEqual(f.requests.map(({sessionId,path})=>({sessionId,path})),[{sessionId:'a',path:'.'}]);
  f.click(f.all.find(node=>node.props.title==='report.md'));await f.flush();
  assert.ok(f.node('preview report.md'),'workspace entries still open their document preview');
  f.pane.close('a','files');f.render();f.api.setKnown('a',['report.md']);
  f.api.resolve('a','report.md').open();await f.flush();
  assert.equal(f.pane.get('a').active,'files','a native message file mention still reopens the shared preview');
  assert.equal(f.requests.filter(item=>item.path==='report.md').length,1,'reopening a known file retains the loaded preview');
  assert.equal(f.node('查看工作区文件'),undefined);
});

test('closing an in-flight tab aborts only that file read',async t=>{
  const f=mountFiles();t.after(()=>f.dispose());
  f.api.open('a','b.html');await f.flush();f.api.open('a','pending.txt');await f.flush();
  const pending=f.requests.find(item=>item.path==='pending.txt'),retained=f.requests.find(item=>item.path==='b.html');
  f.click(f.node('关闭 pending.txt'));await f.flush();assert.equal(pending.signal.aborted,true);assert.equal(retained.signal.aborted,false);
  assert.equal(f.node('preview b.html').type,'button');
});

test('directory filtering distinguishes no matches from an empty folder and recovers on clearing',async t=>{
  const f=mountFiles({'.':{path:'.',entries:[{path:'report.md',name:'report.md',kind:'file'}]},empty:{path:'empty',entries:[]}});t.after(()=>f.dispose());
  f.api.open('a');await f.flush();
  f.node('筛选当前文件夹').props.onChange({target:{value:'missing'}});f.render();
  assert.equal(f.text(f.node('文件筛选结果')),'没有匹配的文件。请尝试其他名称。');
  f.node('筛选当前文件夹').props.onChange({target:{value:''}});f.render();
  assert.equal(f.node('文件筛选结果'),undefined);
  assert.ok(f.all.some(node=>node.props.title==='report.md'));
  f.api.open('a','empty');await f.flush();
  assert.equal(f.text(f.node('文件筛选结果')),'文件夹为空。');
});
