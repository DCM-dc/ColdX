import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {ReleaseUpdates,selectRelease} from '../plugin/release-updates.mjs';
const bytes=Buffer.from('fixture-installer-not-executable');
const digest='sha256:'+createHash('sha256').update(bytes).digest('hex');
const release=(extra={})=>({tag_name:'v0.1.3',html_url:'https://github.com/DCM-dc/ColdX/releases/tag/v0.1.3',assets:[{name:'ColdX-0.1.3-win-x64.exe',size:bytes.length,digest,state:'uploaded',browser_download_url:'https://github.com/DCM-dc/ColdX/releases/download/v0.1.3/ColdX-0.1.3-win-x64.exe'}],...extra});
test('updates reject pre-releases, old versions and foreign asset URLs without selecting an installer',()=>{
  assert.equal(selectRelease(release({prerelease:true}),'0.1.2','win32','x64'),null);
  assert.equal(selectRelease(release(),'0.1.3','win32','x64'),null);
  assert.equal(selectRelease(release(),'0.1.2','linux','x64').asset,null);
  const bad=release();bad.assets[0].browser_download_url='https://evil.example/setup.exe';
  assert.equal(selectRelease(bad,'0.1.2','win32','x64').asset,null);
  assert.equal(selectRelease(release(),'0.1.2','win32','x64').asset.digest,digest);
});
test('download verifies a pinned asset but never launches until an explicit matching confirmation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'coldx-update-'));let starts=0;
  const updater=new ReleaseUpdates({directory:dir,currentVersion:'0.1.2',platform:'win32',arch:'x64',fetch:async url=>new Response(url.includes('/latest')?JSON.stringify(release()):bytes),launch:async()=>starts++});
  try{
    await updater.check();assert.equal(updater.state().status,'available');
    assert.equal(starts,0);await updater.download('0.1.3');assert.equal(starts,0);
    assert.equal(updater.state().status,'ready');assert.deepEqual(await readFile(join(dir,'ColdX-0.1.3-win-x64.exe')),bytes);
    await assert.rejects(()=>updater.install({version:'0.1.2',confirmed:true}),/版本/);
    await assert.rejects(()=>updater.install({version:'0.1.3',confirmed:false}),/确认/);
    await updater.install({version:'0.1.3',confirmed:true});assert.equal(starts,1);
    await assert.rejects(()=>updater.install({version:'0.1.3',confirmed:true}),/启动/);
  }finally{updater.dispose();await rm(dir,{recursive:true,force:true});}
});
test('checksum mismatch, redirect outside GitHub and post-download changes cannot be loaded',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'coldx-update-'));let phase='bad';let starts=0;
  const updater=new ReleaseUpdates({directory:dir,currentVersion:'0.1.2',platform:'win32',arch:'x64',fetch:async url=>url.includes('/latest')?new Response(JSON.stringify(release())):phase==='redirect'?new Response(null,{status:302,headers:{location:'https://evil.example/x'}}):new Response(Buffer.from('bad')),launch:async()=>starts++});
  try{await updater.check();await assert.rejects(()=>updater.download('0.1.3'),/校验|长度/);phase='redirect';await assert.rejects(()=>updater.download('0.1.3'),/下载地址/);await assert.rejects(()=>updater.install({version:'0.1.3',confirmed:true}),/下载/);assert.equal(starts,0);}
  finally{updater.dispose();await rm(dir,{recursive:true,force:true});}
});
test('concurrent installation confirms launch once and a replaced downloaded file is rejected',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'coldx-update-'));let starts=0;
  const updater=new ReleaseUpdates({directory:dir,currentVersion:'0.1.2',platform:'win32',arch:'x64',fetch:async url=>new Response(url.includes('/latest')?JSON.stringify(release()):bytes),launch:async()=>starts++});
  try{await updater.check();await updater.download('0.1.3');
    await writeFile(join(dir,'ColdX-0.1.3-win-x64.exe'),Buffer.alloc(bytes.length));
    await assert.rejects(()=>updater.install({version:'0.1.3',confirmed:true}),/校验/);
    assert.equal(updater.state().status,'available');
    await updater.download('0.1.3');
    const results=await Promise.allSettled([updater.install({version:'0.1.3',confirmed:true}),updater.install({version:'0.1.3',confirmed:true})]);
    assert.equal(starts,1);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  }finally{updater.dispose();await rm(dir,{recursive:true,force:true});}
});
test('a delayed update check cannot replace the release being downloaded',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'coldx-update-'));let checks=0,complete;
  const updater=new ReleaseUpdates({directory:dir,currentVersion:'0.1.2',platform:'win32',arch:'x64',fetch:async url=>url.includes('/latest')?++checks===1?new Response(JSON.stringify(release())):await new Promise(resolve=>{complete=resolve;}):new Response(bytes)});
  try{await updater.check();const checking=updater.check();await updater.download('0.1.3');complete(new Response(JSON.stringify(release({tag_name:'v0.1.1'}))));await checking;
    assert.equal(updater.state().release.version,'0.1.3');assert.equal(updater.state().status,'ready');
  }finally{updater.dispose();await rm(dir,{recursive:true,force:true});}
});
