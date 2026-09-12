// Real native React + official isolated Chromium. No app build or user sessions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {createActivityComponents} from '../plugin/client/activity-source.mjs';
import {createWorkbenchPane} from '../plugin/client/workbench-pane-source.mjs';
import {createFileViewComponents} from '../plugin/client/file-view-source.mjs';
import {createFrostComponents} from '../plugin/client/frost-source.mjs';

test('work panel keeps desktop beside chat, separates task status, folds history, and preserves file/source actions',async()=>{
  const {chromium}=createRequire(realpathSync(new URL('../node_modules/@playwright/mcp/package.json',import.meta.url)))('playwright');
  const assets=new URL('../node_modules/.pnpm/@deepseek-ai+dsh-web-frontend@0.1.1-rc.2/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/',import.meta.url);
  const frontend=await readFile(new URL('index-ClqxG24t.js',assets),'utf8'),boot=frontend.lastIndexOf('const da=document.getElementById("root");');
  assert.ok(boot>0);
  const runtime=frontend.slice(0,boot)+'\nwindow.nativeModules=Jd();';
  const files=['coldx.css','native.css','frost.css','activity.css','terminal.css','layout.css','workbench.css','file-view.css','computer.css','ui-consistency.css'];
  const css=(await Promise.all(files.map(file=>readFile(new URL(`../plugin/client/${file}`,import.meta.url),'utf8')))).join('\n');
  const server=createServer(async(request,response)=>{
    const route=new URL(request.url,'http://localhost').pathname;
    try{
      if(route==='/'){
        response.setHeader('Content-Type','text/html; charset=utf-8');
        response.end('<!doctype html><html class="coldx-shell"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#242424;--dsw-alias-label-secondary:#727272;--dsw-alias-label-tertiary:#999;--dsw-alias-border-l2:#e4e4e4;--dsw-alias-state-error-primary:#c33;--dsw-alias-interactive-bg-hover:#f5f5f5;font:14px/1.5 Arial,"Microsoft YaHei",sans-serif}body{margin:0}#fixture{height:100dvh;display:flex}.fixture-sidebar{width:280px;flex:none;background:#f7f7f8;padding:24px;box-sizing:border-box;border-right:1px solid #ececee}.wSkVaW_root{height:100%;flex:1;min-width:0}.wSkVaW_header{height:70px;padding:0 24px;display:flex;align-items:center;justify-content:space-between;box-sizing:border-box}.wSkVaW_headerUtilities{display:flex;gap:8px}.wSkVaW_scrollBody{padding:32px;box-sizing:border-box;height:calc(100% - 70px)}.fixture-message{max-width:600px;margin:auto}.fixture-message h2{font-size:20px;font-weight:500;margin:0 0 16px}.fixture-message p{color:#727272;line-height:1.8}.fixture-composer{margin-top:180px;border:1px solid #e4e4e4;border-radius:20px;padding:18px;color:#888}@media(max-width:700px){.fixture-sidebar{display:none}.wSkVaW_header{padding:0 16px}.wSkVaW_scrollBody{padding:20px}}</style><div id="fixture"></div><script type="module" src="/runtime.js"></script>');return;
      }
      response.setHeader('Content-Type','text/javascript');
      if(route==='/runtime.js')response.end(runtime);
      else if(/^\/[a-zA-Z0-9_-]+\.js$/.test(route))response.end(await readFile(new URL(route.slice(1),assets)));
      else{response.statusCode=404;response.end();}
    }catch{response.statusCode=404;response.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await chromium.launch({headless:true});
    const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForFunction(()=>window.nativeModules);await page.addStyleTag({content:css});
    await page.evaluate(factories=>{
      const modules=window.nativeModules,React=modules.react,h=React.createElement;
      const factory=name=>new Function(`return (${factories[name]});`)();
      const pane=factory('pane')(React),frost=factory('frost')(React),activity=factory('activity')(React,frost);
      window.openedChildren=[];window.openedSources=[];window.fileRequests=[];
      const file=factory('file')(React,({text})=>h('p',null,text),async(sessionId,method,path)=>{
        window.fileRequests.push({sessionId,method,path});
        if(path==='.'){
          if(method==='readFile')throw new Error('Path is a directory');
          return{path,entries:[{path:'docs',name:'docs',kind:'directory'},{path:'outputs/report.md',name:'report.md',kind:'file'}]};
        }
        return method==='listFiles'?{path,entries:[]}:{path,name:'report.md',kind:'markdown',mime:'text/markdown',text:'Verified report content'};
      },undefined,{pane});
      const command='powershell -NoProfile -Command "Get-Content -LiteralPath C:/workspace/research-notes/output-report.md | Select-Object -First 180"';
      const nodes=Array.from({length:8},(_,i)=>({key:`call-${i}`,kind:'tool-call',anchorSeq:i+1,data:{root:{kind:'tool-result',callId:`call-${i}`,seq:i+1,time:Date.now()-(8-i)*1000,callTime:Date.now()-(9-i)*1000,call:{name:i===7?'shell':'read',argsRaw:'{}'},content:[],isError:false,subCalls:[],callView:i===7?{card:'terminal',title:command,cwd:'C:/workspace'}:{card:'generic',kind:'read',title:i===6?'写入研究结论':'检查工作区文件'},resultView:i===7?{card:'terminal',title:command,output:'REPORT_OK\nAll requested sections exist.',exitCode:0}:i===6?{card:'mutate',path:'outputs/report.md',operation:'write'}:{card:'read',path:'docs/notes.md',offset:i+1,totalLines:40,lines:[]}}}}));
      Object.assign(nodes[6].data.root,{call:{name:'edit',argsRaw:'{}'},callView:{card:'generic',kind:'edit',title:'写入研究结论',locations:[{path:'outputs/report.md'}]}});
      const snapshot={sessionId:'fixture',workspaceRoot:'C:/workspace',session:{sessionId:'fixture',composerPhase:'idle',running:false,pending:[],chat:{order:nodes.map(node=>node.key),nodes:new Map(nodes.map(node=>[node.key,node]))}},subagents:{entries:[{kind:'child',id:'child-qa',mode:'one-shot',label:'Review the implementation and validate its browser interactions',execution:{status:'completed',seq:10,time:Date.now()}}],parentAvailable:true},jobs:[],pages:{pages:[{pageId:'report-page',rootCallId:'page-call',title:'研究结论',subtitle:'已展示的页面',status:'displayed',sequence:9}]}};
      window.fixture={pane,file,activity,snapshot,command};
      h && modules['react-dom/client'].createRoot(document.getElementById('fixture')).render(h(React.Fragment,null,
        h('aside',{className:'fixture-sidebar'},h('strong',null,'ColdX'),h('p',null,'工作区'),h('p',null,'界面审查')),
        h('main',{className:'wSkVaW_root'},h('header',{className:'wSkVaW_header'},h('span',null,'界面与交互审查'),h('div',{className:'wSkVaW_headerUtilities'},h(file.FileWorkspace,{sessionId:'fixture'}),h(activity.ActivityLens,{snapshot,pane,onOpenSubagent:child=>window.openedChildren.push(child),onOpenExternal:url=>window.openedSources.push(url),onOpenFile:(path,line)=>file.open('fixture',path,line),onOpenOutput:output=>window.openedSources.push(output.pageId)}))),
        h('div',{className:'wSkVaW_scrollBody'},h('div',{className:'fixture-message'},h('h2',null,'已完成界面审查'),h('p',null,'检查记录、子任务和参考文件已整理在右侧工作面板。你可以继续对话，也可以展开历史查看具体操作。'),h('div',{className:'fixture-composer'},h('textarea',{className:'uV2eYG_input','aria-label':'继续对话',placeholder:'继续对话…'})))))));
    },{activity:createActivityComponents.toString(),pane:createWorkbenchPane.toString(),file:createFileViewComponents.toString(),frost:createFrostComponents.toString()});
    const trigger=page.locator('.cx-activity-trigger');await trigger.waitFor();
    assert.equal(await page.getByRole('button',{name:'查看工作区文件',includeHidden:true}).count(),0,'the removed header entry is not present in the accessibility or DOM tree');
    assert.equal(await page.locator('.cx-file-trigger').count(),0);
    assert.deepEqual(await page.evaluate(()=>window.fileRequests),[],'the hidden Files view does not read the workspace eagerly');
    await trigger.click();
    const panel=page.locator('dialog.cx-activity-sheet[open]');await panel.waitFor();
    const settle=target=>target.evaluate(node=>Promise.all(node.getAnimations().map(animation=>animation.finished.catch(()=>{}))));
    await settle(panel);
    assert.equal(await panel.getAttribute('data-mode'),'docked');
    assert.equal(await panel.evaluate(node=>node.matches(':modal')),false);
    const dimensions=await page.evaluate(()=>({panel:document.querySelector('dialog[open]').getBoundingClientRect().width,chat:document.querySelector('.wSkVaW_scrollBody').getBoundingClientRect().width}));
    assert.ok(Math.abs(dimensions.panel-440)<.1 && Math.abs(dimensions.chat-560)<.1,JSON.stringify(dimensions));
    await panel.getByRole('tab',{name:'文件',exact:true}).focus();await page.keyboard.press('Enter');
    const workspace=page.getByRole('dialog',{name:'工作面板 · 文件'});
    await workspace.locator('.cx-file-item').filter({hasText:'docs'}).waitFor();
    assert.deepEqual(await page.evaluate(()=>window.fileRequests),[{sessionId:'fixture',method:'readFile',path:'.'},{sessionId:'fixture',method:'listFiles',path:'.'}],'the first Files tab visit browses the owning workspace');
    assert.equal(await page.locator('dialog[open]').count(),1);
    await workspace.getByRole('tab',{name:'进度',exact:true}).focus();await page.keyboard.press('Enter');await panel.waitFor();
    assert.equal(await panel.locator('.cx-activity-counts').count(),0);
    assert.equal(await panel.locator('.cx-activity-now strong').innerText(),'命令执行已结束');
    const history=panel.locator('.cx-activity-history');assert.equal(await history.getAttribute('open'),null);
    assert.equal(await history.locator('.cx-activity-row:visible').count(),0);
    const title=await panel.locator('.cx-activity-agent-name').boundingBox(),status=await panel.locator('.cx-activity-agent-status').boundingBox();
    assert.ok(status.y>=title.y+title.height,'child title and outcome occupy separate lines');
    await panel.getByRole('button',{name:/打开子智能体 Review the implementation/}).click();
    assert.deepEqual(await page.evaluate(()=>window.openedChildren),[{parentSessionId:'fixture',childSessionId:'child-qa',mode:'one-shot'}]);
    const output=new URL('../outputs/ui-review/',import.meta.url);await mkdir(output,{recursive:true});
    await page.screenshot({path:new URL('activity-panel-1280.png',output).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
    await history.locator(':scope > summary').focus();await page.keyboard.press('Enter');
    assert.equal(await history.locator('.cx-activity-row:visible').count(),8);
    const terminal=history.locator('.cx-activity-row').last();await terminal.locator('summary').click();
    assert.equal(await terminal.locator('.cx-activity-command-detail').innerText(),await page.evaluate(()=>window.fixture.command));
    await panel.getByRole('tab',{name:'成果',exact:true}).click();
    await panel.getByRole('button',{name:'打开 研究结论',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.openedSources),['report-page']);
    await page.screenshot({path:new URL('activity-panel-results-1280.png',output).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
    await panel.getByRole('button',{name:'打开 outputs/report.md',exact:true}).click();
    await workspace.getByText('Verified report content',{exact:true}).waitFor();
    assert.equal(await page.locator('dialog[open]').count(),1,'deliverable file actions use the shared right pane');
    await workspace.getByRole('tab',{name:'成果',exact:true}).click();await panel.waitFor();
    await panel.getByRole('button',{name:'打开 docs/notes.md',exact:true}).click();
    const filePanel=page.getByRole('dialog',{name:'工作面板 · 文件'});await filePanel.locator('.cx-file-document:not([hidden])').getByText('Verified report content',{exact:true}).waitFor();
    assert.equal(await page.locator('dialog[open]').count(),1);
    assert.equal(await filePanel.getAttribute('data-mode'),'docked');
    assert.equal(await filePanel.getByRole('tab',{name:'文件',exact:true}).evaluate(node=>getComputedStyle(node).borderRadius),'0px');
    await filePanel.getByRole('tab',{name:'进度',exact:true}).focus();await page.keyboard.press('Enter');
    await panel.waitFor();
    assert.equal(await page.locator('dialog[open]').count(),1);
    await page.keyboard.press('Escape');assert.equal(await page.locator('dialog[open]').count(),0);
    assert.equal(await trigger.evaluate(node=>document.activeElement===node),true);
    await page.setViewportSize({width:375,height:812});await trigger.click();await panel.waitFor();
    await settle(panel);
    assert.equal(await panel.getAttribute('data-mode'),'drawer');assert.equal(await panel.evaluate(node=>node.matches(':modal')),true);
    const bounds=await panel.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=375);
    assert.equal(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth),true);
    const openHistory=panel.locator('.cx-activity-history[open] > summary');if(await openHistory.count())await openHistory.click();
    await page.screenshot({path:new URL('activity-panel-375.png',output).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
    await page.keyboard.press('Escape');assert.equal(await page.locator('dialog[open]').count(),0);
    assert.equal(await trigger.evaluate(node=>document.activeElement===node),true);
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
