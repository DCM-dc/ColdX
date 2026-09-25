import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkbenchShell } from '../plugin/client/workbench-shell-source.mjs';
import { createMessagePresentation } from '../plugin/client/message-presentation.mjs';
import { createFileViewComponents } from '../plugin/client/file-view-source.mjs';
import { createWorkbenchNavigation } from '../plugin/client/navigation-source.mjs';

const React = {
  createElement(type, props, ...children) { return { type, props: {...props, children} }; },
  useState(value) { return [typeof value === 'function' ? value() : value, () => {}]; },
  useRef(value) { return {current:value}; },
  useEffect() {},
};
const flatten = node => !node || typeof node !== 'object' ? [] : [node, ...(node.props?.children ?? []).flat(Infinity).flatMap(flatten)];

test('navigation reads native preference handles with their receiver and groups real workspace ids',()=>{
  const react={...React,useSyncExternalStore:(_subscribe,read)=>read()};
  const prefs={value:{pinned:['s']},getSnapshot(){return {value:this.value};},subscribe(){return()=>{};}};
  const ctx={settingsScope:{bind:()=>prefs},sessions:{list:{getSnapshot:()=>({ids:['s'],byId:{s:{id:'s',displayTitle:'Saved task',updatedAt:1}},current:'s'})}},workspaces:{list:{getSnapshot:()=>({items:[{workspaceId:'workspace',title:'Project',sessionIds:['s']}],archivedSessionIds:[]})}}};
  const {TaskList}=createWorkbenchNavigation(react,ctx,{icon:()=>null});
  const tree=TaskList({wide:true}),copy=JSON.stringify(tree);
  assert.match(copy,/置顶/);assert.match(copy,/Saved task/);assert.match(copy,/Project/);
});

test('task menu preserves rename editing and persists pins using the native field contract',async()=>{
  let values=[{id:'s',x:10,y:10},null,'','',false,{}],cursor=0;const writes=[];
  const react={...React,useSyncExternalStore:(_subscribe,read)=>read(),useState:initial=>{const slot=cursor++;if(values[slot]===undefined)values[slot]=initial;return [values[slot],value=>{values[slot]=value;}];}};
  const prefs={getSnapshot:()=>({value:{pinned:[]}}),subscribe(){},set:async(...args)=>writes.push(args)};
  const ctx={settingsScope:{bind:()=>prefs},sessions:{list:{getSnapshot:()=>({ids:['s'],byId:{s:{id:'s',displayTitle:'Task'}},current:'s'})}},workspaces:{list:{getSnapshot:()=>({items:[{workspaceId:'p',path:'/one'},{workspaceId:'q',path:'/two'}],archivedSessionIds:[]})}}};
  const {TaskList}=createWorkbenchNavigation(react,ctx,{icon:()=>null});
  let tree=TaskList({wide:true});
  await flatten(tree).find(node=>node.props?.role==='menuitem'&&node.props.children.includes('重命名')).props.onClick();
  assert.equal(values[1],'s','opening rename must not be cleared by operation completion');
  values=[{id:'s',x:10,y:10},null,'','',false,{}];cursor=0;tree=TaskList({wide:true});
  await flatten(tree).find(node=>node.props?.role==='menuitem'&&node.props.children.includes('置顶')).props.onClick();
  assert.deepEqual(writes,[['pinned',['s']]]);
  let restored=0;
  values[0]={id:'s',x:10,y:10,trigger:{focus:()=>restored++}};cursor=0;
  tree=TaskList({wide:true});
  flatten(tree).find(node=>node.props?.role==='menu').props.onKeyDown({key:'Escape',preventDefault(){},stopPropagation(){}});
  assert.equal(restored,1,'Escape returns keyboard focus to the originating task');
  assert.equal(flatten(tree).some(node=>node.props?.['aria-label']==='移至项目'),false,'native within-workspace reordering must not be offered as cross-project transfer');
});

