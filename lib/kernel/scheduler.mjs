/** Bounded request admission shared by ColdX root and child sessions. */
export class RequestScheduler {
  constructor({ limit=4, maxQueued=64, interactiveBurst=3 }={}) {
    if(!Number.isInteger(limit)||limit<1||limit>64)throw new TypeError('Invalid kernel request limit.');
    if(!Number.isInteger(maxQueued)||maxQueued<1||maxQueued>1024)throw new TypeError('Invalid kernel queue bound.');
    if(!Number.isInteger(interactiveBurst)||interactiveBurst<1||interactiveBurst>32)throw new TypeError('Invalid interactive burst.');
    Object.assign(this,{limit,maxQueued,interactiveBurst});
    this.active=0;this.interactive=[];this.normal=[];this.burst=0;this.closed=false;
  }
  snapshot(){return {active:this.active,queued:this.interactive.length+this.normal.length,limit:this.limit};}
  acquire({owner,priority='normal',signal}={}) {
    if(typeof owner!=='string'||!owner||owner.length>256)return Promise.reject(new TypeError('Invalid kernel request owner.'));
    if(!['normal','interactive'].includes(priority))return Promise.reject(new TypeError('Invalid kernel request priority.'));
    if(this.closed)return Promise.reject(new Error('ColdX request scheduler is closed.'));
    if(signal?.aborted)return Promise.reject(signal.reason);
    if(this.active>=this.limit&&this.snapshot().queued>=this.maxQueued)return Promise.reject(new Error('ColdX request queue is full; retry after current work finishes.'));
    return new Promise((resolve,reject)=>{
      const queue=this[priority],entry={resolve,reject,signal,abort:null};
      entry.abort=()=>{const index=queue.indexOf(entry);if(index<0)return;queue.splice(index,1);signal.removeEventListener('abort',entry.abort);reject(signal.reason);};
      queue.push(entry);signal?.addEventListener('abort',entry.abort,{once:true});
      if(signal?.aborted)entry.abort();
      this.drain();
    });
  }
  drain(){
    while(!this.closed&&this.active<this.limit&&(this.interactive.length||this.normal.length)){
      const interactive=this.interactive.length&&(!this.normal.length||this.burst<this.interactiveBurst);
      const entry=(interactive?this.interactive:this.normal).shift();
      entry.signal?.removeEventListener('abort',entry.abort);
      if(entry.signal?.aborted){entry.reject(entry.signal.reason);continue;}
      this.burst=interactive?this.burst+1:0;this.active++;
      let released=false;
      entry.resolve(()=>{if(released)return;released=true;this.active--;this.drain();});
    }
    if(!this.interactive.length&&!this.normal.length)this.burst=0;
  }
  dispose(){
    if(this.closed)return;this.closed=true;
    for(const entry of [...this.interactive.splice(0),...this.normal.splice(0)]){
      entry.signal?.removeEventListener('abort',entry.abort);entry.reject(new Error('ColdX request scheduler is closed.'));
    }
  }
}
