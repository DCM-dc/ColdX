// Explicit real-report regression, isolated browser, no running app or user UI.
// COLDX_PDF_REPORT can supply the public 51-page DeepSeek report outside uploads.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {createPdfViewComponents} from '../plugin/client/pdf-view-source.mjs';
import {createFileViewComponents} from '../plugin/client/file-view-source.mjs';
import {createWorkbenchPane} from '../plugin/client/workbench-pane-source.mjs';

// Optional comparison against a previously built client, without rebuilding it.
// Useful for demonstrating RED with the exact shipped renderer before a fix.
const comparisonBundle=process.env.COLDX_PDF_FACTORY_BUNDLE && await readFile(process.env.COLDX_PDF_FACTORY_BUNDLE,'utf8');
const pdfFactory=comparisonBundle ? comparisonBundle.match(/pdf:\((function createPdfViewComponents[\s\S]+?)\),\s*workbenchPane:/)?.[1] : createPdfViewComponents.toString();
assert.ok(pdfFactory,'the comparison bundle must contain its actual PDF component factory');
const classicOnly=process.env.COLDX_PDF_CLASSIC_SCAN==='1';
const cases=[false,true].flatMap(integrated=>classicOnly?[{integrated,classicScan:true}]:[{integrated,classicScan:false},{integrated,classicScan:true}]);

