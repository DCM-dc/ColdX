// Explicit UI regression: real native React, isolated official Chromium.
// node --test test/ui-consistency.browser.mjs (no build / app restart needed)
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {createFileViewComponents} from '../plugin/client/file-view-source.mjs';

test('chrome keyboard access, file tab visibility, themes and narrow settings retain usable geometry',async()=>{
  const dsh=createRequire(realpathSync(new URL('../node_modules/@deepseek-ai/dsh/package.json',import.meta.url)));
  const playwright=createRequire(realpathSync(new URL('../node_modules/@playwright/mcp/package.json',import.meta.url)))('playwright');
  const workspace=await readFile(dsh.resolve('@deepseek-ai/dsh-client-ui-workspace/client'),'utf8');
  const settings=await readFile(dsh.resolve('@deepseek-ai/dsh-client-ui-settings-general/client'),'utf8');
  const nativeCss=[...(workspace+settings).matchAll(/const css(?:\$\d+)? = ("(?:\\.|[^"\\])*");/g)].map(match=>JSON.parse(match[1])).join('\n');
  assert.ok(nativeCss.includes('.YDXeBa_rowActions{flex:none;align-items:center;gap:12px;display:none}'));
  const files=['coldx.css','native.css','frost.css','activity.css','terminal.css','layout.css','workbench.css','file-view.css','computer.css','ui-consistency.css'];
  const css=nativeCss+'\n'+(await Promise.all(files.map(file=>readFile(new URL(`../plugin/client/${file}`,import.meta.url),'utf8')))).join('\n');
  const assets=new URL('../node_modules/.pnpm/@deepseek-ai+dsh-web-frontend@0.1.1-rc.2/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/',import.meta.url);
  const frontend=await readFile(new URL('index-ClqxG24t.js',assets),'utf8'),boot=frontend.lastIndexOf('const da=document.getElementById("root");');
  assert.ok(boot>0);
  const runtime=frontend.slice(0,boot)+'\nwindow.nativeModules=Jd();';
  const server=createServer(async(request,response)=>{
    const route=new URL(request.url,'http://localhost').pathname;
    try{
      if(route==='/'){response.setHeader('Content-Type','text/html; charset=utf-8');response.end('<!doctype html><html class="coldx-shell"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#171717;--dsw-alias-label-secondary:#636363;--dsw-alias-label-tertiary:#777;--dsw-alias-border-l2:#ddd;--dsw-alias-state-error-primary:#c33}body{margin:0}.wSkVaW_root{width:min(380px,100vw);height:660px}.YDXeBa_sessionRow{display:flex;width:240px}.VOzbGW_navList{width:330px}.VOzbGW_navCell{display:flex}</style><div class="YDXeBa_sessionRow" tabindex="0" aria-label="测试任务"><span class="YDXeBa_title">任务</span><span class="YDXeBa_time">1 小时</span><div class="YDXeBa_rowActions"><button class="YDXeBa_iconButton" aria-label="会话操作">…</button></div></div><nav class="VOzbGW_navList">'+Array.from({length:8},(_,i)=>`<button class="VOzbGW_navCell${i===0?' VOzbGW_active':''}"><span class="VOzbGW_navLabel">设置分类 ${i+1}</span></button>`).join('')+'</nav><div class="wSkVaW_root"><div id="fixture"></div></div><section class="cx-terminal-panel"><div class="cx-terminal-record" data-status="running"><span class="cx-terminal-status-dot"></span></div></section><script type="module" src="/runtime.js"></script>');return;}
      response.setHeader('Content-Type','text/javascript');
      if(route==='/runtime.js') response.end(runtime);
      else if(/^\/[a-zA-Z0-9_-]+\.js$/.test(route)) response.end(await readFile(new URL(route.slice(1),assets)));
      else{response.statusCode=404;response.end();}
    }catch{response.statusCode=404;response.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await playwright.chromium.launch({headless:true});
    const context=await browser.newContext({viewport:{width:1000,height:900}}),page=await context.newPage();
    const setup=async target=>{await target.goto(`http://127.0.0.1:${server.address().port}/`);await target.waitForFunction(()=>window.nativeModules);await target.addStyleTag({content:css});};
    await setup(page);
    const action=page.getByRole('button',{name:'会话操作'});
    await page.locator('.YDXeBa_sessionRow').evaluate(node=>{node.removeAttribute('tabindex');node.setAttribute('role','treeitem');});
    await page.keyboard.press('Tab');assert.equal(await action.evaluate(node=>document.activeElement===node),true);
    assert.equal(await page.locator('.YDXeBa_rowActions').evaluate(node=>getComputedStyle(node).opacity),'1','keyboard focus exposes the native hidden row actions');
    assert.equal(await action.evaluate(node=>getComputedStyle(node).outlineWidth),'2px');
    await page.evaluate(factory=>{
      const modules=window.nativeModules,React=modules.react;
      window.files=new Function(`return (${factory});`)()(React,()=>null,async(_id,_method,path)=>({path,name:path,kind:'text',mime:'text/plain',text:path}));
      modules['react-dom/client'].createRoot(document.getElementById('fixture')).render(React.createElement(window.files.FileWorkspace,{sessionId:'test'}));
    },createFileViewComponents.toString());
    await page.evaluate(()=>{for(let i=0;i<12;i++)window.files.open('test',`long-file-name-${i}.txt`);});
    const selected=page.locator('.cx-file-tabs [aria-current="page"]');await selected.waitFor();
    assert.equal(await page.getByRole('button',{name:'查看工作区文件',includeHidden:true}).count(),0,'file previews do not add a duplicate header entry');
    await page.waitForFunction(()=>{const rail=document.querySelector('.cx-file-tabs'),tab=rail?.querySelector('[aria-current="page"]');return rail&&tab&&rail.scrollLeft>0&&tab.getBoundingClientRect().right<=rail.getBoundingClientRect().right+1;});
    assert.equal(await selected.evaluate(node=>node.parentElement.getBoundingClientRect().right<=node.closest('.cx-file-tabs').getBoundingClientRect().right+1),true,'the active tab close control must also remain visible');
    await page.evaluate(()=>window.files.open('test','long-file-name-0.txt'));
    await page.waitForFunction(()=>{const rail=document.querySelector('.cx-file-tabs'),tab=rail.querySelector('[aria-current="page"]');return tab.title==='long-file-name-0.txt'&&tab.getBoundingClientRect().left>=rail.getBoundingClientRect().left-1;});
    await selected.focus();assert.equal(await selected.evaluate(node=>getComputedStyle(node).outlineWidth),'2px');
    assert.equal(await page.locator('.cx-terminal-panel').evaluate(node=>getComputedStyle(node).animationName),'none');
    assert.equal(await page.locator('.cx-terminal-status-dot').evaluate(node=>getComputedStyle(node).animationName),'none');
    await page.setViewportSize({width:375,height:812});
    assert.ok((await page.locator('.VOzbGW_navList').boundingBox()).height<60,'mobile settings remain one scrollable row');
    assert.equal(await page.locator('.VOzbGW_navList').evaluate(node=>node.scrollWidth>node.clientWidth),true);
    await page.evaluate(()=>document.documentElement.style.setProperty('--dsw-alias-bg-base','#171717'));
    assert.notEqual(await selected.evaluate(node=>getComputedStyle(node.parentElement).backgroundColor),'rgb(255, 255, 255)');
    await page.emulateMedia({forcedColors:'active'});assert.equal(await selected.evaluate(node=>getComputedStyle(node.parentElement).outlineStyle),'solid');
    const touch=await browser.newContext({viewport:{width:375,height:812},isMobile:true,hasTouch:true});const mobile=await touch.newPage();await setup(mobile);
    assert.equal(await mobile.getByRole('button',{name:'会话操作'}).isVisible(),true,'no-hover devices expose the action without a hover gesture');
    assert.ok((await mobile.getByRole('button',{name:'会话操作'}).boundingBox()).height>=44);
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});