test('local link presentation preserves native source and code while resolving the owning file', () => {
  const files=createFileViewComponents(React,()=>{},()=>{});
  const opened=[];
  const {prepare,AssistantMessage}=createMessagePresentation(React,{...files,open:(...args)=>opened.push(args)},'native-assistant');
  const source='[说明](./acceptance.md#L3) and [官网](https://example.com)\n`[代码](./code.md)`\n```md\n[示例](./sample.md)\n```';
  const result=prepare(source);
  assert.match(result.text,/`说明`/);
  assert.match(result.text,/\[官网\]\(https:\/\/example.com\)/);
  assert.match(result.text,/`\[代码\]\(\.\/code.md\)`/);
  assert.match(result.text,/```md\n\[示例\]\(\.\/sample.md\)\n```/);
  const node={data:{blocks:[{kind:'text',text:source}]}};
  const rendered=AssistantMessage({node,sessionId:'child',fileMentions:()=>undefined});
  rendered.props.fileMentions({}).resolve('说明').open();
  assert.deepEqual(opened,[['child','./acceptance.md',3]]);
  assert.equal(node.data.blocks[0].text,source);
  assert.equal(prepare('[x](javascript:alert) [x](data:text/plain,abc)').links.size,0);
});

test('file links disambiguate repeated labels across blocks and preserve unfinished streamed fences',()=>{
  const opened=[],files=createFileViewComponents(React,()=>{},()=>{});
  const {prepare,AssistantMessage}=createMessagePresentation(React,{...files,open:(...args)=>opened.push(args)},'native');
  const unfinished='```md\n[Example](./example.md)';
  assert.equal(prepare(unfinished).text,unfinished);
  const rendered=AssistantMessage({sessionId:'s',node:{data:{blocks:[{kind:'text',text:'[Source](./a.md#L2)'},{kind:'text',text:'[Source](./a.md#L8)'}]}}});
  const resolver=rendered.props.fileMentions({});
  resolver.resolve('./a.md:2').open();resolver.resolve('./a.md:8').open();
  assert.deepEqual(opened,[['s','./a.md',2],['s','./a.md',8]]);
});

test('summary opens real files and native children with their owning session', async () => {
  const calls = [];
  const { Summary } = createWorkbenchShell(React);
  const tree = Summary({ sessionId:'parent', model:{outputs:[{key:'file',kind:'file',path:'report.md',label:'report.md'}],sources:{web:[],workspace:[],session:[],loadedCount:0},subagents:[{key:'child',id:'child',kind:'child',mode:'continuable',label:'Review',status:'running',statusLabel:'运行中'}],computers:[]},
    onOpenOutput:output=>calls.push(output.path),onOpenSubagent:address=>calls.push(address),onOpenView:view=>calls.push(view) });
  const nodes = flatten(tree);
  await nodes.find(node=>node.props?.['aria-label']==='打开 report.md').props.onClick();
  await nodes.find(node=>node.props?.['aria-label']==='打开子智能体 Review').props.onClick();
  assert.deepEqual(calls,['report.md',{parentSessionId:'parent',childSessionId:'child',mode:'continuable'}]);
});

test('unknown or failed subagents are never reported as completed', () => {
  const { Summary } = createWorkbenchShell(React);
  const tree = Summary({sessionId:'p',model:{outputs:[],sources:{web:[],workspace:[],session:[],loadedCount:0},computers:[],subagents:[{key:'a',status:'failed',label:'A'},{key:'b',status:'unknown',label:'B'}]},onOpenView(){}});
  const copy = JSON.stringify(tree);
  assert.doesNotMatch(copy,/2 完成/);
  assert.match(copy,/1 失败/);
});

test('sidebar delegates selection and native settings instead of creating a second session store', () => {
  const { Sidebar } = createWorkbenchShell(React);
  const calls = [];
  const tree = Sidebar({collapsed:false,startSession:()=>calls.push('new'),toggleSidebar:()=>calls.push('toggle'),renderSlot:(name,props)=>({type:'seat',props:{name,...props}})});
  const nodes = flatten(tree);
  nodes.find(node=>node.props?.['aria-label']==='新对话').props.onClick();
  assert.deepEqual(calls,['new']);
  assert.ok(nodes.some(node=>node.type==='seat'&&node.props.name==='sidebar.workspaces'));
  assert.ok(nodes.some(node=>node.type==='seat'&&node.props.name==='sidebar.settings'));
});
