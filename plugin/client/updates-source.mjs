// Serialized into DSH's native React runtime. No Electron or file access here.
export function createUpdateComponents(React,rpc){
  const h=React.createElement,listeners=new Set();let snapshot=null,pending=null;
  const publish=value=>{snapshot=value;for(const fn of listeners)fn();return value;};
  const call=async(method,request={})=>publish(await rpc(method,request));
  function useUpdates(){
    const state=React.useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn);},()=>snapshot,()=>null);
    React.useEffect(()=>{let disposed=false;const read=()=>{pending??=call('state').catch(()=>{}).finally(()=>{pending=null;});};read();const timer=setInterval(()=>{if(!disposed&&document.visibilityState!=='hidden')read();},snapshot?.status==='downloading'?1000:30_000);return()=>{disposed=true;clearInterval(timer);};},[state?.status]);
    return state;
  }
  function UpdateSettingsRow(){
    const state=useUpdates(),[busy,setBusy]=React.useState(false),[error,setError]=React.useState(''),[confirm,setConfirm]=React.useState(false);
    const act=async(method,request={})=>{if(busy)return;setBusy(true);setError('');try{await call(method,request);}catch(e){setError(e.message||'更新暂时不可用。');}finally{setBusy(false);}};
    const release=state?.release;
    const status=state?.status==='ready'?`${release.version} 已下载并校验，等待安装`:state?.status==='downloading'?`正在下载 ${Math.round(state.downloaded/Math.max(1,release?.asset?.size??1)*100)}%`:state?.status==='available'?`发现新版本 ${release.version}`:state?.status==='launched'?'安装程序已打开':state?.status==='current'?`当前版本 ${state.currentVersion}`:state?.error??'从 GitHub 获取 ColdX 更新';
    return h('section',{className:'cx-update-settings'},h('div',{className:'cx-update-heading'},h('div',null,h('strong',null,'ColdX 更新'),h('p',{role:'status'},status)),h('button',{type:'button',disabled:busy||state?.status==='downloading',onClick:()=>act('check')},busy?'检查中…':'检查更新')),
      h('label',null,h('input',{type:'checkbox',checked:state?.settings?.autoCheck??true,disabled:busy||!state,onChange:e=>act('setting',{autoCheck:e.target.checked})}),'自动检查 GitHub 更新'),
      state?.desktop&&h('label',null,h('input',{type:'checkbox',checked:state?.settings?.autoDownload??false,disabled:busy||!state,onChange:e=>act('setting',{autoDownload:e.target.checked})}),'自动下载更新，安装前由我确认'),
      release&&h('div',{className:'cx-update-actions'},h('a',{href:release.url,target:'_blank',rel:'noopener noreferrer'},'查看版本说明'),release.asset&&state.status==='available'&&h('button',{type:'button',disabled:busy,onClick:()=>act('download',{version:release.version})},'下载安装包'),state.status==='ready'&&state.canInstall&&h('button',{type:'button',disabled:busy,onClick:()=>setConfirm(true)},'安装更新')),
      confirm&&h('div',{className:'cx-update-confirm',role:'group','aria-label':'确认安装 ColdX 更新'},h('p',null,`安装 ColdX ${release?.version}？请先结束正在运行的任务，安装程序将引导你完成更新。`),h('button',{type:'button',disabled:busy,onClick:async()=>{await act('install',{version:release?.version,confirmed:true});setConfirm(false);}},'确认安装'),h('button',{type:'button',disabled:busy,onClick:()=>setConfirm(false)},'稍后')),
      (error||state?.error)&&h('p',{role:'alert'},error||state.error));
  }
  function UpdateNotice(){const state=useUpdates();if(!state?.release||!['available','ready','downloading'].includes(state.status))return null;
    return h('a',{className:'cx-update-notice',href:state.release.url,target:'_blank',rel:'noopener noreferrer'},state.status==='ready'?`ColdX ${state.release.version} 已就绪 · 设置中安装`:`ColdX ${state.release.version} 可用`);
  }
  return{UpdateSettingsRow,UpdateNotice};
}
