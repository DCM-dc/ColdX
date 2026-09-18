// Explicit real React/native ModelSelect integration. No ColdX app or model API is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
import path from 'node:path';
import {dshRequire} from '../plugin/page-native.mjs';
import {createModelControlComponents} from '../plugin/client/model-control-source.mjs';
import {createSuperpowersComponents} from '../plugin/client/superpowers-source.mjs';

test('native model menu and directory share the slider admission, keyboard, cancellation and fallback',async()=>{
  const require=createRequire(process.env.COLDX_BROWSER_PACKAGES?path.join(process.env.COLDX_BROWSER_PACKAGES,'package.json'):realpathSync(new URL('../node_modules/@playwright/mcp/package.json',import.meta.url)));
  const {chromium}=require('playwright');
  const assets=new URL('../node_modules/.pnpm/@deepseek-ai+dsh-web-frontend@0.1.1-rc.2/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/',import.meta.url);
  const frontend=await readFile(new URL('index-ClqxG24t.js',assets),'utf8'),boot=frontend.lastIndexOf('const da=document.getElementById("root");');
  assert.ok(boot>0 && frontend.includes('Ce.version="18.3.1"'));
  const runtime=frontend.slice(0,boot)+'\nwindow.nativeModules=Jd();';
  const native=await readFile(process.env.COLDX_MODEL_CLIENT || dshRequire.resolve('@deepseek-ai/dsh-client-ui-model-selection/client'),'utf8');
  assert.match(native,/children: \{ "conversation\.input\.model\.effort": \{ kind: "single", scope: "session" \} \}/);
  const pluginBuild=await readFile(new URL('../plugin/client/build.mjs',import.meta.url),'utf8');
  const names=pluginBuild.match(/\['coldx\.css',[\s\S]*?\]\.map\(path/)[0].match(/'([^']+\.css)'/g).map(name=>name.slice(1,-1));
  const css=(await Promise.all(names.map(name=>readFile(new URL('../plugin/client/'+name,import.meta.url),'utf8')))).join('\n');
  const server=createServer(async(request,response)=>{
    const route=new URL(request.url,'http://localhost').pathname;
    try{
      if(route==='/'){response.setHeader('Content-Type','text/html');response.end('<!doctype html><html class="coldx-shell"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/index-C6eRlFa6.css"><link rel="stylesheet" href="/vendor-CjyC-hUb.css"><style>:root{--dsw-specific-menu:#fff;--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#202126;--dsw-alias-label-secondary:#333;--dsw-alias-label-tertiary:#717582}body{margin:0}#fixture{position:absolute;top:500px;left:260px;width:360px;font-family:Arial,sans-serif}</style></head><body><div id="fixture"></div><script type="module" src="/runtime.js"></script></body></html>');return;}
      response.setHeader('Content-Type',route.endsWith('.css')?'text/css':'text/javascript');
      if(route==='/runtime.js')response.end(runtime);
      else if(/^\/[a-zA-Z0-9_-]+\.(?:js|css)$/.test(route))response.end(await readFile(new URL(route.slice(1),assets)));
      else{response.statusCode=404;response.end();}
    }catch{response.statusCode=404;response.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  try{
    browser=await chromium.launch({headless:true,...process.env.COLDX_TEST_CHROMIUM?{executablePath:process.env.COLDX_TEST_CHROMIUM}:{}});
    const page=await browser.newPage({viewport:{width:900,height:800}});
    page.setDefaultTimeout(5000);
    await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForFunction(()=>window.nativeModules);
    await page.evaluate(({native,factory,superFactory})=>{
      const modules=window.nativeModules,React=modules.react,h=React.createElement;
      const createSnapshotStore=initial=>{let value=initial;const listeners=new Set();return{getSnapshot:()=>value,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},update(fn){const next={...value};fn(next);value=next;for(const listener of listeners)listener();}};};
      const primitives=new Proxy({Toast:props=>h('div',{role:'alert'},props.text)},{get:(target,key)=>target[key]??(()=>h('span',{'aria-hidden':true}))});
      window.__ModuleLoader__={load(record){window.nativeModel=record.factory(id=>({
        '@deepseek-ai/cordis':{Service:class{}},'@deepseek-ai/dsh-client-runtime/client':{createSnapshotStore},
        react:React,'react/jsx-runtime':modules['react/jsx-runtime'],'@deepseek-ai/dsh-client-ui-primitives':primitives,
      })[id]);}};
      new Function(native.replace('exports.ModelDirectory = ModelDirectory;','exports.__test_ModelSelect = ModelSelect; exports.ModelDirectory = ModelDirectory;'))();
      const {ModelControl}=new Function(`return (${factory});`)()(React);
      let superState={enabled:false,autoCheck:true,active:{version:'6.3.0',commit:'a'.repeat(40)},candidate:null,revision:0};window.superRequests=[];
      const {SuperpowersControl}=new Function(`return (${superFactory});`)()(React,async(method,request)=>{window.superRequests.push({method,request});if(method==='setting'){await new Promise(resolve=>{window.releaseSuper=resolve;});superState={...superState,...request,revision:superState.revision+1};}return structuredClone(superState);});
      const levels=[{id:'off',name:'Off'},{id:'low',name:'Low'},{id:'high',name:'High'},{id:'max',name:'Max'}];
      const groups=[{id:'deepseek',name:'DeepSeek',models:[{id:'flash',name:'DeepSeek Flash',reasoning:{efforts:levels,defaultEffort:'high'}},{id:'fast',name:'Fast only',reasoning:{efforts:[levels[0]],defaultEffort:'off'}}]}];
      let current={provider:'deepseek',model:'flash',reasoningEffort:'high'};window.modelRequests=[];
      const directory=new window.nativeModel.ModelDirectory({
        async models(){await window.loadGate;return{result:{ok:true,value:{current,routable:true,groups,failures:[]}}};},
        async selectModel(selection){window.modelRequests.push(selection);await window.selectGate;if(window.failNext){window.failNext=false;return{result:{ok:false,error:{code:'TEST',message:'档位暂不可用'}}};}current={provider:selection.provider,model:selection.model,...selection.reasoningEffort===undefined?{}:{reasoningEffort:selection.reasoningEffort}};return{result:{ok:true,value:{selected:current}}};},
      },'owned-session',()=>true);
      window.pauseSelect=()=>{window.selectGate=new Promise(resolve=>{window.releaseSelect=()=>{window.selectGate=null;resolve();};});};
      // ModelDirectoryResolver responds to settings/document-updated with this
      // exact native load call. Hold transport independently from the save.
      window.pauseRefresh=()=>{window.loadGate=new Promise(resolve=>{window.releaseRefresh=()=>{window.loadGate=null;resolve();};});directory.load();};
      window.readModelDirectory=()=>directory.store.getSnapshot();
      const dict={'trigger.fallback':'选择模型','trigger.selectAria':'选择模型','trigger.aria':'选择模型，当前 {model}','trigger.ariaEffort':'选择模型，当前 {model}，推理等级 {effort}','menu.aria':'模型与推理等级','menu.model':'模型','menu.effort':'推理等级','effort.providerDefault':'默认','empty.efforts':'无推理档位'};
      const t=(key,args={})=>Object.entries(args).reduce((text,[name,value])=>text.replaceAll('{'+name+'}',String(value)),dict[key]??key);
      const props={sessionId:'owned-session',available:true,locked:false,directory:directory.store,load:()=>directory.load().catch(()=>{}),select:selection=>directory.select(selection).then(()=>true,()=>false),t};
      const root=modules['react-dom/client'].createRoot(document.getElementById('fixture'));
      const render=legacy=>root.render(h(window.nativeModel.__test_ModelSelect,{...props,key:legacy?'legacy':'custom',renderSlot:(name,owner,{fallback})=>{if(name!=='conversation.input.model.effort')throw new Error('wrong slot');return h('div',{'data-slot':name,style:{display:'contents'}},legacy?fallback:h(ModelControl,{...owner,superpowersControl:h(SuperpowersControl)}));}}));
      window.showLegacy=()=>render(true);render(false);
    },{native,factory:createModelControlComponents.toString(),superFactory:createSuperpowersComponents.toString()});
    await page.addStyleTag({content:css});
    const trigger=page.locator('._7KE1Ra_trigger');await page.waitForFunction(()=>document.querySelector('._7KE1Ra_triggerLabel')?.textContent==='DeepSeek Flash');
    await trigger.click();const slider=page.getByRole('slider',{name:'推理强度'});
    await slider.waitFor();assert.equal(await page.getByRole('dialog').count(),1);
    const superToggle=page.getByRole('button',{name:'开启 Superpowers',exact:true});
    await superToggle.click();await page.waitForFunction(()=>typeof window.releaseSuper==='function');
    assert.equal(await page.getByRole('dialog').count(),1,'pending workflow save must preserve the real native model menu');
    assert.equal(await superToggle.evaluate(node=>document.activeElement===node),true,'workflow save must preserve focus');
    assert.equal(await superToggle.evaluate(node=>node.disabled),false);assert.equal(await superToggle.getAttribute('aria-disabled'),'true');
    await superToggle.click({force:true});assert.equal(await page.evaluate(()=>window.superRequests.filter(row=>row.method==='setting').length),1,'pending workflow save admits only one request');
    await page.evaluate(()=>window.releaseSuper());await page.getByRole('button',{name:'关闭 Superpowers',exact:true}).waitFor();
    assert.equal(await page.getByRole('dialog').count(),1);assert.equal(await slider.inputValue(),'2');assert.equal(await page.evaluate(()=>window.modelRequests.length),0);
    const thumbRadius=await page.locator('.cx-model-control-thumb').evaluate(node=>parseFloat(getComputedStyle(node).width)/2);
    const compact=await page.getByRole('dialog').evaluate(node=>{
      const rect=node.getBoundingClientRect();
      const hidden=[...node.querySelectorAll('.cx-model-control-stops,.cx-model-control-detail')].every(item=>{
        const css=getComputedStyle(item),bounds=item.getBoundingClientRect();
        return css.display==='none'||css.visibility==='hidden'||bounds.height<=1&&bounds.width<=1;
      });
      const controls=[...node.querySelectorAll('button,input')].filter(item=>item.getBoundingClientRect().height>1).map(item=>{
        const box=item.getBoundingClientRect();return{left:box.left,right:box.right,top:box.top,bottom:box.bottom};
      });
      return{width:rect.width,height:rect.height,left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,hidden,controls};
    });
    assert.ok(compact.width>=280&&compact.width<=340,`compact menu width ${compact.width}px`);
    assert.ok(compact.height>=90&&compact.height<=140,`compact menu height ${compact.height}px`);
    assert.equal(compact.hidden,true,'stop labels and helper copy must not occupy visible rows');
    assert.ok(compact.controls.every(box=>box.left>=compact.left&&box.right<=compact.right&&box.top>=compact.top&&box.bottom<=compact.bottom),'compact controls remain within the card');
    assert.equal(await page.getByRole('dialog').evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(255, 255, 255)');
    assert.equal(await page.getByRole('dialog').evaluate(node=>getComputedStyle(node).backdropFilter),'none');
    await slider.focus();await page.keyboard.press('End');await page.waitForFunction(()=>window.modelRequests.length===1);
    assert.equal(await slider.getAttribute('aria-valuetext'),'Max');assert.equal(await slider.evaluate(node=>document.activeElement===node),true);
    await page.getByRole('button',{name:'恢复模型默认强度'}).click();await page.waitForFunction(()=>window.modelRequests.length===2);
    assert.deepEqual(await page.evaluate(()=>window.modelRequests[1]),{sessionId:'owned-session',provider:'deepseek',model:'flash'});
    const rect=await slider.boundingBox(),point=index=>rect.x+thumbRadius+(rect.width-thumbRadius*2)*index/3;
    await page.mouse.move(point(2),rect.y+rect.height/2);await page.mouse.down();await page.mouse.move(point(1),rect.y+rect.height/2,{steps:4});
    await page.waitForFunction(()=>document.querySelector('input[type=range]')?.getAttribute('aria-valuetext')==='Low');
    assert.equal(await page.evaluate(()=>window.modelRequests.length),2,'dragging must not write settings');
    await page.mouse.up();await page.waitForFunction(()=>window.modelRequests.length===3);
    await page.mouse.move(point(1),rect.y+rect.height/2);await page.mouse.down();await page.mouse.move(point(3),rect.y+rect.height/2,{steps:4});await page.keyboard.press('Escape');await page.mouse.up();
    assert.equal(await page.evaluate(()=>window.modelRequests.length),3);
    assert.equal(await slider.getAttribute('aria-valuetext'),'Low');
    await page.evaluate(()=>{window.failNext=true;});await slider.focus();await page.keyboard.press('End');
    await page.getByRole('alert').filter({hasText:'档位暂不可用'}).waitFor();assert.equal(await slider.getAttribute('aria-valuetext'),'Low');
    await page.getByRole('button',{name:'重试推理强度设置'}).click();await page.waitForFunction(()=>document.querySelector('input[type=range]')?.getAttribute('aria-valuetext')==='Max');
    for(const gesture of ['keyboard','pointer']){
      const before=await page.evaluate(()=>window.modelRequests.length);
      await page.evaluate(()=>window.pauseSelect());await slider.focus();
      if(gesture==='keyboard')await page.keyboard.press('ArrowLeft');
      else{
        const range=await slider.boundingBox();
        await page.mouse.move(range.x+14+(range.width-28)*2/3,range.y+range.height/2);await page.mouse.down();
        await page.mouse.move(range.x+14+(range.width-28)/3,range.y+range.height/2,{steps:4});await page.mouse.up();
      }
      await page.waitForFunction(count=>window.modelRequests.length===count,before+1);
      assert.equal(await slider.evaluate(node=>node.disabled),false,`${gesture}: pending save preserves the focused range`);
      assert.equal(await slider.getAttribute('aria-disabled'),'true');
      assert.equal(await slider.evaluate(node=>document.activeElement===node),true);
      await page.evaluate(()=>window.pauseRefresh());
      await page.waitForFunction(()=>window.readModelDirectory().status==='loading');
      assert.equal(await page.getByRole('dialog').count(),1,`${gesture}: background settings refresh must keep the native menu open`);
      assert.equal(await slider.evaluate(node=>node.disabled),false,`${gesture}: an existing model catalog must not hard-disable during refresh`);
      const heldValue=await slider.inputValue();
      await page.keyboard.press('Home');
      const heldRect=await slider.boundingBox();await page.mouse.click(heldRect.x+14,heldRect.y+heldRect.height/2);
      assert.equal(await slider.inputValue(),heldValue,'busy range prevents native key and pointer defaults');
      assert.equal(await page.evaluate(()=>window.modelRequests.length),before+1,'busy gesture must not issue another selection');
      await page.evaluate(()=>window.releaseSelect());
      await page.waitForFunction(()=>document.querySelector('.cx-model-control')?.getAttribute('aria-busy')==='false');
      assert.equal(await slider.getAttribute('aria-disabled'),'true','directory refresh still blocks edits after save settles');
      assert.equal(await slider.inputValue(),heldValue,'confirmed selection stays visible until the background directory refresh arrives');
      assert.equal(await slider.evaluate(node=>document.activeElement===node),true);
      await page.evaluate(()=>window.releaseRefresh());
      await page.waitForFunction(()=>window.readModelDirectory().status==='ready');
      assert.equal(await page.getByRole('dialog').count(),1,`${gesture}: completed save and refresh preserve menu`);
      assert.equal(await slider.evaluate(node=>document.activeElement===node),true,`${gesture}: completed save and refresh preserve focus`);
      assert.equal(await slider.getAttribute('aria-valuetext'),gesture==='keyboard'?'High':'Low');
    }
    for(const edge of ['right','left']){
      const before=await page.evaluate(()=>window.modelRequests.length);
      const range=await slider.boundingBox(),card=await page.getByRole('dialog').boundingBox();
      const index=Number(await slider.inputValue());
      await page.mouse.move(range.x+14+(range.width-28)*index/3,range.y+range.height/2);await page.mouse.down();
      await page.mouse.move(edge==='right'?card.x+card.width+64:card.x-64,card.y+card.height+64,{steps:8});
      assert.equal(await page.evaluate(()=>window.modelRequests.length),before,`${edge}: dragging outside the card does not submit early`);
      assert.equal(await page.getByRole('dialog').count(),1,`${edge}: dragging outside preserves native menu`);
      assert.equal(await slider.evaluate(node=>document.activeElement===node),true);
      await page.mouse.up();await page.waitForFunction(count=>window.modelRequests.length===count,before+1);
      assert.equal(await page.getByRole('dialog').count(),1,`${edge}: releasing outside preserves native menu`);
      assert.equal(await slider.evaluate(node=>document.activeElement===node),true,`${edge}: releasePointerCapture preserves focus`);
      assert.equal(await slider.getAttribute('aria-valuetext'),edge==='right'?'Max':'Off');
    }
    const continuousRect=await slider.boundingBox(),beforeContinuous=await page.evaluate(()=>window.modelRequests.length);
    const dragX=continuousRect.x+thumbRadius+(continuousRect.width-thumbRadius*2)*.43,dragY=continuousRect.y+continuousRect.height/2;
    await page.mouse.move(continuousRect.x+thumbRadius,dragY);await page.mouse.down();await page.mouse.move(dragX,dragY,{steps:8});
    const follow=await page.locator('.cx-model-control-thumb').boundingBox();
    assert.ok(Math.abs(follow.x+follow.width/2-dragX)<1,'decorative thumb follows the pointer between discrete model stops');
    assert.equal(await page.evaluate(()=>window.modelRequests.length),beforeContinuous);
    assert.equal(await page.locator('.cx-model-control-particles').count(),0,'partial effort has no particles');
    await page.mouse.up();await page.waitForFunction(count=>window.modelRequests.length===count,beforeContinuous+1);
    await page.locator('.cx-model-control-thumb-position').evaluate(node=>Promise.all(node.getAnimations().map(animation=>animation.finished.catch(()=>{}))));
    const snapped=await page.locator('.cx-model-control-thumb').boundingBox();
    assert.ok(Math.abs(snapped.x+snapped.width/2-(continuousRect.x+thumbRadius+(continuousRect.width-thumbRadius*2)/3))<1,'release settles onto the actual Low effort');
    await slider.focus();await page.keyboard.press('End');
    await page.waitForFunction(()=>document.querySelector('input[type=range]')?.getAttribute('aria-valuetext')==='Max');
    const spark=page.locator('.cx-model-control-particles i').first();
    const firstPose=await spark.evaluate(node=>getComputedStyle(node).transform);
    await page.waitForFunction(previous=>getComputedStyle(document.querySelector('.cx-model-control-particles i')).transform!==previous,firstPose);
    await page.locator('.cx-model-control-particles').waitFor({state:'detached'});
    assert.equal(await page.locator('.cx-model-control').evaluate(node=>node.getAnimations({subtree:true}).filter(animation=>animation.effect?.getComputedTiming().iterations===Infinity).length),0,'saved Max remains still after its brief feedback');
    const output=new URL('../outputs/ui-review/',import.meta.url);await mkdir(output,{recursive:true});
    await page.getByRole('dialog').screenshot({path:new URL('model-control-compact.png',output).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
    // Short saves must never paint a transient status or dim the model name.
    // Hold the real native selection transport, observing actual browser frames.
    await page.evaluate(()=>window.pauseSelect());await slider.focus();await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(()=>document.querySelector('.cx-model-control')?.getAttribute('aria-busy')==='true');
    const pendingFrames=await page.evaluate(()=>new Promise(resolve=>{
      const samples=[],start=performance.now();
      const sample=()=>{
        const saving=document.querySelector('.cx-model-control-saving');
        samples.push({saving:saving?Number(getComputedStyle(saving).opacity):0,
          model:Number(getComputedStyle(document.querySelector('.cx-model-control-model')).opacity),
          reset:Number(getComputedStyle(document.querySelector('.cx-model-control-reset')).opacity)});
        if(performance.now()-start<200)requestAnimationFrame(sample);else resolve(samples);
      };requestAnimationFrame(sample);
    }));
    assert.ok(pendingFrames.every(frame=>frame.saving===0),'a short save must not flash saving text in any frame');
    assert.ok(pendingFrames.every(frame=>frame.model===1&&frame.reset===1),'transient save locks must not dim the header');
    await page.evaluate(()=>window.releaseSelect());
    await page.waitForFunction(()=>document.querySelector('.cx-model-control')?.getAttribute('aria-busy')==='false');
    assert.equal(await page.locator('.cx-model-control-saving').count(),0);
    await page.evaluate(()=>window.pauseSelect());await slider.focus();await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(()=>{const saving=document.querySelector('.cx-model-control-saving');return saving&&Number(getComputedStyle(saving).opacity)===1;});
    assert.equal(await slider.getAttribute('aria-disabled'),'true','slow saves still prevent duplicate writes');
    assert.equal(await slider.evaluate(node=>document.activeElement===node),true);
    await page.evaluate(()=>window.releaseSelect());
    await page.waitForFunction(()=>document.querySelector('.cx-model-control')?.getAttribute('aria-busy')==='false');
    await page.keyboard.press('End');
    await page.waitForFunction(()=>document.querySelector('input[type=range]')?.getAttribute('aria-valuetext')==='Max');
    await page.locator('.cx-model-control-particles').waitFor({state:'detached'});
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.waitForFunction(()=>document.querySelector('input[type=range]')?.getAttribute('aria-valuetext')==='Max');
    assert.equal(await page.getByRole('dialog').count(),1);
    const runningMotion=await page.locator('.cx-model-control').evaluate(node=>node.getAnimations({subtree:true}).filter(animation=>{
      const timing=animation.effect?.getComputedTiming();return animation.playState!=='finished'&&timing&&(timing.duration>1||timing.iterations===Infinity);
    }).map(animation=>animation.animationName||animation.constructor.name));
    assert.deepEqual(runningMotion,[],'reduced motion suppresses sustained slider and max particle effects');
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.getByRole('button',{name:'选择模型，当前 DeepSeek Flash',exact:true}).click();
    await page.getByRole('menuitemradio',{name:'Fast only'}).click();await page.waitForFunction(()=>document.querySelector('._7KE1Ra_triggerLabel')?.textContent==='Fast only');
    await trigger.click();assert.equal(await slider.isDisabled(),true);assert.equal(await slider.getAttribute('aria-valuetext'),'Off');
    await page.evaluate(()=>window.showLegacy());await trigger.click();
    assert.equal(await page.getByRole('menuitem',{name:/模型/}).count(),1);assert.equal(await page.getByRole('slider').count(),0);
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
