import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
import path from 'node:path';
import {createWorkbenchPane} from '../plugin/client/workbench-pane-source.mjs';

test('primary workbench tabs fit narrow inspectors and files use a separate keyboard-accessible row',async t=>{
  const packagePath=process.env.COLDX_BROWSER_PACKAGES
    ? path.join(process.env.COLDX_BROWSER_PACKAGES,'package.json')
    : realpathSync(new URL('../node_modules/@playwright/mcp/package.json',import.meta.url));
  const {chromium}=createRequire(packagePath)('playwright');
  const assets=new URL('../node_modules/.pnpm/@deepseek-ai+dsh-web-frontend@0.1.1-rc.2/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/',import.meta.url);
  const frontend=await readFile(new URL('index-ClqxG24t.js',assets),'utf8');
  const boot=frontend.lastIndexOf('const da=document.getElementById("root");');
  assert.ok(boot>0);
  const runtime=frontend.slice(0,boot)+'\nwindow.nativeModules=Jd();';
  const css=(await Promise.all(['ui-consistency.css','workbench-rebuild.css']
    .map(name=>readFile(new URL(`../plugin/client/${name}`,import.meta.url),'utf8')))).join('\n');
  const server=createServer(async(request,response)=>{
    const route=new URL(request.url,'http://localhost').pathname;
    try{
      if(route==='/'){
        response.setHeader('Content-Type','text/html; charset=utf-8');
        response.end('<!doctype html><html class="coldx-shell"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#222;--dsw-alias-label-secondary:#666;--cx-wb-line:#ddd;--cx-wb-text:#222;--cx-wb-muted:#666;--cx-wb-hover:#eee;--cx-wb-accent:#4573b9;font:14px Arial,sans-serif}body{margin:0}</style><main class="wSkVaW_root"><dialog class="cx-workbench-panel" data-mode="docked" data-open="true" open aria-label="工作面板"><div id="tabs"></div></dialog></main><script type="module" src="/runtime.js"></script>');return;
      }
      response.setHeader('Content-Type','text/javascript');
      if(route==='/runtime.js')response.end(runtime);
      else if(/^\/[a-zA-Z0-9_-]+\.js$/.test(route))response.end(await readFile(new URL(route.slice(1),assets)));
      else{response.statusCode=404;response.end();}
    }catch{response.statusCode=404;response.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,
    ...process.env.COLDX_TEST_CHROMIUM?{executablePath:process.env.COLDX_TEST_CHROMIUM}:{},
  });
  try{
    for(const width of [320,375,460])await t.test(`${width}px inspector`,async()=>{
      const page=await browser.newPage({viewport:{width:1402,height:900}});
      try{
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        await page.waitForFunction(()=>window.nativeModules);
        await page.addStyleTag({content:css+`.coldx-shell .cx-workbench-panel{position:static;width:${width}px;height:300px;margin:0;}`});
        await page.evaluate(factory=>{
          const React=window.nativeModules.react,dom=window.nativeModules['react-dom/client'];
          const pane=new Function(`return (${factory});`)()(React);
          pane.openDocument('one','docs/first.md');pane.openDocument('one','docs/second.md');
          window.pane=pane;
          dom.createRoot(document.getElementById('tabs')).render(React.createElement(pane.Tabs,{sessionId:'one'}));
        },createWorkbenchPane.toString());
        const primary=page.getByRole('tablist',{name:'工作面板内容'});
        const files=page.getByRole('tablist',{name:'已打开文件'});
        await primary.waitFor();await files.waitFor();
        assert.equal(await primary.getByRole('tab').count(),5);
        const geometry=await primary.evaluate(rail=>({width:rail.clientWidth,scrollWidth:rail.scrollWidth,
          tabs:[...rail.querySelectorAll('[role="tab"]')].map(tab=>{
            const cell=tab.getBoundingClientRect(),row=rail.getBoundingClientRect();
            return{label:tab.textContent,left:cell.left-row.left,right:cell.right-row.left,width:cell.width};
          })}));
        assert.ok(geometry.scrollWidth<=geometry.width+1,JSON.stringify(geometry));
        assert.ok(geometry.tabs.every(tab=>tab.left>=0&&tab.right<=geometry.width+1&&tab.width>=38),JSON.stringify(geometry));
        const first=files.getByRole('tab',{name:'文件：docs/first.md'});
        const second=files.getByRole('tab',{name:'文件：docs/second.md'});
        await first.click();assert.equal(await first.getAttribute('aria-selected'),'true');
        await first.focus();await page.keyboard.press('ArrowRight');
        assert.equal(await second.getAttribute('aria-selected'),'true');
        await second.focus();await page.keyboard.press('ArrowUp');
        assert.equal(await primary.getByRole('tab',{name:'文件',exact:true}).evaluate(node=>document.activeElement===node),true);
        await primary.getByRole('tab',{name:'浏览器'}).click();
        assert.equal(await files.count(),0,'document row is limited to Files');
        assert.equal(await primary.getByRole('tab',{name:'浏览器'}).getAttribute('aria-selected'),'true');
        assert.deepEqual(await page.evaluate(()=>window.pane.get('one').documents),['docs/first.md','docs/second.md']);
      }finally{await page.close();}
    });
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});
