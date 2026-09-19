const numeric=(value)=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const contextKeys=['systemChars','messageChars','toolChars','totalChars','messageCount','toolCount','imageCount','cacheHits','visitedNodes'];
const usageKeys=['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens'];
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>numeric(value?.[key])).map(key=>[key,value[key]]));
const empty=()=>({requestCount:0,completed:0,failed:0,cancelled:0,toolCount:0,toolFailures:0,toolMs:0,last:null,recent:[]});

/** Small process-local performance ledger, intentionally separate from native logs. */
export class KernelLedger {
  constructor({maxOwners=256,maxRecent=12,now=()=>performance.now()}={}){
    if(!Number.isInteger(maxOwners)||maxOwners<1||!Number.isInteger(maxRecent)||maxRecent<1)throw Error('Invalid kernel ledger bounds.');
    Object.assign(this,{maxOwners,maxRecent,now});this.owners=new Map();
  }
  get ownerCount(){return this.owners.size;}
  owner(id){
    let row=this.owners.get(id);
    if(row){this.owners.delete(id);this.owners.set(id,row);return row;}
    if(this.owners.size>=this.maxOwners){const expired=[...this.owners].find(([,value])=>value.active===0);if(expired)this.owners.delete(expired[0]);else return null;}
    row={...empty(),active:0};this.owners.set(id,row);return row;
  }
  start(owner,context){
    const row=this.owner(owner),started=this.now();let admitted=null,ended=false;
    const record={state:'queued',queueMs:0,firstChunkMs:null,durationMs:0,context:{...pick(context,contextKeys),complete:context?.complete!==false},usage:null};
    if(row){row.requestCount++;row.active++;row.last=record;row.recent.push(record);if(row.recent.length>this.maxRecent)row.recent.shift();}
    return {
      admitted:()=>{if(ended||admitted!==null)return;admitted=this.now();record.queueMs=Math.max(0,admitted-started);record.state='running';},
      chunk:chunk=>{if(ended)return;if(admitted!==null&&record.firstChunkMs===null&&['text-delta','reasoning-delta','tool-call-delta'].includes(chunk?.type))record.firstChunkMs=Math.max(0,this.now()-admitted);
        if(chunk?.type==='usage')record.usage={...record.usage,...pick(chunk.usage,usageKeys)};},
      end:state=>{if(ended)return;ended=true;record.state=['completed','failed','cancelled'].includes(state)?state:'failed';record.durationMs=Math.max(0,this.now()-started);if(admitted===null)record.queueMs=record.durationMs;
        if(row){row.active--;row[record.state]++;}},
    };
  }
  tool(owner,{durationMs,isError}={}){const row=this.owner(owner);if(!row)return;row.toolCount++;if(isError)row.toolFailures++;if(numeric(durationMs))row.toolMs+=durationMs;}
  snapshot(owner){const row=this.owners.get(owner);if(!row)return empty();const {active,...value}=row;return structuredClone(value);}
  forget(owner){if(!this.owners.get(owner)?.active)this.owners.delete(owner);}
  clear(){this.owners.clear();}
}
