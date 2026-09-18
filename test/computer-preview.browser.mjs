// Explicit regression; uses the pinned DSH React runtime and a local browser.
// node --test test/computer-preview.browser.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import path from 'node:path';
import {createComputerComponents} from '../plugin/client/computer-source.mjs';

test('380px preview offers actual-size keyboard scrolling without a new capture or surface',async()=>{
  const require=createRequire(process.env.COLDX_BROWSER_PACKAGES ? path.join(process.env.COLDX_BROWSER_PACKAGES,'package.json') : import.meta.url);
  const {chromium}=require('playwright');
  const assets=new URL('../node_modules/.pnpm/@deepseek-ai+dsh-web-frontend@0.1.1-rc.2/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/',import.meta.url);
  const frontend=await readFile(new URL('index-ClqxG24t.js',assets),'utf8');
  const boot=frontend.lastIndexOf('const da=document.getElementById("root");');
  assert.ok(boot>0 && frontend.includes('Ce.version="18.3.1"'));
  const runtime=frontend.slice(0,boot)+'\nwindow.nativeModules=Jd();';
  const css=await readFile(new URL('../plugin/client/computer.css',import.meta.url),'utf8');
  const server=createServer(async(request,response)=>{
    const route=new URL(request.url,'http://localhost').pathname;
    try {
      if(route==='/'){response.setHeader('Content-Type','text/html');response.end('<!doctype html><html class="coldx-shell"><style>body{margin:0}#fixture{width:380px}</style><div id="fixture"></div><script type="module" src="/runtime.js"></script>');return;}
      response.setHeader('Content-Type','text/javascript');
      if(route==='/runtime.js') response.end(runtime);
      else if(/^\/[a-zA-Z0-9_-]+\.js$/.test(route)) response.end(await readFile(new URL(route.slice(1),assets)));
      else {response.statusCode=404;response.end();}
    }catch{response.statusCode=404;response.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await chromium.launch({headless:true,...process.env.COLDX_TEST_CHROMIUM ? {executablePath:process.env.COLDX_TEST_CHROMIUM} : {}});
    const context=await browser.newContext({viewport:{width:900,height:800}}),page=await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(()=>window.nativeModules);
    await page.addStyleTag({content:css});
    await page.evaluate(factory=>{
      const modules=window.nativeModules,React=modules.react;
      window.rpcCount=0;
      const {ComputerPreview}=new Function(`return (${factory});`)()(React,()=>{window.rpcCount++;throw new Error('A preview must not request a capture');});
      const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;
      const ctx=canvas.getContext('2d');ctx.fillStyle='#ccddee';ctx.fillRect(0,0,1280,720);ctx.fillStyle='#123';ctx.font='40px sans-serif';ctx.fillText('1280 × 720 test capture',700,600);
      const record={callId:'capture',surfaceLabel:'测试网页',previewAttachment:{mime:'image/png',base64:canvas.toDataURL('image/png').split(',')[1]}};
      window.fixtureRoot=modules['react-dom/client'].createRoot(document.getElementById('fixture'));window.fixtureRoot.render(React.createElement(ComputerPreview,{record}));
    },createComputerComponents.toString());
    const figure=page.locator('figure'),img=figure.locator('img'),viewport=figure.getByRole('region');
    await img.waitFor();
    await page.waitForFunction(()=>document.querySelector('figure img')?.naturalWidth===1280);
    assert.ok((await img.boundingBox()).width<=380);
    const src=await img.getAttribute('src');
    await page.getByRole('button',{name:'放大截图'}).focus();await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelector('figure')?.dataset.zoom==='actual');
    assert.equal((await img.boundingBox()).width,1280);
    assert.equal(await viewport.evaluate(node=>node.scrollWidth),1280);
    assert.ok(await viewport.evaluate(node=>node.scrollLeft > 400), 'zoom should retain the middle of the screenshot rather than show its empty upper-left corner');
    await page.keyboard.press('Tab');
    assert.equal(await viewport.evaluate(node=>document.activeElement===node),true);
    await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowDown');
    await page.waitForFunction(()=>{const node=document.querySelector('.cx-computer-image-viewport');return node.scrollLeft>0 && node.scrollTop>0;});
    await page.getByRole('button',{name:'适合宽度'}).focus();await page.keyboard.press('Space');
    await page.waitForFunction(()=>document.querySelector('figure')?.dataset.zoom==='fit');
    assert.ok((await img.boundingBox()).width<=380);
    assert.equal(await viewport.evaluate(node=>node.scrollLeft),0);
    assert.equal(await img.getAttribute('src'),src);
    assert.equal(await page.evaluate(()=>window.rpcCount),0);
    assert.equal(context.pages().length,1);
    assert.equal(await page.locator('dialog').count(),0);
    await page.evaluate(({factory,src})=>{
      const modules=window.nativeModules,React=modules.react;
      const {ComputerWorkspace}=new Function(`return (${factory});`)()(React,()=>{throw new Error('Zoom must not request an RPC');});
      window.workspaceActions=[];
      const state={snapshot:{records:[],browser:{connected:true,paused:true,activeTabId:'0',tabs:[],latestPreview:{mime:'image/png',base64:src.split(',')[1]}}},action:(method,request)=>window.workspaceActions.push({method,request})};
      window.fixtureRoot.render(React.createElement(ComputerWorkspace,{sessionId:'fixture',view:'browser',state}));
    },{factory:createComputerComponents.toString(),src});
    const liveImage=page.locator('.cx-computer-live-frame img'),liveViewport=page.locator('.cx-computer-live-frame');
    await liveImage.waitFor();await page.getByRole('button',{name:'按原尺寸查看截图'}).click();
    await page.waitForFunction(()=>document.querySelector('.cx-computer-live-frame')?.dataset.zoom==='actual');
    assert.equal((await liveImage.boundingBox()).width,1280);
    assert.ok(await liveViewport.evaluate(node=>node.scrollWidth>node.clientWidth&&node.scrollLeft>0));
    const coordinate=await liveViewport.evaluate(node=>{const r=node.getBoundingClientRect(),img=node.querySelector('img').getBoundingClientRect(),x=r.left+node.clientWidth/2,y=r.top+40;return{x,y,naturalX:Math.floor(x-img.left),naturalY:Math.floor(y-img.top)};});
    await page.mouse.click(coordinate.x,coordinate.y);
    assert.deepEqual(await page.evaluate(()=>window.workspaceActions),[{method:'browserAction',request:{action:'click',x:coordinate.naturalX,y:coordinate.naturalY}}]);
    await page.getByRole('button',{name:'截图适合宽度'}).click();assert.ok((await liveImage.boundingBox()).width<=380);
    assert.equal(await page.evaluate(()=>window.workspaceActions.length),1,'zoom remains local even during manual control');
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