for(const {integrated,classicScan} of cases)test(`real 51-page report ${classicScan?'remains stable with classic scrollbars at DPR 1.25':'commits complete frames through resize, page, zoom and hiding'} (${integrated?'file pane':'standalone'})`,async t=>{
  const {chromium}=createRequire(realpathSync(new URL('../node_modules/@playwright/mcp/package.json',import.meta.url)))('playwright');
  const pdf=await readFile(process.env.COLDX_PDF_REPORT || new URL('../.coldx/uploads/DeepSeek_V41_Tech_Report.pdf',import.meta.url));
  const assets=new URL('../node_modules/.pnpm/@deepseek-ai+dsh-web-frontend@0.1.1-rc.2/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/',import.meta.url);
  const frontend=await readFile(new URL('index-ClqxG24t.js',assets),'utf8'),boot=frontend.lastIndexOf('const da=document.getElementById("root");');
  assert.ok(boot>0);const runtime=frontend.slice(0,boot)+'\nwindow.nativeModules=Jd();';
  const pdfRuntime=await readFile(new URL('../plugin/client/pdf-runtime.js',import.meta.url));
  const build=await readFile(new URL('../plugin/client/build.mjs',import.meta.url),'utf8');
  const names=integrated?build.match(/\['coldx\.css',[\s\S]*?\]\.map\(path/)[0].match(/'([^']+\.css)'/g).map(name=>name.slice(1,-1)):['pdf-view.css'];
  const css=(await Promise.all(names.map(name=>readFile(new URL('../plugin/client/'+name,import.meta.url),'utf8')))).join('\n');
  const server=createServer(async(request,response)=>{
    const route=new URL(request.url,'http://localhost').pathname;
    try{
      if(route==='/'){response.setHeader('Content-Type','text/html; charset=utf-8');response.end('<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{font:14px/1.5 Arial,sans-serif;background:#151515;color:white}body{margin:0}#fixture{box-sizing:border-box;width:440px;height:690px;margin-left:auto;padding:16px;--cx-sys-surface:#1f1f1f;--cx-sys-surface-elevated:#262626;--cx-sys-text:#eee;--cx-sys-text-muted:#aaa;--cx-sys-separator:#444}*{box-sizing:border-box}</style><div id="fixture"></div><script type="module" src="/runtime.js"></script>');return;}
      response.setHeader('Content-Type','text/javascript');
      if(route==='/runtime.js')response.end(runtime);
      else if(route==='/coldx/assets/pdf-runtime.js')response.end(pdfRuntime);
      else if(/^\/[a-zA-Z0-9_-]+\.js$/.test(route))response.end(await readFile(new URL(route.slice(1),assets)));
      else{response.statusCode=404;response.end();}
    }catch{response.statusCode=404;response.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  try{
    browser=await chromium.launch({headless:true,args:classicScan?['--disable-features=OverlayScrollbar']:[],ignoreDefaultArgs:classicScan?['--hide-scrollbars']:[]});const page=await browser.newPage({viewport:{width:classicScan?1402:1280,height:classicScan?986:800},deviceScaleFactor:classicScan?1.25:1}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForFunction(()=>window.nativeModules);await page.addStyleTag({content:css});
    if(integrated)await page.addStyleTag({content:'#fixture{--dsw-alias-bg-base:#1f1f1f;--dsw-alias-label-primary:#eee;--dsw-alias-label-secondary:#aaa;--dsw-alias-border-l2:#444;--dsw-alias-interactive-bg-hover:#303030}'});
    if(classicScan)await page.addStyleTag({content:'.cx-pdf-scroll{scrollbar-width:auto!important}.cx-pdf-scroll::-webkit-scrollbar{width:17px;height:17px}'});
    await page.evaluate(({factory,base64,filesFactory,paneFactory,integrated})=>{
      const modules=window.nativeModules,React=modules.react,h=React.createElement;
      window.pdfMetrics={resizes:[],renders:[],errors:[]};
      // Delay only actual operator-list delivery from the real PDF worker.
      // Metadata and text remain real; this reproduces a busy/hidden browser's
      // interval after resizing the opaque canvas and before graphics arrive.
      const NativeWorker=window.Worker,pendingGraphics=[];let holdGraphics=true;
      window.Worker=class extends NativeWorker{
        operatorStreams=new Set();listeners=new Map();
        postMessage(message,...args){if(message.action==='GetOperatorList')this.operatorStreams.add(message.streamId);return super.postMessage(message,...args);}
        addEventListener(type,listener,options){
          if(type!=='message'||typeof listener!=='function')return super.addEventListener(type,listener,options);
          const wrapped=event=>{if(holdGraphics&&(event.data?.action==='StartRenderPage'||this.operatorStreams.has(event.data?.streamId)))pendingGraphics.push(()=>listener.call(this,event));else listener.call(this,event);};
          this.listeners.set(listener,wrapped);return super.addEventListener(type,wrapped,options);
        }
        removeEventListener(type,listener,options){return super.removeEventListener(type,this.listeners.get(listener)??listener,options);}
      };
      window.resumePdfFrames=()=>{holdGraphics=false;for(const deliver of pendingGraphics.splice(0))deliver();};
      window.pdfPendingFrames=pendingGraphics;
      // Cached pages need no new worker operator list when zooming. Pause the
      // real PDF.js continuation too; no page, text, or raster is substituted.
      let holdRender=false,runtimePromise;const pendingRenders=[];
      window.holdPdfRender=()=>{holdRender=true;};
      window.resumePdfRender=()=>{holdRender=false;for(const resume of pendingRenders.splice(0))resume();};
      window.pdfPendingRenders=pendingRenders;
      const loadRuntime=()=>runtimePromise??=(async()=>{
        await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/coldx/assets/pdf-runtime.js';script.onload=resolve;script.onerror=reject;document.head.append(script);});
        const runtime=window.__ColdXPdfRuntime;
        return{...runtime,open(data){
          const job=runtime.open(data);
          return{...job,promise:job.promise.then(pdf=>{
            const getPage=pdf.getPage.bind(pdf),wrapped=new WeakSet();
            pdf.getPage=async(...args)=>{
              const pdfPage=await getPage(...args);
              if(!wrapped.has(pdfPage)){
                wrapped.add(pdfPage);const render=pdfPage.render.bind(pdfPage);
                pdfPage.render=(...renderArgs)=>{
                  const task=render(...renderArgs);window.pdfMetrics.renders.push({page:pdfPage.pageNumber});
                  task.onContinue=resume=>{if(holdRender)pendingRenders.push(resume);else resume();};
                  return task;
                };
              }
              return pdfPage;
            };
            return pdf;
          })};
        }};
      })();
      const hash=value=>{let result=2166136261;for(let i=0;i<value.length;i++)result=Math.imul(result^(typeof value==='string'?value.charCodeAt(i):value[i]),16777619)>>>0;return result;};
      const visible=element=>{
        if(!element)return false;
        for(let node=element;node instanceof Element;node=node.parentElement){const style=getComputedStyle(node);if(node.hidden||style.display==='none'||style.visibility==='hidden'||style.opacity==='0')return false;}
        const rect=element.getBoundingClientRect();return rect.width>0&&rect.height>0;
      };
      window.pdfFrame=()=>{
        const surface=document.querySelector('.cx-pdf-page'),canvas=surface?.querySelector(':scope > canvas'),text=surface?.querySelector('.cx-pdf-text-layer');
        const data=canvas?.width&&canvas?.height?canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data:new Uint8Array();
        return{width:canvas?.width??0,height:canvas?.height??0,pixels:hash(data),text:hash(text?.textContent??''),markup:hash(text?.innerHTML??''),textLength:text?.textContent.length??0,
          visible:visible(canvas),surfaceVisible:visible(surface),size:[surface?.style.width??'',surface?.style.height??''],canvasSize:[canvas?.style.width??'',canvas?.style.height??'']};
      };
      window.pdfFrameSamples=[];let sampleFrame;
      window.startPdfFrameSamples=()=>{
        window.pdfFrameSamples=[];const sample=()=>{window.pdfFrameSamples.push(window.pdfFrame());sampleFrame=requestAnimationFrame(sample);};sample();
      };
      window.stopPdfFrameSamples=()=>{cancelAnimationFrame(sampleFrame);return window.pdfFrameSamples;};
      const Observer=window.ResizeObserver;window.ResizeObserver=class extends Observer{constructor(callback){super(entries=>{window.pdfMetrics.resizes.push(entries.map(entry=>[entry.contentRect.width,entry.contentRect.height]));callback(entries);});}};
      const {PdfPreview}=new Function(`return (${factory});`)()(React,loadRuntime);
      const root=document.getElementById('fixture');
      window.pdfRoot=modules['react-dom/client'].createRoot(root);
      if(integrated){
        document.documentElement.className='coldx-shell';root.dataset.slot='root';root.style.width='1000px';root.style.padding='0';
        const pane=new Function(`return (${paneFactory});`)()(React);
        const files=new Function(`return (${filesFactory});`)()(React,()=>null,async(_session,_method,path)=>({path,name:'DeepSeek_V41_Tech_Report.pdf',kind:'pdf',mime:'application/pdf',base64}),undefined,{pane,PdfPreview});
        window.pdfRoot.render(h('main',{className:'wSkVaW_root',style:{height:'100%',width:'100%'}},h('header',{className:'wSkVaW_header',style:{height:64}},h(files.FileWorkspace,{sessionId:'fixture'})),h('div',{className:'wSkVaW_scrollBody'},'对话内容')));
        files.open('fixture','.coldx/uploads/DeepSeek_V41_Tech_Report.pdf');
      }else window.pdfRoot.render(h(PdfPreview,{base64,name:'DeepSeek_V41_Tech_Report.pdf'}));
    },{factory:pdfFactory,filesFactory:createFileViewComponents.toString(),paneFactory:createWorkbenchPane.toString(),integrated,base64:pdf.toString('base64')});
    await page.waitForFunction(()=>window.pdfPendingFrames.length>0);
    const initial=await page.evaluate(()=>({frame:window.pdfFrame(),busy:document.querySelector('.cx-pdf-page')?.getAttribute('aria-busy'),placeholder:document.querySelector('.cx-pdf-placeholder')?.textContent??''}));
    const pendingOutput=new URL(`../outputs/ui-review/pdf-report-pending-${integrated?'pane':'standalone'}.png`,import.meta.url);await mkdir(new URL('.',pendingOutput),{recursive:true});await page.screenshot({path:fileURLToPath(pendingOutput)});
    await t.test('first frame remains hidden behind a neutral loading placeholder',async()=>{
      assert.equal(initial.busy,'true');
      assert.equal(initial.frame.surfaceVisible,false,'an unfinished first page must not display blank paper');
      assert.equal(initial.frame.visible,false,'no unfinished raster may be visible');
      assert.match(initial.placeholder,/正在准备页面/);
      assert.ok(await page.locator('.cx-pdf-placeholder').isVisible(),'the initial loading placeholder is actually visible');
    });
    await page.evaluate(()=>window.resumePdfFrames());
    const settle=async()=>{
      try{await page.waitForFunction(()=>document.querySelector('.cx-pdf-page')?.getAttribute('aria-busy')==='false'&&document.querySelector('.cx-pdf-text-layer')?.textContent.length>0,{},{timeout:15000});}
      catch(reason){console.log('PDF_DIAGNOSTIC',await page.evaluate(()=>({metrics:window.pdfMetrics,status:document.querySelector('.cx-pdf-status')?.textContent,error:document.querySelector('.cx-pdf-error')?.textContent,canvas:[document.querySelector('canvas')?.width,document.querySelector('canvas')?.height],text:document.querySelector('.cx-pdf-text-layer')?.textContent.length})),errors);throw reason;}
      assert.equal(await page.locator('.cx-pdf-error').count(),0);
      return page.locator('.cx-pdf-page > canvas').evaluate(canvas=>{const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let white=0,dark=0;for(let i=0;i<data.length;i+=4){if(data[i]>220&&data[i+1]>220&&data[i+2]>220)white++;if(data[i]<100&&data[i+1]<100&&data[i+2]<100)dark++;}return{width:canvas.width,height:canvas.height,white:white/(data.length/4),dark:dark/(data.length/4)};});
    };
    const first=await settle();assert.ok(first.white>.5&&first.dark>.001,JSON.stringify(first));
    assert.match(await page.locator('.cx-pdf-toolbar').innerText(),/51/);
    const firstOutput=new URL(`../outputs/ui-review/pdf-report-page1-${integrated?'pane':'standalone'}.png`,import.meta.url);await mkdir(new URL('.',firstOutput),{recursive:true});await page.screenshot({path:fileURLToPath(firstOutput)});
    if(classicScan){
      await page.evaluate(async integrated=>{
        const root=document.getElementById('fixture');root.style.height=integrated?'730px':'350px';
        if(integrated)document.querySelector('.cx-workbench-panel').style.setProperty('--cx-inspector-width','440.2px');else root.style.width='440.2px';
        let signature='',stable=0;
        for(let i=0;i<600&&stable<6;i++){
          await new Promise(requestAnimationFrame);const surface=document.querySelector('.cx-pdf-page'),scroll=document.querySelector('.cx-pdf-scroll');
          const next=[scroll.clientWidth,scroll.clientHeight,surface.querySelector('canvas')?.width,surface.getAttribute('aria-busy')].join(':');
          stable=next===signature&&surface.getAttribute('aria-busy')==='false'?stable+1:0;signature=next;
        }
      },integrated);await settle();
      const diagnosis=await page.evaluate(async()=>{
        const root=document.getElementById('fixture'),scroll=document.querySelector('.cx-pdf-scroll'),surface=document.querySelector('.cx-pdf-page'),toolbar=document.querySelector('.cx-pdf-toolbar');
        const trace=[],start=performance.now();let commits=0;
        const measure=kind=>{const css=getComputedStyle(scroll);trace.push({kind,t:Math.round(performance.now()-start),rootHeight:root.clientHeight,boxWidth:scroll.getBoundingClientRect().width,clientWidth:scroll.clientWidth,clientHeight:scroll.clientHeight,scrollHeight:scroll.scrollHeight,scrollWidth:scroll.scrollWidth,gutter:scroll.offsetWidth-scroll.clientWidth-parseFloat(css.borderLeftWidth)-parseFloat(css.borderRightWidth),canvasWidth:surface.querySelector('canvas')?.width,canvasHeight:surface.querySelector('canvas')?.height,toolbarHeight:toolbar.getBoundingClientRect().height,busy:surface.getAttribute('aria-busy'),commits});};
        const observer=new ResizeObserver(()=>measure('resize'));observer.observe(scroll);
        const mutations=new MutationObserver(records=>{if(records.some(record=>record.type==='childList')){commits++;measure('commit');}});mutations.observe(surface,{childList:true});
        measure('before');
        // A height between the with-scrollbar and without-scrollbar fit page
        // sizes has no stable overflow:auto fixed point without a reserved gutter.
        root.style.height=`${root.clientHeight-scroll.clientHeight+surface.getBoundingClientRect().height+32+7}px`;
        await new Promise(resolve=>setTimeout(resolve,10000));measure('after');observer.disconnect();mutations.disconnect();
        return{trace,commits,widths:[...new Set(trace.map(item=>item.clientWidth))],canvasWidths:[...new Set(trace.map(item=>item.canvasWidth))],gutters:[...new Set(trace.map(item=>item.gutter))]};
      });
      console.log('PDF_CLASSIC_DIAGNOSTIC',JSON.stringify({integrated,...diagnosis,trace:diagnosis.trace.length>11?[...diagnosis.trace.slice(0,7),...diagnosis.trace.slice(-4)]:diagnosis.trace}));
      assert.ok(diagnosis.gutters.some(width=>width>=15),'the test must actually reserve classic scrollbar width');
      assert.ok(diagnosis.trace[0].scrollHeight>diagnosis.trace[0].clientHeight,'the initial page must overflow so the scrollbar boundary is real');
      assert.ok(diagnosis.commits<=3,`a static PDF must settle, saw ${diagnosis.commits} frame commits in 10 seconds`);
      assert.equal(diagnosis.trace.at(-1).busy,'false','a static report must leave the rendering state');
      assert.equal(diagnosis.trace.filter(item=>item.kind==='commit'&&item.t>8000).length,0,'the final two idle seconds must have no frame replacements');
      await page.evaluate(()=>window.pdfRoot.unmount());return;
    }
    const threshold=await page.evaluate(async()=>{
      const root=document.getElementById('fixture'),scroll=document.querySelector('.cx-pdf-scroll'),surface=document.querySelector('.cx-pdf-page');
      const before=window.pdfMetrics.resizes.length;
      root.style.height=`${root.clientHeight-scroll.clientHeight+surface.getBoundingClientRect().height+32-7}px`;
      for(let i=0;i<45;i++)await new Promise(requestAnimationFrame);
      return{resizes:window.pdfMetrics.resizes.slice(before),busy:surface.getAttribute('aria-busy'),status:document.querySelector('.cx-pdf-status').textContent};
    });
    assert.ok(threshold.resizes.length<12,'one scrollbar threshold resize must settle rather than repeatedly cancel rendering');
    await settle();
    const transitions=[];
    const transition=async(name,change)=>{
      const before=await page.evaluate(()=>{window.holdPdfRender();window.startPdfFrameSamples();return window.pdfFrame();});
      let held,after,samples;
      try{
        await change();
        await page.waitForFunction(()=>window.pdfPendingRenders.length>0&&document.querySelector('.cx-pdf-page')?.getAttribute('aria-busy')==='true');
        held=await page.evaluate(async()=>{for(let i=0;i<6;i++)await new Promise(requestAnimationFrame);return window.pdfFrame();});
        if(name==='page change')await page.screenshot({path:fileURLToPath(new URL(`../outputs/ui-review/pdf-report-held-${integrated?'pane':'standalone'}.png`,import.meta.url))});
      }finally{await page.evaluate(()=>window.resumePdfRender());}
      await settle();
      ({after,samples}=await page.evaluate(async()=>{for(let i=0;i<3;i++)await new Promise(requestAnimationFrame);return{after:window.pdfFrame(),samples:window.stopPdfFrameSamples()};}));
      transitions.push({name,before,held,after,samples:samples.length});
      await t.test(`${name} retains the completed pixels and text until one complete replacement`,()=>{
        assert.ok(before.visible&&before.textLength>0,'transition starts with a completed real report page');
        assert.deepEqual(held,before,'the displayed raster, text content and text positions must remain unchanged while the next real render is paused');
        assert.notEqual(after.pixels,before.pixels,'the completed operation must publish its new raster');
        assert.ok(after.visible&&after.textLength>0,'the replacement includes the real selectable text layer');
        const allowed=new Set([JSON.stringify(before),JSON.stringify(after)]);
        assert.ok(samples.every(sample=>allowed.has(JSON.stringify(sample))),'every observed paint frame must be either the old complete frame or the new complete frame');
        const sequence=samples.map(sample=>JSON.stringify(sample));let commits=0;
        for(let i=1;i<sequence.length;i++)if(sequence[i]!==sequence[i-1])commits++;
        assert.equal(commits,1,'the visible page and text must switch together exactly once');
      });
    };
    await transition('page change',()=>page.getByRole('button',{name:'PDF 下一页'}).click());
    await transition('zoom change',()=>page.getByRole('combobox',{name:'PDF 缩放'}).selectOption('2'));
    await transition('fit zoom',()=>page.getByRole('combobox',{name:'PDF 缩放'}).selectOption('fit'));
    await transition('container resize',()=>page.evaluate(()=>document.getElementById('fixture').style.width='360px'));
    await page.evaluate(()=>document.getElementById('fixture').hidden=true);await page.evaluate(()=>document.getElementById('fixture').hidden=false);await settle();
    await page.getByRole('spinbutton',{name:'PDF 页码'}).fill('51');await settle();
    const output=new URL(`../outputs/ui-review/pdf-report-preview-${integrated?'pane':'standalone'}.png`,import.meta.url);await mkdir(new URL('.',output),{recursive:true});await page.screenshot({path:fileURLToPath(output)});
    const textGeometry=await page.locator('.cx-pdf-text-layer').evaluate(layer=>{
      const page=layer.parentElement.getBoundingClientRect();
      return[...layer.querySelectorAll('span')].filter(span=>span.textContent.trim()).map(span=>{const rect=span.getBoundingClientRect();return{width:rect.width,height:rect.height,x:rect.left-page.left,y:rect.top-page.top,pageWidth:page.width,pageHeight:page.height};});
    });
    assert.ok(textGeometry.length>0,'the actual final report page has a populated text layer');
    assert.ok(textGeometry.every(rect=>Object.values(rect).every(Number.isFinite)&&rect.width>0&&rect.height>0),'off-DOM text layers must resolve their font/scale after the atomic commit');
    assert.ok(textGeometry.filter(rect=>rect.x>=-1&&rect.y>=-1&&rect.x<rect.pageWidth&&rect.y<rect.pageHeight).length/textGeometry.length>.9,'real text selection positions remain within the report page after resizing');
    console.log('PDF_RENDER',JSON.stringify({comparison:!!comparisonBundle,initial,first,transitions:transitions.map(({name,before,held,after,samples})=>({name,pixels:[before.pixels,held.pixels,after.pixels],text:[before.text,held.text,after.text],samples})),thresholdResizes:threshold.resizes.length,resizeEvents:await page.evaluate(()=>window.pdfMetrics.resizes.length),errors}));
    assert.deepEqual(errors,[]);await page.evaluate(()=>window.pdfRoot.unmount());
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
