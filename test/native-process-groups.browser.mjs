// Explicit browser regression: node --test test/native-process-groups.browser.mjs
// COLDX_BROWSER_PACKAGES may point to an existing Playwright package root;
// COLDX_TEST_CHROMIUM may select a local Chromium executable. No app is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import path from 'node:path';
import {dshRequire} from '../plugin/page-native.mjs';

test('shipped React 18 process disclosure survives parent rerenders, native keyboard activation and nested tools', async () => {
  const require = createRequire(process.env.COLDX_BROWSER_PACKAGES ? path.join(process.env.COLDX_BROWSER_PACKAGES,'package.json') : import.meta.url);
  const {chromium} = require('playwright');
  const assets = new URL('../node_modules/.pnpm/@deepseek-ai+dsh-web-frontend@0.1.1-rc.2/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/', import.meta.url);
  const frontend = await readFile(new URL('index-ClqxG24t.js',assets),'utf8');
  const boot = frontend.lastIndexOf('const da=document.getElementById("root");');
  assert.ok(boot > 0 && frontend.includes('Ce.version="18.3.1"'), 'update the fixture when the pinned frontend changes');
  // Keep the actual shipped React/ReactDOM modules, and remove app boot only.
  const runtime = frontend.slice(0,boot) + '\nwindow.nativeModules=Jd();';
  const installed = await readFile(dshRequire.resolve('@deepseek-ai/dsh-client-ui-conversation/client'),'utf8');
  const start = installed.indexOf('function ColdXProcessGroup('), end = installed.indexOf('\n\t\t}',start) + '\n\t\t}'.length;
  assert.ok(start >= 0 && end > start, 'the installed conversation client must include process groups');
  const component = installed.slice(start,end);
  const seatStart=installed.indexOf('function ChatNodeSeat('), seatEnd=installed.indexOf('\n\t\t});',seatStart)+'\n\t\t}'.length;
  const predicateStart=installed.indexOf('const coldxHiddenModeReceipt = ')+'const coldxHiddenModeReceipt = '.length;
  const predicateEnd=installed.indexOf('\n\t\tconst COLDX_PROCESS_TOOLS',predicateStart);
  assert.ok(seatStart>=0 && seatEnd>seatStart && predicateStart>30 && predicateEnd>predicateStart);
  const seat=installed.slice(seatStart,seatEnd), predicate=installed.slice(predicateStart,predicateEnd).trim().replace(/;$/,'');
  const server = createServer(async (request,response) => {
    const route = new URL(request.url,'http://localhost').pathname;
    try {
      if (route === '/') {response.setHeader('Content-Type','text/html');response.end('<!doctype html><div id="fixture"></div><script type="module" src="/runtime.js"></script>');return;}
      response.setHeader('Content-Type','text/javascript');
      if (route === '/runtime.js') response.end(runtime);
      else if (/^\/[a-zA-Z0-9_-]+\.js$/.test(route)) response.end(await readFile(new URL(route.slice(1),assets)));
      else {response.statusCode=404;response.end();}
    } catch {response.statusCode=404;response.end();}
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser = await chromium.launch({headless:true,...process.env.COLDX_TEST_CHROMIUM ? {executablePath:process.env.COLDX_TEST_CHROMIUM} : {}});
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.nativeModules);
    await page.evaluate(component => {
      const modules=window.nativeModules, React=modules.react, ReactDOM=modules['react-dom'], h=React.createElement;
      const Group=new Function('react','react_jsx_runtime',`return (${component});`)(React,modules['react/jsx-runtime']);
      window.mounts=0; window.explored=0; window.prevented=false;
      function NativeChild() {
        React.useEffect(() => {window.mounts++;},[]);
        return h('details',{id:'native-tool'},h('summary',null,'Native tool'),h('input',{defaultValue:'draft','aria-label':'Tool draft'}));
      }
      function Parent() {
        const [follow,setFollow]=React.useState(true), [revision,setRevision]=React.useState(0);
        window.rerender=() => ReactDOM.flushSync(() => setRevision(value => value+1));
        return h('section',{'data-follow':String(follow),'data-revision':revision},h(Group,{
          group:{key:'one',nodeKeys:['call-one','call-two'],callIds:['call-one','call-two'],stepCount:4,callCount:5},
          chatScroll:{read:() => null},
          onExplore() {window.explored++;ReactDOM.flushSync(() => setFollow(false));},
        },h(NativeChild,{key:'native-child'})));
      }
      document.addEventListener('click',event => {if(event.target.closest('details.coldx-process-group > summary')) window.prevented=event.defaultPrevented;});
      modules['react-dom/client'].createRoot(document.getElementById('fixture')).render(h(Parent));
    },component);
    const summary=page.locator('details.coldx-process-group > summary');
    await summary.click();
    await page.waitForFunction(() => document.querySelector('details.coldx-process-group')?.open);
    assert.equal(await page.evaluate(() => window.prevented),true,'native default must not compete with the controlled open state');
    assert.equal(await page.locator('section').getAttribute('data-follow'),'false');
    await summary.click();
    await page.waitForFunction(() => !document.querySelector('details.coldx-process-group').open);
    await summary.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('details.coldx-process-group').open);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => !document.querySelector('details.coldx-process-group').open);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('details.coldx-process-group').open);
    await page.locator('#native-tool > summary').click();
    await page.getByRole('textbox',{name:'Tool draft'}).fill('unsaved child state');
    await page.evaluate(() => window.rerender());
    await page.waitForTimeout(100); // let queued native toggle events settle
    assert.equal(await page.locator('details.coldx-process-group').evaluate(node => node.open),true);
    assert.equal(await page.getByRole('textbox',{name:'Tool draft'}).inputValue(),'unsaved child state');
    assert.equal(await page.evaluate(() => window.mounts),1);
    assert.equal(await page.evaluate(() => window.explored),5);
    await page.evaluate(({seat,predicate}) => {
      const modules=window.nativeModules, React=modules.react, h=React.createElement;
      const Receipt=new Function('react','react_jsx_runtime','coldxHiddenModeReceipt','ChatView_module_css_default','_deepseek_ai_dsh_client_ui_primitives',`return (${seat});`)(React,modules['react/jsx-runtime'],new Function(`return (${predicate});`)(),{flowItem:'native-flow-item'},{JsonBlock:()=>null});
      const command=(key,name,args,outcome) => ({key,kind:'command',data:{kind:'command',name,args,outcome}});
      const success={kind:'success',text:'done'};
      window.receiptNodes=new Map([
        ['first',{key:'first',kind:'user',data:{}}],
        ['pending',command('pending','plan','',undefined)],
        ['legacy',command('legacy','coldx-goal',null,{kind:'success',text:'Goal mode selected for the next direct human request.'})],
        ['off',command('off','plan','off',success)],
        ['failed',command('failed','coldx-goal','on',{kind:'error',text:'rejected'})],
        ['plan-message',command('plan-message','plan','Build a page',success)],
        ['last',{key:'last',kind:'assistant',data:{}}],
      ]);
      const fixture=document.body.appendChild(document.createElement('div'));fixture.id='receipt-fixture';
      const root=modules['react-dom/client'].createRoot(fixture);
      window.renderReceipts=()=> modules['react-dom'].flushSync(()=>root.render(h('div',{id:'native-flow',style:{display:'flex',flexDirection:'column',gap:20}},[...window.receiptNodes.keys()].map(nodeKey=>h(Receipt,{key:nodeKey,nodeKey,useSession:select=>select({chat:{nodes:window.receiptNodes}}),renderSlot:(_name,owner)=>h('div',{style:{height:20}},owner.node.key),t:()=>''})))));
      window.renderReceipts();
    },{seat,predicate});
    assert.equal(await page.locator('#native-flow > .native-flow-item').count(),5,'successful switches must omit the full native layout seat');
    assert.equal(await page.locator('#native-flow').evaluate(node=>node.getBoundingClientRect().height),180);
    await page.evaluate(()=>{const node=window.receiptNodes.get('pending');window.receiptNodes.set('pending',{...node,data:{...node.data,outcome:{kind:'success',text:'Plan mode on'}}});window.renderReceipts();});
    assert.equal(await page.locator('#native-flow > .native-flow-item').count(),4);
    assert.equal(await page.locator('#native-flow').evaluate(node=>node.getBoundingClientRect().height),140,'settlement must remove the former row and its flex gap');
    assert.equal(await page.evaluate(()=>window.receiptNodes.size),7,'native raw command history remains intact');
    assert.equal(await page.locator('[data-chat-flow-key="failed"]').count(),1,'mode errors remain visible');
    assert.equal(await page.locator('[data-chat-flow-key="plan-message"]').count(),1,'Plan commands with actual user content remain visible');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
