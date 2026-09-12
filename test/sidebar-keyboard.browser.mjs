// Explicit regression: complete native workspace/runtime bundles and Primitives,
// real shipped React, isolated Chromium, in-memory session fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {applyStagedNativePatches} from '../scripts/desktop/native-patches.mjs';

test('native workspace tree keyboard navigation opens and folds exact rows without intercepting menus or input',async t=>{
  const dsh=createRequire(realpathSync(new URL('../node_modules/@deepseek-ai/dsh/package.json',import.meta.url)));
  const {chromium}=createRequire(realpathSync(new URL('../node_modules/@playwright/mcp/package.json',import.meta.url)))('playwright');
  let workspace=await readFile(dsh.resolve('@deepseek-ai/dsh-client-ui-workspace/client'),'utf8');
  if(!workspace.includes('function coldxWorkspaceTreeKeyDown(')){
    let patch;try{patch=await readFile(new URL('../patches/@deepseek-ai__dsh-client-ui-workspace@0.1.1-rc.2.patch',import.meta.url));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(patch){
      const stage=await mkdtemp(join(tmpdir(),'coldx-sidebar-patch-'));
      t.after(async()=>{if(!resolve(stage).startsWith(resolve(tmpdir())+sep))throw new Error('Unexpected stage boundary');await rm(stage,{recursive:true,force:true});});
      const name='@deepseek-ai/dsh-client-ui-workspace',version='0.1.1-rc.2',packageRoot=join(stage,'node_modules',name);
      await mkdir(join(packageRoot,'lib'),{recursive:true});await mkdir(join(stage,'desktop'));
      await writeFile(join(packageRoot,'package.json'),JSON.stringify({name,version}));await writeFile(join(packageRoot,'lib/client.js'),workspace);
      await writeFile(join(stage,'desktop/sidebar.patch'),patch);await writeFile(join(stage,'desktop/native-patches.json'),JSON.stringify({version:1,patches:[{name,version,specifier:`${name}@${version}`,path:'desktop/sidebar.patch',sha256:createHash('sha256').update(patch).digest('hex')}]}));
      await applyStagedNativePatches(stage);workspace=await readFile(join(packageRoot,'lib/client.js'),'utf8');
    }
  }
  workspace=workspace.replace('\t\texports.apply = apply;','\t\texports.testRows = {SessionTree,FlatList,SearchResultItem};\n\t\texports.apply = apply;');
  const nativeRuntime=await readFile(dsh.resolve('@deepseek-ai/dsh-client-runtime/client'),'utf8');
  const assets=new URL('../node_modules/.pnpm/@deepseek-ai+dsh-web-frontend@0.1.1-rc.2/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/',import.meta.url);
  const frontend=await readFile(new URL('index-ClqxG24t.js',assets),'utf8'),boot=frontend.lastIndexOf('const da=document.getElementById("root");');assert.ok(boot>0);
  const runtime=frontend.slice(0,boot)+'\nwindow.nativeModules=Jd();';
  const css=(await Promise.all(['native.css','workbench.css','ui-consistency.css'].map(file=>readFile(new URL(`../plugin/client/${file}`,import.meta.url),'utf8')))).join('\n');
  const server=createServer(async(request,response)=>{
    const route=new URL(request.url,'http://localhost').pathname;
    try{
      if(route==='/'){response.setHeader('Content-Type','text/html; charset=utf-8');response.end('<!doctype html><html class="coldx-shell"><meta charset="utf-8"><style>html{--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#171717;--dsw-alias-label-secondary:#666;--dsw-alias-label-tertiary:#888;--dsw-alias-border-l2:#ddd}body{margin:20px}#fixture{width:360px;height:600px}</style><button id="before">Before</button><div id="fixture"></div><input aria-label="Search draft"><script type="module" src="/runtime.js"></script>');return;}
      response.setHeader('Content-Type','text/javascript');
      if(route==='/runtime.js')response.end(runtime);else if(/^\/[a-zA-Z0-9_-]+\.js$/.test(route))response.end(await readFile(new URL(route.slice(1),assets)));else{response.statusCode=404;response.end();}
    }catch{response.statusCode=404;response.end();}
  });await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:900,height:900}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForFunction(()=>window.nativeModules);
    await page.evaluate(({nativeRuntime,workspace})=>{
      const modules=window.nativeModules,registry={};window.__ModuleLoader__={load:({id,factory})=>registry[id]=factory};
      const require=name=>{if(modules[name])return modules[name];const id=name.replace(/\/client$/,'');return modules[name]=registry[id](require);};
      (0,eval)(nativeRuntime);(0,eval)(workspace);
      const {SessionTree,FlatList,SearchResultItem}=require('@deepseek-ai/dsh-client-ui-workspace/client').testRows;
      const React=modules.react,h=React.createElement,Primitives=modules['@deepseek-ai/dsh-client-ui-primitives'];
      window.opened=[];window.renamed=[];window.expanded=[];
      const rows=['alpha','beta','gamma'].map((id,index)=>({id,displayTitle:id,blank:false,running:false,updatedAt:100-index,origin:'user'}));
      const list={phase:'loading',ids:rows.map(row=>row.id),byId:Object.fromEntries(rows.map(row=>[row.id,row]))};
      const useSessions=selector=>selector(list),workspaces=[{workspaceId:'one',title:'Workspace one',path:'C:/one',createdAt:'2026-01-01',sessionIds:['alpha','beta']},{workspaceId:'two',title:'Workspace two',path:'C:/two',createdAt:'2026-01-01',sessionIds:['gamma']}];
      const t=(key,value)=>key==='actions.session.aria'?`Actions ${value.name}`:key==='actions.workspace.aria'?`Workspace actions ${value.name}`:key;
      function App(){
        const [expansion,setExpansion]=React.useState({one:true,two:false}),[mode,setMode]=React.useState('tree'),[rename,setRename]=React.useState(null),[draft,setDraft]=React.useState('');window.mode=setMode;
        const shared={useSessions,open:id=>window.opened.push(id),forkSession(){},onSessionRename:(id,title)=>{setRename(id);setDraft(title);},onSessionArchive(){},archivedSessionIds:[],orderBy:'updated',sessionOrderByAccount:{},sessionUpdatedAtByAccount:{},syncSessionOrderAccount(){},setSessionOrder(){},t};
        return h(React.Fragment,null,mode==='tree'?h(SessionTree,{...shared,startSession(){},workspaces,onRenameRequest(){},onDeleteRequest(){},insertWorkspaceBefore(){},insertSessionBefore(){},groupExpansion:expansion,setGroupExpanded:(key,value)=>{window.expanded.push([key,value]);setExpansion(previous=>({...previous,[key]:value}));}}):mode==='flat'?h(FlatList,shared):h('div',{role:'tree'},rows.slice(0,2).map(row=>h(SearchResultItem,{key:row.id,result:{...row,title:row.displayTitle,runningSubagentCount:0,workspace:'one'},onOpen:shared.open,t}))),
          h(Primitives.Modal,{open:rename!==null,onClose:()=>setRename(null),title:'Rename session',children:h('input',{'aria-label':'Rename draft',value:draft,onChange:event=>setDraft(event.target.value),onKeyDown:event=>{if(event.key==='Enter'){window.renamed.push([rename,draft]);setRename(null);}}})}));
      }
      modules['react-dom/client'].createRoot(document.getElementById('fixture')).render(h(App));
    },{nativeRuntime,workspace});await page.addStyleTag({content:css});
    const tree=page.getByRole('tree'),items=tree.getByRole('treeitem');await items.first().waitFor({timeout:3000}).catch(error=>{assert.deepEqual(errors,[]);throw error;});assert.deepEqual(errors,[]);
    await page.getByRole('button',{name:'Before',exact:true}).focus();await page.keyboard.press('Tab');
    assert.equal(await items.first().evaluate(node=>document.activeElement===node),true,'Tab must reach the workspace row itself');
    assert.equal(await items.first().evaluate(node=>getComputedStyle(node).outlineWidth),'2px');
    await page.keyboard.press('ArrowDown');assert.equal(await items.nth(1).evaluate(node=>document.activeElement===node),true);
    const beta=page.locator('.YDXeBa_sessionRow').filter({hasText:'beta'});
    await beta.evaluate(node=>node.style.visibility='hidden');await page.keyboard.press('ArrowDown');
    assert.equal(await items.last().evaluate(node=>document.activeElement===node),true,'navigation skips CSS-hidden rows');
    await beta.evaluate(node=>node.style.visibility='');await page.keyboard.press('Home');await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');await page.keyboard.press('Space');assert.deepEqual(await page.evaluate(()=>window.opened),['alpha','alpha']);
    await page.keyboard.press('ArrowDown');assert.equal(await items.nth(2).evaluate(node=>document.activeElement===node),true);
    await page.keyboard.press('ArrowLeft');assert.equal(await items.first().evaluate(node=>document.activeElement===node),true,'left from a session focuses its owning workspace');
    await page.keyboard.press('ArrowLeft');await page.waitForFunction(()=>document.querySelectorAll('[role="treeitem"]').length===2);
    await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>document.querySelectorAll('[role="treeitem"]').length===4);
    await page.keyboard.press('ArrowRight');assert.equal(await items.nth(1).evaluate(node=>document.activeElement===node),true);
    await page.keyboard.press('End');assert.equal(await items.last().evaluate(node=>document.activeElement===node),true);
    await page.keyboard.press('ArrowDown');assert.equal(await items.last().evaluate(node=>document.activeElement===node),true,'last item is bounded');
    await page.keyboard.press('Home');assert.equal(await items.first().evaluate(node=>document.activeElement===node),true);
    await page.keyboard.press('ArrowUp');assert.equal(await items.first().evaluate(node=>document.activeElement===node),true,'first item is bounded');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Control+ArrowDown');assert.equal(await items.nth(1).evaluate(node=>document.activeElement===node),true);
    await items.nth(1).evaluate(node=>node.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,isComposing:true})));assert.equal(await items.nth(1).evaluate(node=>document.activeElement===node),true);
    await page.keyboard.press('Tab');assert.equal(await page.getByRole('button',{name:'Actions alpha',exact:true}).evaluate(node=>document.activeElement===node),true);
    await page.keyboard.press('Enter');const menu=page.getByRole('menu');await menu.waitFor();
    await menu.getByRole('menuitem').first().focus();await page.keyboard.press('Enter');await page.getByRole('textbox',{name:'Rename draft'}).waitFor();
    await page.getByRole('textbox',{name:'Rename draft'}).fill('edited title');await page.keyboard.press('Home');await page.keyboard.type('New ');await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(()=>window.renamed),[['alpha','New edited title']]);assert.deepEqual(await page.evaluate(()=>window.opened),['alpha','alpha'],'menu and rename Enter must not open the session');
    await page.getByRole('textbox',{name:'Search draft'}).fill('keep this');await page.keyboard.press('Home');await page.keyboard.type('Search ');assert.equal(await page.getByRole('textbox',{name:'Search draft'}).inputValue(),'Search keep this');
    for(const mode of ['flat','search']){
      await page.evaluate(mode=>window.mode(mode),mode);
      await page.waitForFunction(mode=>{const rows=document.querySelectorAll('[role="treeitem"]');return rows.length===(mode==='flat'?3:2)&&rows[0].getAttribute('aria-level')==='1'&&rows[0].tagName===(mode==='flat'?'DIV':'BUTTON');},mode);
      await items.first().focus();await page.keyboard.press('ArrowDown');assert.equal(await items.nth(1).evaluate(node=>document.activeElement===node),true);
      await page.keyboard.press('Space');assert.equal((await page.evaluate(()=>window.opened)).at(-1),'beta');
    }
    assert.deepEqual(errors,[]);
  }finally{await browser.close();await new Promise(done=>server.close(done));}
});

