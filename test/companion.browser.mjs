import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {createCompanionComponents} from '../plugin/client/companion-source.mjs';

test('companion supports petting, preference failures, keyboard, themes, narrow rail and reduced motion',async()=>{
  const require=createRequire(realpathSync(new URL('../node_modules/@playwright/mcp/package.json',import.meta.url)));
  const {chromium}=require('playwright');
  const assets=new URL('../node_modules/.pnpm/@deepseek-ai+dsh-web-frontend@0.1.1-rc.2/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/',import.meta.url);
  const frontend=await readFile(new URL('index-ClqxG24t.js',assets),'utf8');
  const boot=frontend.lastIndexOf('const da=document.getElementById("root");');assert.ok(boot>0);
  const runtime=frontend.slice(0,boot)+'\nwindow.nativeModules=Jd();';
  const css=await readFile(new URL('../plugin/client/companion.css',import.meta.url),'utf8');
  const image=await readFile(new URL('../plugin/client/assets/companion.png',import.meta.url));
  const server=createServer(async(req,res)=>{
    try{
      if(req.url==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="fixture"></div><script type="module" src="/runtime.js"></script></body></html>');}
      else if(req.url==='/runtime.js'){res.setHeader('content-type','text/javascript');res.end(runtime);}
      else if(req.url==='/companion.png'){res.setHeader('content-type','image/png');res.end(image);}
      else if(/^\/[\w-]+\.js$/.test(req.url)){res.setHeader('content-type','text/javascript');res.end(await readFile(new URL(req.url.slice(1),assets)));}
      else{res.statusCode=404;res.end();}
    }catch{res.statusCode=404;res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,...process.env.COLDX_TEST_CHROMIUM?{executablePath:process.env.COLDX_TEST_CHROMIUM}:{}});
  const output=new URL('../outputs/ui-review/',import.meta.url);await mkdir(output,{recursive:true});
  try{
    for(const theme of ['light','dark']){
      const page=await browser.newPage({viewport:{width:640,height:480},colorScheme:theme});
      const errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForFunction(()=>window.nativeModules);
      await page.addStyleTag({content:css+`body{font:14px system-ui;background:${theme==='dark'?'#191a1c':'#fafafa'};--dsw-alias-label-primary:${theme==='dark'?'#eee':'#242426'};--dsw-alias-label-secondary:${theme==='dark'?'#ccc':'#626268'};--dsw-alias-label-tertiary:${theme==='dark'?'#aaa':'#707077'};color:var(--dsw-alias-label-primary)}#sidebar{width:240px}.controls{display:flex;gap:8px;flex-wrap:wrap}button{font:inherit}.cx-terminal-settings{margin:24px 0;display:flex;gap:16px}.cx-terminal-settings-copy{display:grid}.cx-terminal-switch{width:44px;min-height:32px}`});
      await page.evaluate(factory=>{
        const React=window.nativeModules.react,h=React.createElement,listeners=new Set();
        let pref={status:'ready',writable:true,value:{enabled:true}},fail=false;
        const settings={getSnapshot:()=>pref,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},async set(_key,enabled){if(fail)throw new Error('offline');pref={...pref,value:{enabled}};for(const fn of listeners)fn();}};
        const pet=new Function(`return (${factory})`)()(React,settings,'/companion.png');
        function App(){const[wide,setWide]=React.useState(true);return h(React.Fragment,null,h('div',{id:'sidebar',style:{width:wide?240:48}},h(pet.Companion,{wide})),h(pet.CompanionSettingsRow),h('div',{className:'controls'},['idle','busy','waiting','problem'].map(mood=>h('button',{key:mood,onClick:()=>pet.observe({sessionId:'test',running:mood==='busy',pending:mood==='waiting'?1:0,lastKind:mood==='problem'?'turn-error':undefined})},mood)),h('button',{onClick:()=>setWide(!wide)},'rail'),h('button',{onClick:()=>{fail=!fail;}},'save failure')));}
        window.nativeModules['react-dom/client'].createRoot(document.getElementById('fixture')).render(h(App));
      },createCompanionComponents.toString());
      const pet=page.getByRole('button',{name:'摸摸小绒',exact:true});await pet.waitFor();
      await pet.click();assert.match(await page.locator('.cx-companion-caption').innerText(),/一团好心情/);
      await page.getByRole('button',{name:'busy',exact:true}).click();assert.equal(await page.locator('.cx-companion').getAttribute('data-mood'),'busy');
      await page.getByRole('button',{name:'problem',exact:true}).click();await pet.click();assert.match(await page.locator('.cx-companion-caption').innerText(),/卡住/);
      await page.getByRole('button',{name:'idle',exact:true}).click();
      await page.mouse.move(500,20);await page.waitForTimeout(180);
      assert.notEqual(await page.locator('.cx-companion-pupil').first().evaluate(e=>getComputedStyle(e).transform),'none');
      await page.evaluate(()=>{
        document.dispatchEvent(new PointerEvent('pointermove',{clientX:620,clientY:440}));
        window.dispatchEvent(new Event('blur'));
      });
      await page.waitForTimeout(200);
      assert.equal(await page.locator('.cx-companion-pupil').first().evaluate(e=>e.style.transform),'','blur cancels the queued gaze frame');
      await page.emulateMedia({reducedMotion:'reduce'});await pet.click();
      assert.equal(await page.locator('.cx-companion-eye').first().evaluate(e=>getComputedStyle(e).animationName),'none');
      assert.equal(await page.locator('.cx-companion-body').evaluate(e=>e.getAnimations().length),0);
      await pet.press('Enter');assert.equal(await pet.isVisible(),true);
      await page.getByRole('button',{name:'save failure'}).click();await page.getByRole('switch',{name:'显示毛球伙伴'}).click();assert.match(await page.getByRole('alert').innerText(),/保存失败/);assert.equal(await pet.isVisible(),true);
      await page.getByRole('button',{name:'save failure'}).click();await page.getByRole('switch',{name:'显示毛球伙伴'}).click();assert.equal(await pet.count(),0);
      await page.getByRole('switch',{name:'显示毛球伙伴'}).click();await pet.waitFor();
      await page.screenshot({path:new URL(`companion-${theme}.png`,output).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
      await page.getByRole('button',{name:'rail',exact:true}).click();const box=await pet.boundingBox();assert.ok(box.width<=48);assert.equal(await page.locator('.cx-companion-copy').count(),0);
      assert.deepEqual(errors,[]);await page.close();
    }
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});
