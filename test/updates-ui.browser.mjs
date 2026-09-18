import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {createUpdateComponents} from '../plugin/client/updates-source.mjs';

test('native React update controls require version confirmation and retain retryable failures',async()=>{
 const {chromium}=createRequire(realpathSync(new URL('../node_modules/@playwright/mcp/package.json',import.meta.url)))('playwright');
 const assets=new URL('../node_modules/.pnpm/@deepseek-ai+dsh-web-frontend@0.1.1-rc.2/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/',import.meta.url);
 const frontend=await readFile(new URL('index-ClqxG24t.js',assets),'utf8'),boot=frontend.lastIndexOf('const da=document.getElementById("root");');assert.ok(boot>0);
 const runtime=frontend.slice(0,boot)+'\nwindow.nativeModules=Jd();';
 const server=createServer(async(req,res)=>{try{const route=new URL(req.url,'http://localhost').pathname;if(route==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="fixture"></div><script type="module" src="/runtime.js"></script>');return;}res.setHeader('Content-Type','text/javascript');res.end(route==='/runtime.js'?runtime:await readFile(new URL(route.slice(1),assets)));}catch{res.statusCode=404;res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:390,height:640}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForFunction(()=>window.nativeModules);
  await page.addStyleTag({content:await readFile(new URL('../plugin/client/updates.css',import.meta.url),'utf8')});
  await page.evaluate(factory=>{
   const modules=window.nativeModules,React=modules.react;
   window.requests=[];window.failInstall=true;
   let state={status:'ready',desktop:true,canInstall:true,currentVersion:'0.1.2',settings:{autoCheck:true,autoDownload:true},release:{version:'0.1.3',url:'https://github.com/DCM-dc/ColdX/releases/tag/v0.1.3',asset:{size:100}}};
   const rpc=async(method,request)=>{window.requests.push({method,request});if(method==='install'){if(window.failInstall)throw Error('请等待正在运行的任务结束，再安装更新。');state={...state,status:'launched'};}if(method==='setting')state={...state,settings:{...state.settings,...request}};return structuredClone(state);};
   const components=new Function('return ('+factory+')')()(React,rpc);modules['react-dom/client'].createRoot(document.getElementById('fixture')).render(React.createElement(components.UpdateSettingsRow));
  },createUpdateComponents.toString());
  await page.getByText('0.1.3 已下载并校验，等待安装',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.requests.some(x=>x.method==='install')),false);
  await page.getByRole('button',{name:'安装更新',exact:true}).click();await page.getByRole('group',{name:'确认安装 ColdX 更新'}).waitFor();
  assert.equal(await page.evaluate(()=>window.requests.some(x=>x.method==='install')),false);
  await page.getByRole('button',{name:'稍后',exact:true}).click();assert.equal(await page.getByRole('group',{name:'确认安装 ColdX 更新'}).count(),0);
  await page.getByRole('button',{name:'安装更新',exact:true}).click();await page.getByRole('button',{name:'确认安装',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'等待正在运行的任务'}).waitFor();assert.equal(await page.getByRole('button',{name:'安装更新',exact:true}).isEnabled(),true);
  await page.evaluate(()=>{window.failInstall=false;});await page.getByRole('button',{name:'安装更新',exact:true}).click();await page.getByRole('button',{name:'确认安装',exact:true}).click();await page.getByText('安装程序已打开',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.requests.filter(x=>x.method==='install').map(x=>x.request)),[{version:'0.1.3',confirmed:true},{version:'0.1.3',confirmed:true}]);
  await page.getByLabel('自动检查 GitHub 更新').uncheck();assert.equal(await page.getByLabel('自动检查 GitHub 更新').isChecked(),false);
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
