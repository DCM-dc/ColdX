import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {dshRequire} from '../plugin/page-native.mjs';

async function fixture({sessionId,locked=false,commands=true}={sessionId:'owner'}){
  const source=await readFile(process.env.COLDX_CONVERSATION_CLIENT || dshRequire.resolve('@deepseek-ai/dsh-client-ui-conversation/client'),'utf8');
  const jsx=(type,props)=>({type,props});
  const React={memo:value=>value,useState:initial=>[typeof initial==='function'?initial():initial,()=>{}],useRef:current=>({current}),useMemo:factory=>factory(),useCallback:value=>value,useEffect(){},useLayoutEffect(){}};
  let native;
  vm.runInNewContext(source.replace('exports.ConversationController = ConversationController;','exports.__InputBar=InputBar; exports.ConversationController = ConversationController;'),{
    navigator:{userAgent:'Chrome'},window:{__ModuleLoader__:{load(record){native=record.factory(name=>name==='react'?React:name==='react/jsx-runtime'?{jsx,jsxs:jsx,Fragment:'fragment'}:name==='@deepseek-ai/cordis'?{Service:class{}}:{});}}},
  });
  const slots=new Map(),requests=[];
  const input={draft:'alpha beta',phase:'plain',draftRev:8,imageIds:[],queue:[],occurrences:[]},inputActions={setDraft:()=>{}};
  const tree=native.__InputBar({sessionId,disabled:locked,useSession:select=>select({}),useInput:select=>select(input),inputActions,keyboard:{},useNotices:select=>select(undefined),useLexicon:select=>select(new Map()),useMenuLauncher:select=>select(null),useProjection:()=>undefined,
    toggleCommandMenu:commands?selection=>requests.push(selection):undefined,t:value=>value,
    renderSlot(name,owner,options){slots.set(name,{owner,options});return options?.fallback??null;},
  });
  function find(node,type){if(!node)return null;if(Array.isArray(node))return node.map(item=>find(item,type)).find(Boolean);return node.type===type?node:find(node.props?.children,type);}
  return{source,slots,requests,input,inputActions,textarea:find(tree,'textarea')};
}

test('native add slot forwards the actual caret command launcher and leaves the old button as fallback',async()=>{
  const {source,slots,requests,input,inputActions,textarea}=await fixture();
  const {owner,options}=slots.get('conversation.input.add');
  assert.equal(owner.sessionId,'owner');assert.equal(owner.locked,false);assert.equal(owner.commandsAvailable,true);
  assert.equal(owner.input,input);assert.equal(owner.inputActions,inputActions);assert.equal(owner.input.draft,'alpha beta');
  assert.equal(owner.commandMenuOpen,false);
  const focusCalls=[];textarea.props.ref.current={selectionStart:3,selectionEnd:7,focus:options=>focusCalls.push(options)};
  assert.deepEqual(JSON.parse(JSON.stringify(owner.getInputSelection())),{start:3,end:7,draftRev:8});
  let prevented=false;owner.keepInputFocus({preventDefault(){prevented=true;}});owner.openCommands();
  assert.equal(prevented,true);assert.equal(focusCalls[0].preventScroll,true);
  assert.deepEqual(JSON.parse(JSON.stringify(requests)),[{start:3,end:7}]);
  const fallback=options.fallback.props.children;
  assert.equal(fallback.type,'button');assert.equal(fallback.props.className,'uV2eYG_add');assert.equal(fallback.props.disabled,false);
  assert.equal(fallback.props.onClick,owner.openCommands);assert.equal(fallback.props.onMouseDown,owner.keepInputFocus);
  assert.match(source, /"conversation\.input\.add": \{\s*kind: "single",\s*scope: "session-maybe"/);
});

test('native add owner preserves locked and absent-command states without fabricating a launcher',async()=>{
  const {slots,textarea,requests}=await fixture({sessionId:undefined,locked:true,commands:false});
  const {owner,options}=slots.get('conversation.input.add');
  assert.equal(owner.sessionId,undefined);assert.equal(owner.locked,true);assert.equal(owner.commandsAvailable,false);assert.equal(options.fallback.props.children.props.disabled,true);
  owner.openCommands();assert.equal(requests.length,0);
  textarea.props.ref.current={selectionStart:0,selectionEnd:0};owner.openCommands();assert.equal(requests.length,0);
});
