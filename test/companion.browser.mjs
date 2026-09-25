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
      await page.addStyleTag({content:css+`body{font:14px system-ui;background:${theme==='dark'?'#191a1c':'#fafafa'};--dsw-alias-bg-base:${theme==='dark'?'#202124':'#fff'};--dsw-alias-label-primary:${theme==='dark'?'#eee':'#242426'};--dsw-alias-label-secondary:${theme==='dark'?'#ccc':'#626268'};--dsw-alias-label-tertiary:${theme==='dark'?'#aaa':'#707077'};color:var(--dsw-alias-label-primary)}#sidebar{width:240px}.controls{display:flex;gap:8px;flex-wrap:wrap}button{font:inherit}.cx-terminal-settings{margin:24px 0;display:flex;gap:16px}.cx-terminal-settings-copy{display:grid}.cx-terminal-switch{width:44px;min-height:32px}`});
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
      {
        await page.setViewportSize({width:1080,height:900});await page.emulateMedia({reducedMotion:'no-preference'});
        await page.addStyleTag({content:'body{margin:0}#fixture{display:none}#team-fixture{height:100vh}.test-group-layout{display:flex;width:100%;height:100%;min-width:0}.test-group-sidebar{width:240px;flex:none;border-right:1px solid color-mix(in srgb,currentColor 12%,transparent);padding:12px 4px;box-sizing:border-box}.test-session-label{margin:8px 12px 20px;font-size:12px;color:var(--dsw-alias-label-secondary)}.test-group-content{flex:1;min-width:0;height:100%}.test-chat-placeholder{padding:32px;color:var(--dsw-alias-label-secondary)}@media(max-width:600px){.test-group-sidebar{width:54px;padding-inline:2px}.test-session-label{display:none}}'});
        await page.evaluate(factory=>{
          const React=window.nativeModules.react,h=React.createElement;
          const fixture=document.createElement('div');fixture.id='team-fixture';document.body.append(fixture);
          let team=null,failSend=true,failOpen=true,failGene=true,failSnapshot=false,omitTasks=false,avatarMood='idle',heldOpen=null,releaseOpen;
          const task={id:'child',parentSessionId:'parent',mode:'continuable',name:'研究伙伴',color:'sky',mood:'working',caption:'正在研究'};
          const pref={status:'ready',writable:true,value:{enabled:true}};
          const settings={getSnapshot:()=>pref,subscribe:()=>()=>{},set:async()=>{}};
          window.teamCalls=[];
          const rpc=async(method,request)=>{
            window.teamCalls.push({method,request});
            if(method==='snapshot'&&failSnapshot)throw Error('offline');
            if(method==='snapshot')return {version:1,tasks:omitTasks?[]:[{id:'parent',name:'当前任务',color:'lilac',mood:avatarMood},...(team?team.members.map(member=>({...task,id:member.id,name:member.name,color:member.color,mood:avatarMood})):[task])],teams:team?[team]:[]};
            if(method==='createTeam'){team={id:'team-1',name:request.name,parentSessionId:'parent',status:'idle',members:request.members.map((member,i)=>({...member,id:i===0?'child':`child-${i}`})),messages:[],genes:[]};return {teamId:team.id};}
            if(method==='send'){if(failSend)throw Error('发送失败，请重试');avatarMood='working';team={...team,status:'running',messages:[{id:'user-1',name:'你',text:request.text},{id:'msg-1',name:'小探',text:'真实回复',taskId:'child'}]};return {teamId:team.id,status:'running'};}
            if(method==='updateGene'){if(failGene)throw Error('经验保存失败');team={...team,genes:team.genes.map(g=>g.id===request.geneId?{...g,status:request.status}:g)};}
            return {teamId:team.id};
          };
          const companion=new Function(`return (${factory})`)()(React,settings,'/companion.png',{rpc,getSessionId:()=> 'parent',openTask:async(id,task,signal)=>{window.teamCalls.push({method:'open',id,task});if(failOpen)throw Error('任务暂时无法打开');if(heldOpen)await heldOpen;signal?.throwIfAborted();window.teamCalls.push({method:'selected',id});}});
          window.teamTest={companion,allowSend:()=>{failSend=false;},allowOpen:()=>{failOpen=false;},allowGene:()=>{failGene=false;},setMood:async mood=>{avatarMood=mood;await companion.refresh();},reviewing:()=>{team={...team,status:'running',round:{phase:'synthesizing',reviewerId:'child-2'}};return companion.refresh();},seedGrowth:()=>{avatarMood='celebrating';team={...team,status:'completed',error:undefined,round:{phase:'settled'},genes:[{id:'gene-1',title:'先验证，再交付',when:'修改交互界面时',practice:'先复现问题，再用实际页面验证修复。记录未通过的边界，避免把构建成功当成可用。',status:'candidate',sourceTaskId:'child',sourceMessageId:'msg-1',roundId:'round-1',createdAt:1,uses:0}]};return companion.refresh();},backgroundError:()=>{avatarMood='problem';team={...team,status:'failed',error:'部分成员未完成；已保留实际回复。'};return companion.refresh();}};
          window.teamTest.connection=async online=>{failSnapshot=!online;await companion.refresh();};
          window.teamTest.omitTasks=async()=>{omitTasks=true;await companion.refresh();};
          window.teamTest.holdOpen=()=>{heldOpen=new Promise(resolve=>{releaseOpen=resolve;});};
          window.teamTest.releaseOpen=()=>{releaseOpen();heldOpen=null;};
          function GroupFixture(){
            const view=React.useSyncExternalStore(companion.subscribeGroup,companion.getGroupView,companion.getGroupView);
            const [wide,setWide]=React.useState(()=>innerWidth>600);
            React.useEffect(()=>{const resize=()=>setWide(innerWidth>600);addEventListener('resize',resize);return()=>removeEventListener('resize',resize);},[]);
            return h(React.Fragment,null,h(companion.Controller),h('div',{className:'test-group-layout'},h('aside',{className:'test-group-sidebar'},h('p',{className:'test-session-label'},'会话'),h(companion.GroupSidebar,{wide}),h(companion.Companion,{wide})),h('div',{className:'test-group-content'},view?h(companion.GroupPage):h('p',{className:'test-chat-placeholder'},'普通聊天'))));
          }
          window.nativeModules['react-dom/client'].createRoot(fixture).render(h(GroupFixture));
        },createCompanionComponents.toString());
        const fixture=page.locator('#team-fixture'),sidebar=fixture.getByRole('region',{name:'群组',exact:true});
        await sidebar.getByRole('button',{name:'新建群组'}).click();
        const creating=fixture.getByRole('main',{name:'新建群组'});await creating.waitFor();
        assert.equal(await page.getByRole('dialog').count(),0,'group navigation renders in the main chat, never a dialog');
        assert.equal(await creating.locator('.cx-group-member-form').count(),3);
        assert.equal(await page.getByRole('switch',{name:'在桌面显示伙伴'}).count(),0);
        await fixture.screenshot({path:new URL(`group-create-${theme}.png`,output).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
        await creating.getByRole('button',{name:'创建群组'}).click();
        const group=fixture.getByRole('main',{name:'群组聊天'});await group.waitFor();
        await group.getByRole('status').filter({hasText:'等待开始'}).waitFor();
        assert.equal(await group.getByRole('log',{name:'群组对话'}).locator('article').count(),0,'no fabricated reply after creation');
        const row=sidebar.getByRole('button',{name:'打开群组 我的小绒群组'});await row.waitFor();
        assert.equal(await row.getAttribute('aria-current'),'page');
        const draft=group.getByRole('textbox',{name:'发给群组'});
        await draft.fill('请研究');
        await page.evaluate(()=>window.teamTest.connection(false));
        await group.getByText('伙伴暂时无法连接，请稍后重试。',{exact:true}).waitFor();
        await page.evaluate(()=>window.teamTest.connection(true));await draft.waitFor();
        assert.equal(await draft.inputValue(),'请研究','polling failure must not erase an unsent draft');
        await group.getByRole('button',{name:'发送',exact:true}).click();
        await group.getByText('发送失败，请重试',{exact:true}).waitFor();assert.equal(await draft.inputValue(),'请研究');
        await page.evaluate(()=>window.teamTest.allowSend());await group.getByRole('button',{name:'发送',exact:true}).click();
        await group.getByText('真实回复',{exact:true}).waitFor();assert.equal(await draft.inputValue(),'');
        await page.evaluate(()=>window.teamTest.reviewing());
        await group.getByRole('status').filter({hasText:'正在汇总'}).waitFor();
        assert.equal(await group.getByRole('button',{name:'打开 小验 的任务',exact:true}).count(),1);
        await page.evaluate(()=>window.teamTest.backgroundError());
        await group.getByText('部分成员未完成；已保留实际回复。',{exact:true}).waitFor();
        await group.getByRole('button',{name:'打开任务',exact:true}).click();await group.getByText('任务暂时无法打开',{exact:true}).waitFor();
        await page.evaluate(()=>window.teamTest.allowOpen());await group.getByRole('button',{name:'打开任务',exact:true}).click();
        await group.waitFor({state:'hidden'});await fixture.getByText('普通聊天',{exact:true}).waitFor();
        await row.click();await group.waitFor();
        const selectedBefore=await page.evaluate(()=>window.teamCalls.filter(call=>call.method==='selected').length);
        await page.evaluate(()=>window.teamTest.holdOpen());await group.getByRole('button',{name:'打开任务',exact:true}).click();
        await group.getByRole('button',{name:'返回普通聊天'}).click();await group.waitFor({state:'hidden'});
        await page.evaluate(async()=>{window.teamTest.releaseOpen();await new Promise(resolve=>setTimeout(resolve,0));});
        assert.equal(await page.evaluate(()=>window.teamCalls.filter(call=>call.method==='selected').length),selectedBefore,'leaving a group cancels an unfinished source navigation');
        await row.click();await group.waitFor();await page.evaluate(()=>window.teamTest.seedGrowth());
        const details=group.locator('.cx-group-info');await details.locator('summary').click();
        await details.getByText('待验证',{exact:true}).waitFor();
        await details.getByRole('button',{name:'试用这条经验'}).click();await group.getByText('经验保存失败',{exact:true}).waitFor();
        assert.equal(await details.locator('.cx-group-gene').getAttribute('data-active'),'false');
        await page.evaluate(()=>window.teamTest.allowGene());await details.getByRole('button',{name:'试用这条经验'}).click();
        await details.getByText('试用中',{exact:true}).waitFor();
        await details.getByRole('button',{name:'停用',exact:true}).click();await details.getByText('已停用',{exact:true}).waitFor();
        // Ignore the intentional brief blink while measuring stable eye geometry.
        await page.emulateMedia({reducedMotion:'reduce'});
        const eyeMetrics=()=>fixture.locator('.test-group-sidebar .cx-companion .cx-companion-eye,.cx-group-header-avatars .cx-companion-eye').evaluateAll(eyes=>eyes.map(eye=>({width:eye.offsetWidth,height:eye.offsetHeight,pupilWidth:eye.firstElementChild.offsetWidth,pupilHeight:eye.firstElementChild.offsetHeight})));
        await page.evaluate(()=>window.teamTest.setMood('idle'));const fixedEyes=await eyeMetrics();assert.equal(fixedEyes.length,8);
        for(const mood of ['thinking','working','reading','speaking','listening','waiting','celebrating','problem','stopped','sleeping']){
          await page.evaluate(mood=>window.teamTest.setMood(mood),mood);
          await fixture.locator(`.test-group-sidebar .cx-companion[data-mood="${mood}"]`).waitFor();
          assert.deepEqual(await eyeMetrics(),fixedEyes,`eye and pupil sizes stay fixed in ${mood} mood`);
        }
        await page.evaluate(()=>window.teamTest.setMood('celebrating'));
        await draft.fill('草稿在群组切换后保留');await group.getByRole('button',{name:'返回普通聊天'}).click();
        await group.waitFor({state:'hidden'});await row.click();await draft.waitFor();
        assert.equal(await draft.inputValue(),'草稿在群组切换后保留','closing and reopening a group preserves its own draft');
        await group.locator('.cx-group-info summary').click();
        await fixture.screenshot({path:new URL(`group-chat-${theme}.png`,output).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
        await page.setViewportSize({width:360,height:760});
        await fixture.locator('.cx-group-sidebar[data-wide=false]').waitFor();
        assert.equal(await group.locator('.cx-group-avatar .cx-companion-eye').first().evaluate(e=>getComputedStyle(e).animationName),'none');
        assert.equal(await group.locator('.cx-group-avatar .cx-companion-body').first().evaluate(e=>e.getAnimations().length),0);
        assert.ok(await group.evaluate(e=>e.scrollWidth<=e.clientWidth+1),'narrow group page has no horizontal overflow');
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'narrow sidebar and chat fit the viewport');
        await fixture.screenshot({path:new URL(`group-mobile-${theme}.png`,output).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
        await page.evaluate(()=>window.teamTest.omitTasks());
        await group.getByRole('button',{name:'查看来源'}).click();await group.waitFor({state:'hidden'});
        const calls=await page.evaluate(()=>window.teamCalls);
        assert.equal(calls.find(call=>call.method==='createTeam').request.parentSessionId,'parent');
        assert.equal(calls.find(call=>call.method==='open').task.mode,'continuable');
        assert.equal(calls.find(call=>call.method==='createTeam').request.members.length,3);
        assert.deepEqual(calls.findLast(call=>call.method==='open').task,{id:'child',parentSessionId:'parent',mode:'continuable'},'retained source can navigate when bounded live snapshot omits the child');
        await page.evaluate(()=>window.teamTest.companion.dispose());
      }
      assert.deepEqual(errors,[]);await page.close();
    }
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});
