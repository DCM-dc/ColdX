// Public MCP Transport adapter. Extends navigation without evaluating page code.
export function createBrowserTransport(transport, getContext) {
  let selected, callback,previousPages=[];
  const pending=new Map();
  const pages=()=>getContext()?.pages().filter(page=>!page.isClosed()) ?? [];
  const active=()=>{const all=pages();if(!all.includes(selected))selected=all[Math.max(0,Math.min(previousPages.indexOf(selected),all.length-1))];previousPages=all;return selected;};
  async function state(){const all=pages();const current=active();return {tabs:await Promise.all(all.map(async(page,index)=>({index,id:String(index),url:page.url(),title:(await page.title().catch(()=>'' )).slice(0,200),active:page===current}))),activeTabId:current?String(all.indexOf(current)):null,url:current?.url()??'',title:current?await current.title().catch(()=>''):''};}
  const schemas=['browser_forward','browser_reload','browser_state','browser_type_focused'].map(name=>({name,description:name==='browser_state'?'Read the actual ColdX browser tabs and selected page.':name==='browser_reload'?'Reload the selected ColdX page.':name==='browser_type_focused'?'Insert literal text into the focused browser input after a screenshot-verified click.':'Navigate forward in the selected ColdX page.',inputSchema:{type:'object',properties:name==='browser_type_focused'?{text:{type:'string',maxLength:20000}}:{},...name==='browser_type_focused'?{required:['text']}:{},additionalProperties:false}}));
  const adapter={
    async start(){await transport.start();},
    async close(){await transport.close();},
    set onmessage(value){callback=value;transport.onmessage=async(message,extra)=>{
      if(message.method==='tools/call' && schemas.some(row=>row.name===message.params?.name)) {
        try {const page=active();if(message.params.name!=='browser_state'){if(!page)throw new Error('Open a page first.');if(message.params.name==='browser_type_focused'){const text=message.params.arguments?.text;if(typeof text!=='string'||text.length>20000)throw new Error('Invalid text.');await page.keyboard.insertText(text);}else await (message.params.name==='browser_reload'?page.reload():page.goForward());}
          await transport.send({jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:'COLDX_BROWSER_STATE:'+JSON.stringify(await state())}]}});
        }catch(error){await transport.send({jsonrpc:'2.0',id:message.id,result:{isError:true,content:[{type:'text',text:error.message}]}});}return;
      }
      if(message.method==='tools/call'||message.method==='tools/list')pending.set(message.id,{method:message.method,params:message.params,before:pages(),selected:active()});
      callback?.(message,extra);
    };},
    get onmessage(){return callback;},
    set onclose(value){transport.onclose=value;},get onclose(){return transport.onclose;},
    set onerror(value){transport.onerror=value;},get onerror(){return transport.onerror;},
    async send(message,options){
      const request=pending.get(message.id);pending.delete(message.id);
      if(request?.method==='tools/list' && message.result?.tools)message={...message,result:{...message.result,tools:[...message.result.tools,...schemas]}};
      if(request?.method==='tools/call' && message.result) {
        const args=request.params?.arguments??{};
        if(request.params?.name==='browser_close'&&!message.result.isError)await getContext()?.close().catch(()=>{});
        if(request.params?.name==='browser_tabs' && args.action==='select'&&!message.result.isError)selected=pages()[args.index];
        else if(request.params?.name==='browser_tabs' && args.action==='new'){const created=pages().filter(page=>!request.before.includes(page));if(created.length)selected=created.at(-1);}
        else if(!request.before.length)selected=pages()[0];
        message={...message,result:{...message.result,content:[...(message.result.content??[]),{type:'text',text:'COLDX_BROWSER_STATE:'+JSON.stringify(await state())}]}};
      }
      return transport.send(message,options);
    }
  };return adapter;
}
