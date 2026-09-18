import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import path from 'node:path';
import {createSuperpowersComponents} from '../plugin/client/superpowers-source.mjs';
import {createModelControlComponents} from '../plugin/client/model-control-source.mjs';

test('dumbbell preserves model menu and draft; candidate version requires a separate load action',async()=>{
 const require=createRequire(process.env.COLDX_BROWSER_PACKAGES?path.join(process.env.COLDX_BROWSER_PACKAGES,'package.json'):realpathSync(new URL('../node_modules/@playwright/mcp/package.json',import.meta.url)));
 const {chromium}=require('playwright');
 const assets=new URL('../node_modules/.pnpm/@deepseek-ai+dsh-web-frontend@0.1.1-rc.2/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/',import.meta.url);
 const frontend=await readFile(new URL('index-ClqxG24t.js',assets),'utf8'),boot=frontend.lastIndexOf('const da=document.getElementById("root");');assert.ok(boot>0);
 const runtime=frontend.slice(0,boot)+'\nwindow.nativeModules=Jd();';
 const css=(await Promise.all(['workbench.css','model-control.css','superpowers.css'].map(name=>readFile(new URL('../plugin/client/'+name,import.meta.url),'utf8')))).join('\n');
 const server=createServer(async(req,res)=>{try{const route=new URL(req.url,'http://localhost').pathname;if(route==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html class="coldx-shell"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="fixture"></main><script type="module" src="/runtime.js"></script></body></html>');return;}res.setHeader('Content-Type','text/javascript');res.end(route==='/runtime.js'?runtime:await readFile(new URL(route.slice(1),assets)));}catch{res.statusCode=404;res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try {
  browser=await chromium.launch({headless:true,...process.env.COLDX_TEST_CHROMIUM?{executablePath:process.env.COLDX_TEST_CHROMIUM}:{}});const page=await browser.newPage({viewport:{width:760,height:640}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.nativeModules);await page.addStyleTag({content:css+'\n:root{--cx-wb-surface:#fff;--cx-wb-text:#202126;--cx-wb-muted:#717582;--cx-wb-line:#e6e7e9;--cx-wb-accent:#805ad5;--cx-wb-hover:#f5f5f7}body{font-family:Arial,sans-serif;margin:40px}#fixture{width:310px}.draft{display:block;width:100%;margin-bottom:18px}.model-popup{padding:14px;border:1px solid var(--cx-wb-line);border-radius:16px;background:var(--cx-wb-surface)}'});
  await page.evaluate(({superFactory,modelFactory})=>{
   const modules=window.nativeModules,React=modules.react,h=React.createElement;window.requests=[];window.rejectSetting=false;
   let state={enabled:false,autoCheck:true,active:{version:'6.3.0',commit:'a'.repeat(40)},candidate:null,revision:0,pinnedOlderTasks:0};
   const rpc=async(method,request)=>{window.requests.push({method,request});if(method==='setting'){if(window.rejectSetting)throw Error('设置写入失败');state={...state,...request,revision:state.revision+1};}if(method==='check')state={...state,candidate:{id:'b'.repeat(40),commit:'b'.repeat(40),version:'6.4.0',status:'ready',changedSkills:['skills/debug/SKILL.md']}};if(method==='activate')state={...state,active:{version:'6.4.0',commit:state.candidate.commit},candidate:null,revision:state.revision+1};return structuredClone(state);};
   const controls=new Function('return ('+superFactory+')')()(React,rpc),{ModelControl}=new Function('return ('+modelFactory+')')()(React);
   const snapshot={current:{provider:'deepseek',model:'deepseek-flash',reasoningEffort:'max'},groups:[{id:'deepseek',models:[{id:'deepseek-flash',name:'DeepSeek V4.1 Flash',reasoning:{defaultEffort:'high',efforts:[{id:'low',name:'Low'},{id:'high',name:'High'},{id:'max',name:'Max'}]}}]}],status:'ready'};
   const directory={subscribe:()=>()=>{},getSnapshot:()=>snapshot};window.nativeModules['react-dom/client'].createRoot(document.getElementById('fixture')).render(h(React.Fragment,null,h('textarea',{className:'draft','aria-label':'任务草稿',defaultValue:'保留这段输入'}),h('div',{className:'model-popup'},h(ModelControl,{sessionId:undefined,directory,load(){},select(){throw Error('Unexpected model mutation');},openModels(){},superpowersControl:h(controls.SuperpowersControl)}))));
  },{superFactory:createSuperpowersComponents.toString(),modelFactory:createModelControlComponents.toString()});
  const toggle=page.getByRole('button',{name:'开启 Superpowers',exact:true});await toggle.waitFor();await toggle.focus();await page.keyboard.press('Space');await page.getByRole('button',{name:'关闭 Superpowers',exact:true}).waitFor();
  assert.equal(await page.locator('.model-popup').isVisible(),true);assert.equal(await page.getByRole('textbox',{name:'任务草稿'}).inputValue(),'保留这段输入');assert.equal(await page.getByRole('slider').inputValue(),'2');
  await page.getByRole('button',{name:'Superpowers 版本与设置'}).click();await page.getByRole('button',{name:'检查更新',exact:true}).click();await page.getByRole('button',{name:'装载更新',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.requests.some(row=>row.method==='activate')),false);await page.getByRole('button',{name:'装载更新',exact:true}).click();await page.getByText('当前 6.4.0 · 已开启',{exact:true}).waitFor();
  const activated=await page.evaluate(()=>window.requests.find(row=>row.method==='activate'));assert.equal(activated.request.expectedActiveCommit,'a'.repeat(40));
  await page.getByRole('button',{name:'关闭技能详情'}).click();await page.evaluate(()=>{window.rejectSetting=true;});await page.getByRole('button',{name:'关闭 Superpowers',exact:true}).click();await page.getByRole('button',{name:'Superpowers 版本与设置'}).click();await page.getByRole('alert').filter({hasText:'设置写入失败'}).waitFor();assert.equal(await page.getByRole('button',{name:'关闭 Superpowers',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'关闭技能详情'}).click();await mkdir(new URL('../work/agent-workbench-qa/',import.meta.url),{recursive:true});await page.screenshot({path:new URL('../work/agent-workbench-qa/superpowers-light.png',import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/,'')});
  await page.addStyleTag({content:':root{--cx-wb-surface:#202327;--cx-wb-text:#eff1f4;--cx-wb-muted:#a4a6af;--cx-wb-line:#383b42;--cx-wb-hover:#2c3037;--cx-wb-accent:#b99afd}body{background:#17191c;color:#eff1f4}'});await page.setViewportSize({width:390,height:640});await page.screenshot({path:new URL('../work/agent-workbench-qa/superpowers-dark-mobile.png',import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/,'')});assert.deepEqual(errors,[]);
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
