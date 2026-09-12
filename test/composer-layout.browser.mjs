// Explicit shipped React/native InputBar layout acceptance. No running ColdX
// instance, user's browser, model API, dependency install or build is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
import path from 'node:path';
import {dshRequire} from '../plugin/page-native.mjs';
import {createFrostComponents} from '../plugin/client/frost-source.mjs';
import {createSessionControls} from '../plugin/client/session-controls-source.mjs';
import {createAttachmentComponents} from '../plugin/client/attachment-source.mjs';
import {createMenuCatalog} from '../plugin/client/menu-catalog-source.mjs';

test('native composer has aligned text layers and nonoverlapping controls on desktop and narrow touch screens',async t=>{
  const require=createRequire(process.env.COLDX_BROWSER_PACKAGES?path.join(process.env.COLDX_BROWSER_PACKAGES,'package.json'):realpathSync(new URL('../node_modules/@playwright/mcp/package.json',import.meta.url)));
  const {chromium}=require('playwright');
  const assets=new URL('../node_modules/.pnpm/@deepseek-ai+dsh-web-frontend@0.1.1-rc.2/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/',import.meta.url);
  const frontend=await readFile(new URL('index-ClqxG24t.js',assets),'utf8'),boot=frontend.lastIndexOf('const da=document.getElementById("root");');
  assert.ok(boot>0 && frontend.includes('Ce.version="18.3.1"'));
  const runtime=frontend.slice(0,boot)+'\nwindow.nativeModules=Jd();';
  const native=await readFile(process.env.COLDX_CONVERSATION_CLIENT || dshRequire.resolve('@deepseek-ai/dsh-client-ui-conversation/client'),'utf8');
  assert.match(native,/renderSlot\("conversation\.input\.add",/,'the installed or candidate native add slot is required');
  const model=await readFile(dshRequire.resolve('@deepseek-ai/dsh-client-ui-model-selection/client'),'utf8');
  const plan=await readFile(dshRequire.resolve('@deepseek-ai/dsh-client-ui-plan/client'),'utf8');
  const pluginBuild=await readFile(new URL('../plugin/client/build.mjs',import.meta.url),'utf8');
  const names=pluginBuild.match(/\['coldx\.css',[\s\S]*?\]\.map\(path/)[0].match(/'([^']+\.css)'/g).map(name=>name.slice(1,-1));
  const css=(await Promise.all(names.map(name=>readFile(new URL('../plugin/client/'+name,import.meta.url),'utf8')))).join('\n');
  const server=createServer(async(request,response)=>{
    const route=new URL(request.url,'http://localhost').pathname;
    try{
      if(route==='/'){response.setHeader('Content-Type','text/html');response.end('<!doctype html><html class="coldx-shell"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/index-C6eRlFa6.css"><link rel="stylesheet" href="/vendor-CjyC-hUb.css"></head><body><div id="fixture" data-slot="root"></div><script type="module" src="/runtime.js"></script></body></html>');return;}
      response.setHeader('Content-Type',route.endsWith('.css')?'text/css':'text/javascript');
      if(route==='/runtime.js')response.end(runtime);
      else if(/^\/[a-zA-Z0-9_-]+\.(?:js|css)$/.test(route))response.end(await readFile(new URL(route.slice(1),assets)));
      else{response.statusCode=404;response.end();}
    }catch{response.statusCode=404;response.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  const reports=[];
  try{
    browser=await chromium.launch({headless:true,...process.env.COLDX_TEST_CHROMIUM?{executablePath:process.env.COLDX_TEST_CHROMIUM}:{}});
    for(const scenario of [
      {name:'desktop-760',viewport:1100,width:792,rail:0,touch:false},
      {name:'phone-390',viewport:390,rail:0,touch:false},
      {name:'phone-320',viewport:320,rail:0,touch:false},
      {name:'phone-390-rail',viewport:390,rail:64,touch:false},
      {name:'phone-320-rail',viewport:320,rail:64,touch:false},
      {name:'touch-390',viewport:390,rail:0,touch:true},
      {name:'touch-320',viewport:320,rail:0,touch:true},
      {name:'touch-390-rail',viewport:390,rail:64,touch:true},
      {name:'touch-320-rail',viewport:320,rail:64,touch:true},
    ])await t.test(scenario.name,async()=>{
      const page=await browser.newPage({viewport:{width:scenario.viewport,height:844},hasTouch:scenario.touch,isMobile:scenario.touch});
      page.setDefaultTimeout(5000);
      const errors=[];page.on('pageerror',error=>errors.push(error.message));
      try{
        await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForFunction(()=>window.nativeModules);
        await page.evaluate(({native,model,plan,factories,scenario})=>{
          const modules=window.nativeModules,React=modules.react,h=React.createElement;
          const createSnapshotStore=initial=>{let value=initial;const listeners=new Set();return{getSnapshot:()=>value,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},set(next){value=next;for(const fn of listeners)fn();},update(fn){const next={...value};fn(next);value=next;for(const fn of listeners)fn();}};};
          const runtime={createSnapshotStore};
          function load(source,expose){let value;window.__ModuleLoader__={load(record){value=record.factory(id=>modules[id]??(id==='@deepseek-ai/dsh-client-runtime/client'?runtime:{}));}};new Function(expose?source.replace('exports.ConversationController = ConversationController;','exports.__InputBar=InputBar; exports.__SessionInputShell=SessionInputShell; exports.ConversationController = ConversationController;'):source)();return value;}
          const conversation=load(native,true);
          // Load the actual model selector and plan CSS as the native app does.
          const models=load(model.replace('exports.ModelDirectory = ModelDirectory;','exports.__ModelSelect=ModelSelect; exports.ModelDirectory = ModelDirectory;'));
          load(plan);
          const frost=new Function(`return (${factories.frost});`)()(React);
          const {CodingModeChips,CodingModeControl}=new Function(`return (${factories.modes});`)()(React,frost);
          const {AttachmentControl}=new Function(`return (${factories.attachment});`)()(React,frost);
          const dict={'input.commands':'命令','input.send':'发送','input.accessMode':'权限模式：{name}','context.aria':'上下文已使用 {percent}','trigger.ariaEffort':'选择模型，当前 {model}，推理等级 {effort}','trigger.aria':'选择模型，当前 {model}','trigger.fallback':'选择模型','placeholder.default':'描述你想构建的内容'};
          const translate=(key,args={})=>Object.entries(args).reduce((text,[name,value])=>text.replaceAll('{'+name+'}',String(value)),dict[key]??key);
          const projections={plan:{active:true,pending:false},'coldx.codingMode':{goal:true},tokenUsage:{uncachedInputTokens:1,cacheReadTokens:99999},contextPressure:{projectedTokens:999999,contextWindow:1000000},permissions:{currentValue:'full-access',options:[{value:'full-access',name:'Full access'}]}};
          const useProjection=(key,select)=>select?select(projections[key]):projections[key];
          const directory=createSnapshotStore({current:{provider:'deepseek',model:'long-model',reasoningEffort:'max'},routable:true,groups:[{id:'deepseek',name:'DeepSeek',models:[{id:'long-model',name:'deepseek-v4.1-flash-very-long-model-name',reasoning:{efforts:[{id:'off',name:'Off'},{id:'max',name:'Max'}],defaultEffort:'max'}}]}],failures:[],status:'ready',error:null});
          const lexicon=new Map();
          const shell=new conversation.__SessionInputShell({});
          shell.setDraft('中文输入 @folder/reference/ 和 Mixed Latin words 测试换行及光标对齐。\n第二行包括 verylongcontinuousidentifier_01234567890123456789 以及一些中文。');
          window.nativeInputShell=shell;window.setFixtureDraft=shell.actions.setDraft;
          const scope={bail(carrier,event,request){if(carrier!==scope||event!=='slash/input-insert-text')return false;return shell.insertText(request.text,request.span);}};
          const catalog=new Function(`return (${factories.catalog});`)()({connection:{api:{skills:{list:async()=>({result:{ok:true,value:{skills:[{name:'local-writer',description:'Use the local writing workflow',modelInvocable:true}]}}})}}},sessions:{subagentAddress:()=>undefined,scope:()=>scope}});
          window.modeCommands=[];
          const command=async value=>{if(typeof value==='string'){window.modeCommands.push(value);if(value==='/coldx-goal off')projections['coldx.codingMode']={goal:false};else if(value==='/coldx-goal on')projections['coldx.codingMode']={goal:true};else if(value==='/plan off')projections.plan={active:false,pending:false};else if(value==='/plan')projections.plan={active:true,pending:false};window.refreshFixtureProjections?.();}return true;};
          const listFiles=async()=>[{kind:'file',path:'notes/layout.txt'}];
          const renderSlot=(name,owner,options)=>h('div',{'data-slot':name,style:{display:'contents'}},name==='conversation.input.add'?h(AttachmentControl,{...owner,unified:true,draft:owner.input?.draft,setDraft:owner.inputActions?.setDraft,listFiles,loadPlugins:catalog.load,onPickPlugin:(name,selection)=>catalog.pick('fixture',name,{input:owner.input,selection,locked:owner.locked}),modeItems:h(CodingModeControl,{sessionId:'fixture',useProjection,executeCommand:command,embedded:true})}):name==='conversation.input.plan'?h(CodingModeChips,{...owner,sessionId:'fixture',useProjection,executeCommand:command}):name==='conversation.input.model'?h(models.__ModelSelect,{...owner,sessionId:'fixture',available:true,directory,load:()=>{},select:command,t:translate,renderSlot:(_name,_owner,options)=>options.fallback}):options?.fallback??null);
          function Fixture(){
            const [,refresh]=React.useReducer(value=>value+1,0);window.refreshFixtureProjections=refresh;
            const input=React.useSyncExternalStore(shell.state.subscribe,shell.state.getSnapshot);
            return h('div',{className:'wSkVaW_root',style:{marginLeft:scenario.rail,width:scenario.width??scenario.viewport-scenario.rail,height:'auto'},'data-phase':'hero'},h('div',{className:'wSkVaW_composerSeat wSkVaW_composerHero'},h(conversation.__InputBar,{sessionId:'fixture',variant:'hero',useSession:select=>select({running:false,removed:false,subagent:null}),useInput:select=>select(input),inputActions:shell.actions,keyboard:shell,useNotices:select=>select(undefined),useLexicon:select=>select(lexicon),useMenuLauncher:select=>select(null),useProjection,renderSlot,command,t:translate,toggleCommandMenu:selection=>{window.commandSelection=selection;},leftItems:h('div',{'data-slot':'conversation.input.left',style:{display:'contents'}})})));
          }
          modules['react-dom/client'].createRoot(document.getElementById('fixture')).render(h(Fixture));
        },{native,model,plan,factories:{frost:createFrostComponents.toString(),modes:createSessionControls.toString(),attachment:createAttachmentComponents.toString(),catalog:createMenuCatalog.toString()},scenario});
        await page.addStyleTag({content:css});
        await page.addStyleTag({content:'html,body{margin:0}#fixture{--dsw-font-family:Arial,"Microsoft YaHei",sans-serif;--dsw-alias-label-primary:#25262b;--dsw-alias-label-secondary:#52545a;--dsw-alias-label-tertiary:#74777e;--dsw-alias-bg-base:#fff;--dsw-specific-input-major:#fff;--dsw-alias-state-business-primary:#6864c8;--dsw-alias-border-l2:#ddd;--dsw-alias-button-info-fill:#222}'});
        await page.locator('textarea.uV2eYG_input').waitFor();
        await page.evaluate(()=>document.fonts.ready);
        const inspect=()=>page.evaluate(()=>{
          const rect=node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};};
          const card=document.querySelector('[data-composer-card]'),row=document.querySelector('.uV2eYG_row');
          const controls=[...row.querySelectorAll('button')].filter(node=>node.getBoundingClientRect().width>0).map(node=>({name:node.getAttribute('aria-label')??node.textContent,class:node.className,...rect(node)}));
          const overlaps=[];for(let i=0;i<controls.length;i++)for(let j=i+1;j<controls.length;j++){const a=controls[i],b=controls[j];if(Math.min(a.right,b.right)-Math.max(a.x,b.x)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>1)overlaps.push([a.name,b.name]);}
          const layerNodes=['input','mirror','backdrop'].map(name=>document.querySelector('.uV2eYG_'+name));
          const metrics=['fontFamily','fontSize','lineHeight','fontWeight','fontStyle','letterSpacing','paddingTop','paddingRight','paddingBottom','paddingLeft','whiteSpace','wordBreak','overflowWrap','boxSizing'];
          const layers=layerNodes.map(node=>({rect:rect(node),metrics:Object.fromEntries(metrics.map(key=>[key,getComputedStyle(node)[key]])),scrollWidth:node.scrollWidth,clientWidth:node.clientWidth}));
          return{card:rect(card),row:rect(row),controls,overlaps,layers,coarse:matchMedia('(pointer:coarse)').matches,documentOverflow:document.documentElement.scrollWidth-innerWidth,cardOverflow:card.scrollWidth-card.clientWidth,grid:getComputedStyle(row).display};
        });
        const first=await inspect();
        await page.evaluate(()=>window.setFixtureDraft('短输入中文 test'));
        await page.waitForFunction(()=>document.querySelector('textarea').value==='短输入中文 test');
        const short=await inspect();
        const report={scenario,first,short,errors};reports.push(report);
        if(process.env.COLDX_LAYOUT_OUTPUT){await mkdir(process.env.COLDX_LAYOUT_OUTPUT,{recursive:true});await page.screenshot({path:path.join(process.env.COLDX_LAYOUT_OUTPUT,scenario.name+'.png'),fullPage:true});}
        assert.equal(await page.getByRole('button',{name:'Coding mode',exact:true}).count(),0);
        const add=page.getByRole('button',{name:'添加',exact:true});assert.equal(await add.count(),1);
        await page.locator('textarea').evaluate(node=>node.setSelectionRange(3,7));
        await add.click();const menu=page.getByRole('menu',{name:'添加到对话',exact:true});await menu.waitFor();
        await menu.locator('.cx-composer-plugin').waitFor();
        const menuRect=await menu.boundingBox();report.menu=menuRect;
        assert.equal(await menu.getByRole('menuitemcheckbox').count(),2);
        assert.ok(menuRect.x>=-1 && menuRect.x+menuRect.width<=scenario.viewport+1,'add menu must stay inside the viewport: '+JSON.stringify(menuRect));
        assert.ok(menuRect.y>=-1 && menuRect.y+menuRect.height<=845,'add menu must be reachable: '+JSON.stringify(menuRect));
        if(process.env.COLDX_LAYOUT_OUTPUT)await page.screenshot({path:path.join(process.env.COLDX_LAYOUT_OUTPUT,scenario.name+'-menu.png'),fullPage:true});
        await menu.getByRole('menuitem',{name:/文件和文件夹/}).click();
        await menu.getByRole('menuitem',{name:/工作区文件/}).click();
        await menu.getByRole('option',{name:/layout\.txt/}).click();
        await page.waitForFunction(()=>document.querySelector('textarea').value==='短输入中文 test @notes/layout.txt');
        assert.equal(await page.locator('textarea').evaluate(node=>document.activeElement===node),true,'file reference insertion keeps native input focus');
        await add.click();await menu.waitFor();
        const goal=menu.locator('[role="menuitemcheckbox"][data-mode="goal"]'),planChoice=menu.locator('[role="menuitemcheckbox"][data-mode="plan"]');
        assert.equal(await goal.getAttribute('aria-checked'),'true');await goal.click();await page.waitForFunction(()=>document.querySelector('[role="menuitemcheckbox"][data-mode="goal"]')?.getAttribute('aria-checked')==='false');
        await planChoice.click();await page.waitForFunction(()=>document.querySelector('[role="menuitemcheckbox"][data-mode="plan"]')?.getAttribute('aria-checked')==='false');
        assert.deepEqual(await page.evaluate(()=>window.modeCommands),['/coldx-goal off','/plan off']);
        assert.equal(await page.locator('[data-selected-mode]').count(),0);assert.equal(await page.getByRole('button',{name:'Coding mode',exact:true}).count(),0);
        await page.keyboard.press('Escape');assert.equal(await add.evaluate(node=>document.activeElement===node),true);
        const beforeSkill=await page.locator('textarea').inputValue();
        await page.locator('textarea').evaluate(node=>node.setSelectionRange(node.value.length,node.value.length));await add.click();await menu.waitFor();await menu.locator('.cx-composer-plugin').waitFor();
        await menu.getByRole('menuitem',{name:/文件和文件夹/}).focus();await page.keyboard.press('End');
        assert.match(await page.evaluate(()=>document.activeElement.textContent),/Local Writer/);
        assert.equal(await menu.getByRole('menuitem',{name:/命令与技能/}).count(),0,'skills appear directly in the + menu');
        await page.keyboard.press('Enter');await page.waitForFunction(expected=>document.querySelector('textarea').value===expected,beforeSkill+' /local-writer ');
        await page.evaluate(()=>window.nativeInputShell.undo());await page.waitForFunction(expected=>document.querySelector('textarea').value===expected,beforeSkill);
        await add.click();await menu.waitFor();await page.keyboard.press('Escape');
        assert.equal(await add.evaluate(node=>document.activeElement===node),true,'Escape restores focus to +');
        assert.deepEqual(errors,[],'fixture must render without runtime errors');
        for(const view of [first,short]){
          assert.deepEqual(view.overlaps,[],JSON.stringify(view));
          assert.ok(view.documentOverflow<=1 && view.cardOverflow<=1,JSON.stringify(view));
          for(const control of view.controls)assert.ok(control.x>=view.card.x-1 && control.right<=view.card.right+1,JSON.stringify({control,card:view.card}));
          for(const layer of view.layers.slice(1)){
            assert.deepEqual(layer.metrics,view.layers[0].metrics,'visible text and caret metrics must match');
            for(const key of ['x','y','w','h'])assert.ok(Math.abs(layer.rect[key]-view.layers[0].rect[key])<1,'text layer bounds '+key);
          }
          if(scenario.touch){assert.equal(view.coarse,true);for(const control of view.controls)assert.ok(control.w>=43.5 && control.h>=43.5,JSON.stringify({touchTarget:control}));}
        }
      }finally{await page.close();}
    });
  }finally{
    if(process.env.COLDX_LAYOUT_OUTPUT){await mkdir(process.env.COLDX_LAYOUT_OUTPUT,{recursive:true});await writeFile(path.join(process.env.COLDX_LAYOUT_OUTPUT,'report.json'),JSON.stringify(reports,null,2));}
    await browser?.close();await new Promise(resolve=>server.close(resolve));
  }
});
