// Real React marketplace interactions against a bounded RPC fixture; no packages are installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
import path from 'node:path';
import {createMarketplaceComponents} from '../plugin/client/marketplace-source.mjs';

test('marketplace keeps discovery, installation truth and accessibility in one native sidebar action',async t=>{
  const require=createRequire(process.env.COLDX_BROWSER_PACKAGES?path.join(process.env.COLDX_BROWSER_PACKAGES,'package.json'):realpathSync(new URL('../node_modules/@playwright/mcp/package.json',import.meta.url)));
  const {chromium}=require('playwright');
  const assets=new URL('../node_modules/.pnpm/@deepseek-ai+dsh-web-frontend@0.1.1-rc.2/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/',import.meta.url);
  const frontend=await readFile(new URL('index-ClqxG24t.js',assets),'utf8'),boot=frontend.lastIndexOf('const da=document.getElementById("root");');
  assert.ok(boot>0);
  const runtime=frontend.slice(0,boot)+'\nwindow.nativeModules=Jd();';
  const css=(await Promise.all(['workbench.css','marketplace.css'].map(name=>readFile(new URL('../plugin/client/'+name,import.meta.url),'utf8')))).join('\n');
  const server=createServer(async(request,response)=>{
    const route=new URL(request.url,'http://localhost').pathname;
    try{
      if(route==='/'){response.setHeader('Content-Type','text/html');response.end('<!doctype html><html class="coldx-shell"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#202126;--dsw-alias-label-secondary:#717582}body{margin:0;font-family:Arial,sans-serif}#fixture{position:absolute;bottom:8px;left:12px;width:220px}.hHd-Xa_footArea{display:flex;flex-direction:column}.hHd-Xa_footerActions{display:flex}button{font:inherit}</style></head><body><div id="fixture"></div><script type="module" src="/runtime.js"></script></body></html>');return;}
      response.setHeader('Content-Type','text/javascript');
      if(route==='/runtime.js')response.end(runtime);
      else if(/^\/[a-zA-Z0-9_-]+\.js$/.test(route))response.end(await readFile(new URL(route.slice(1),assets)));
      else{response.statusCode=404;response.end();}
    }catch{response.statusCode=404;response.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  try{
    browser=await chromium.launch({headless:true,...process.env.COLDX_TEST_CHROMIUM?{executablePath:process.env.COLDX_TEST_CHROMIUM}:{}});
    const page=await browser.newPage({viewport:{width:1200,height:840}});page.setDefaultTimeout(6500);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForFunction(()=>window.nativeModules);
    await page.addStyleTag({content:css});
    await page.evaluate(factory=>{
      const modules=window.nativeModules,React=modules.react,h=React.createElement;
      const repos=[{id:'sample/skills',name:'Workspace Skills',description:'为工作区增加可以复用的技能。',url:'https://github.com/sample/skills',stars:128,updatedAt:'2026-09-12'},{id:'sample/unverified',name:'Unverified Tools',description:'只有源码的扩展。',url:'https://github.com/sample/unverified',stars:2,updatedAt:'2026-09-11'}];
      window.requests=[];window.marketState={installs:[],agentInstallEnabled:true,notice:'暂时无法核实插件加载状态'};window.failState=false;window.failInstall=false;window.holdNextState=false;window.installTime=9;
      const api=async(method,request,signal)=>{
        window.requests.push({method,request});signal?.throwIfAborted();
        if(method==='search')return{items:repos.filter(repo=>(repo.name+' '+repo.description).toLowerCase().includes(request.query.toLowerCase())),page:1,hasMore:false};
        if(method==='detail')return{...repos.find(repo=>repo.id===request.id),packages:request.id==='sample/skills'?[{id:'dsh-workspace-skills',name:'dsh-workspace-skills',version:'1.2.3',description:'可复用工作区技能',installable:true,sourceUrl:'https://www.npmjs.com/package/dsh-workspace-skills',kind:'bundle'}]:[{id:'unverified',name:'Unverified Tools',installable:false,reason:'未找到经过校验的发布包。',kind:'unknown'}],readme:'<img src=x onerror="window.untrustedRan=true">\n# Workspace plugin\nInstall the published package.'};
        if(method==='state'){
          if(window.failState)throw new Error('无法读取安装状态');
          const value=structuredClone(window.marketState);
          if(window.holdNextState){window.holdNextState=false;await new Promise(resolve=>{window.releaseState=resolve;});}
          return value;
        }
        if(method==='install'){
          if(window.failInstall)throw new Error('包下载失败，请重试');
          const record={...request,version:'1.2.3',status:'installing',message:'正在下载插件',updatedAt:window.installTime};
          window.marketState.installs=[record];return structuredClone(record);
        }
        if(method==='setting'){window.marketState.agentInstallEnabled=request.agentInstallEnabled;return structuredClone(window.marketState);}
        throw new Error('Unexpected RPC '+method);
      };
      const {MarketplaceEntry}=new Function('return ('+factory+')')()(React,{},api);
      modules['react-dom/client'].createRoot(document.getElementById('fixture')).render(h('div',{className:'hHd-Xa_footArea'},h('div',{className:'hHd-Xa_footerActions'},h(MarketplaceEntry,{wide:true})),h('button',{type:'button'},'设置')));
    },createMarketplaceComponents.toString());

    await t.test('entry is above settings and search/detail never execute repository content',async()=>{
      const trigger=page.getByRole('button',{name:'插件市场',exact:true});await trigger.waitFor();
      assert.deepEqual(await page.evaluate(()=>window.requests),[],'opening is the boundary for network discovery');
      const entry=await trigger.boundingBox(),settings=await page.getByRole('button',{name:'设置',exact:true}).boundingBox();assert.ok(entry.y+entry.height<=settings.y+1);
      await trigger.click();await page.getByRole('dialog',{name:'插件市场',exact:true}).waitFor();
      assert.equal(await page.getByRole('searchbox',{name:'搜索插件'}).evaluate(node=>node===document.activeElement),true);
      await page.getByRole('button',{name:'查看 Unverified Tools',exact:true}).click();
      await page.getByText('未找到经过校验的发布包。',{exact:true}).waitFor();
      assert.equal(await page.getByRole('button',{name:'安装插件 Unverified Tools',exact:true}).count(),0);
      await page.getByText('使用说明',{exact:true}).click();assert.equal(await page.locator('.cx-marketplace-readme img').count(),0);
      assert.equal(await page.evaluate(()=>window.untrustedRan),undefined);
      await page.getByRole('searchbox',{name:'搜索插件'}).fill('Workspace');
      await page.getByRole('button',{name:'查看 Unverified Tools',exact:true}).waitFor({state:'hidden'});
      await page.getByRole('button',{name:'查看 Workspace Skills',exact:true}).click();
      await page.getByRole('button',{name:'安装插件 dsh-workspace-skills',exact:true}).waitFor();
      assert.equal((await page.evaluate(()=>window.requests)).filter(call=>call.method==='install').length,0);
      await page.getByRole('button',{name:'刷新插件市场',exact:true}).click();
      await page.waitForFunction(()=>window.requests.some(call=>call.method==='search'&&call.request.refresh));
      await page.getByRole('searchbox',{name:'搜索插件'}).fill('Skills');
      await page.waitForFunction(()=>window.requests.some(call=>call.method==='search'&&call.request.query==='Skills'));
      assert.equal(await page.evaluate(()=>window.requests.findLast(call=>call.method==='search').request.refresh),false,'typing after a manual refresh returns to cached discovery');
      assert.equal(await page.getByText('暂时无法核实插件加载状态',{exact:true}).count(),1,'host verification/persistence notices remain visible alongside the catalog');
    });

    await t.test('install admission stays pending until backend status confirms and failure is retryable',async()=>{
      await page.getByRole('button',{name:'安装插件 dsh-workspace-skills',exact:true}).dblclick();
      await page.getByText('正在下载插件',{exact:true}).waitFor();
      assert.equal((await page.evaluate(()=>window.requests)).filter(call=>call.method==='install').length,1,'double click admits one job');
      assert.equal(await page.getByRole('button',{name:'安装插件 dsh-workspace-skills',exact:true}).count(),0);
      await page.evaluate(()=>{window.installTime=11;window.marketState.installs[0]={...window.marketState.installs[0],status:'failed',message:'下载暂时失败',log:'download failed',updatedAt:10};});
      await page.getByRole('button',{name:'重试安装 dsh-workspace-skills',exact:true}).waitFor();
      await page.getByRole('button',{name:'重试安装 dsh-workspace-skills',exact:true}).click();
      assert.equal((await page.evaluate(()=>window.requests)).filter(call=>call.method==='install').length,2);
      await page.evaluate(()=>{window.marketState.installs[0]={...window.marketState.installs[0],status:'needs-config',message:'请配置访问令牌后启用',updatedAt:Date.now()};});
      await page.getByText('请配置访问令牌后启用',{exact:true}).waitFor();
      assert.equal(await page.getByRole('button',{name:'安装插件 dsh-workspace-skills',exact:true}).count(),0,'configured dependency is not offered for duplicate install');
      await page.getByRole('tab',{name:'已安装',exact:true}).click();await page.getByText('需要配置',{exact:true}).waitFor();
      await page.evaluate(()=>{window.holdNextState=true;});
      await page.waitForFunction(()=>typeof window.releaseState==='function');
      await page.getByRole('checkbox',{name:'允许 AI 按需安装插件',exact:true}).uncheck();
      await page.waitForFunction(()=>window.marketState.agentInstallEnabled===false);
      await page.evaluate(()=>{window.releaseState();window.releaseState=undefined;});
      await page.waitForTimeout(100);
      assert.equal(await page.getByRole('checkbox',{name:'允许 AI 按需安装插件',exact:true}).isChecked(),false,'old polling snapshot does not reverse a saved preference');
    });

    await t.test('dialog is responsive, theme-aware and Escape restores focus without losing admitted jobs',async()=>{
      await page.getByRole('tab',{name:'发现',exact:true}).click();await page.getByRole('button',{name:'查看 Workspace Skills',exact:true}).click();
      await page.setViewportSize({width:390,height:720});
      const narrow=await page.getByRole('dialog').boundingBox();assert.ok(narrow.x>=0&&narrow.width<=390&&narrow.y>=0&&narrow.height<=720);
      assert.equal(await page.locator('.cx-marketplace-list').isVisible(),false,'detail owns the narrow reading area');
      await page.getByRole('button',{name:'返回插件列表',exact:true}).click();assert.equal(await page.locator('.cx-marketplace-list').isVisible(),true);
      await page.evaluate(()=>{document.documentElement.style.setProperty('--dsw-alias-bg-base','#17191c');document.documentElement.style.setProperty('--dsw-alias-label-primary','#f3f4f5');});
      assert.equal(await page.getByRole('dialog').evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(23, 25, 28)');
      await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.getByRole('dialog').evaluate(node=>getComputedStyle(node).animationName),'none');
      await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
      assert.equal(await page.getByRole('button',{name:'插件市场',exact:true}).evaluate(node=>node===document.activeElement),true);
      const calls=await page.evaluate(()=>window.requests.length);await page.waitForTimeout(2150);assert.equal(await page.evaluate(()=>window.requests.length),calls,'closed dialog does not keep polling');
      await page.setViewportSize({width:1200,height:840});await page.getByRole('button',{name:'插件市场',exact:true}).click();
      await page.getByRole('tab',{name:'已安装',exact:true}).click();await page.getByText('需要配置',{exact:true}).waitFor();
      await mkdir(new URL('../.runtime/',import.meta.url),{recursive:true});await page.screenshot({path:new URL('../.runtime/marketplace-ui-dark.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'),fullPage:true});
      assert.deepEqual(errors,[]);
    });
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
