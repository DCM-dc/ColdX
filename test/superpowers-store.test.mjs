import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,cp,symlink,rmdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {SuperpowersStore} from '../plugin/superpowers-store.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const blob=value=>createHash('sha1').update(`blob ${Buffer.byteLength(value)}\0`).update(value).digest('hex');
const old='a'.repeat(40),next='b'.repeat(40);
const license='MIT License\nCopyright (c) 2025 Jesse Vincent\nPermission is hereby granted';
const body='---\nname: test-driven-development\ndescription: Use when implementing a feature\n---\nWrite a failing test first.';
async function fixture(t,{treeExtra=[],corrupt=false,alias=false}={}) {
  const root=await mkdtemp(join(tmpdir(),'coldx-skills-test-')),bundledDir=join(root,'bundled');
  const texts={'LICENSE':license,'skills/test-driven-development/SKILL.md':body};
  for(const [path,text] of Object.entries(texts)){await mkdir(join(bundledDir,path,'..'),{recursive:true});await writeFile(join(bundledDir,path),text);}
  await writeFile(join(bundledDir,'manifest.json'),JSON.stringify({version:1,upstream:'obra/superpowers',release:'6.3.0',commit:old,files:Object.entries(texts).map(([path,text])=>({path,sha256:sha(text),bytes:Buffer.byteLength(text)}))}));
  let calls=0;
  const fetchImpl=async url=>{calls++;const path=new URL(url).pathname;let data;
    if(path.endsWith('/commits/main'))data={sha:next};
    else if(path.endsWith('/git/ref/heads/main'))data={object:{type:'commit',sha:next}};
    else if(path.endsWith('/package.json'))data={version:'6.4.0'};
    else if(path.includes('/git/trees/'))data={truncated:false,tree:[...Object.entries(texts).map(([path,text])=>({path,type:'blob',mode:'100644',size:Buffer.byteLength(text),sha:blob(text)})),...treeExtra]};
    else {const relative=path.split('/').slice(4).join('/');if(!Object.hasOwn(texts,relative))throw Error('Unexpected URL '+url);return new Response(corrupt?'bad bytes':texts[relative]);}
    return new Response(JSON.stringify(data));
  };
  if(alias){await mkdir(join(root,'state-real'));await symlink(join(root,'state-real'),join(root,'state'),'junction');}
  const store=new SuperpowersStore({root:join(root,'state'),bundledDir,fetchImpl});await store.ready;t.after(()=>store.dispose());
  return{store,root,bundledDir,get calls(){return calls;}};
}
test('update lookup reads a small branch ref instead of downloading a commit diff',async t=>{
  const f=await fixture(t),fetch=f.store.fetch;
  f.store.fetch=async(url,options)=>{
    assert.equal(url.includes('/commits/'),false,'large commit patches are not needed to resolve the branch');
    return fetch(url,options);
  };
  await f.store.check();
  assert.equal(f.store.state().candidate.commit,next);
  assert.equal(f.store.state().active.commit,old);
});

test('candidate download preserves active skills until exact confirmation and survives restart',async t=>{
  const f=await fixture(t);assert.equal(f.store.state().active.commit,old);assert.equal(f.store.state().enabled,false);
  await f.store.check();assert.equal(f.store.state().candidate.commit,next);assert.equal(f.store.state().active.commit,old);
  await f.store.stage({candidateId:next});assert.equal(f.store.state().candidate.status,'ready');assert.equal(f.store.state().active.commit,old);
  await assert.rejects(f.store.activate({candidateId:next,expectedActiveCommit:next}),/changed|变化/);
  await f.store.activate({candidateId:next,expectedActiveCommit:old});assert.equal(f.store.state().active.commit,next);
  const snapshot=await f.store.snapshot(next);assert.equal(snapshot.skills[0].name,'test-driven-development');assert.equal(snapshot.skills[0].content,'Write a failing test first.');
  await f.store.setting({enabled:true,autoCheck:false});
  const restored=new SuperpowersStore({root:join(f.root,'state'),bundledDir:f.bundledDir});t.after(()=>restored.dispose());await restored.ready;
  assert.equal(restored.state().active.commit,next);assert.equal(restored.state().enabled,true);assert.equal(restored.state().autoCheck,false);
});
test('malicious tree paths and corrupted content never become active',async t=>{
  for(const options of [{treeExtra:[{path:'skills/../../outside.md',type:'blob',mode:'100644',size:5,sha:'c'.repeat(40)}]},{corrupt:true}]) {
    const f=await fixture(t,options);await f.store.check();await assert.rejects(f.store.stage({candidateId:next}));
    assert.equal(f.store.state().active.commit,old);assert.equal(f.store.state().candidate.status,'failed');
    assert.deepEqual(await readdir(join(f.root,'state','staging')).catch(error=>{if(error.code==='ENOENT')return[];throw error;}),[],'failed candidate bytes do not accumulate; '+(f.store.state().notice??''));
    await assert.rejects(f.store.activate({candidateId:next,expectedActiveCommit:old}));
  }
});

test('failed downloads clean up through a canonicalized profile junction',async t=>{
  const f=await fixture(t,{corrupt:true,alias:true});await f.store.check();
  await assert.rejects(f.store.stage({candidateId:next}),/integrity/);
  assert.deepEqual(await readdir(join(f.root,'state','staging')),[],f.store.state().notice??'Aliased profile cleanup must finish before stage settles.');
  assert.equal(f.store.state().active.commit,old);
});

test('Windows cleanup waits out a transient exclusive file lock', {skip:process.platform!=='win32',timeout:15_000},async t=>{
  const f=await fixture(t,{corrupt:true}),fetch=f.store.fetch;let child,locked=false;
  t.after(()=>{if(child?.exitCode===null)child.kill();});
  f.store.fetch=async(url,options)=>{
    if(url.endsWith('/LICENSE')&&!locked){
      locked=true;const [directory]=await readdir(join(f.root,'state','staging')),file=join(f.root,'state','staging',directory,'scanner-held.txt');await writeFile(file,'Temporary scanner lock');
      child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$stream = [System.IO.File]::Open($env:COLDX_TEST_LOCK_PATH, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None); try { [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); Start-Sleep -Milliseconds 450 } finally { $stream.Dispose() }"],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,COLDX_TEST_LOCK_PATH:file}});
      await new Promise((resolve,reject)=>{let output='',errors='';child.stdout.on('data',bytes=>{output+=bytes.toString();if(output.includes('locked'))resolve();});child.stderr.on('data',bytes=>{errors+=bytes.toString();});child.once('error',reject);child.once('exit',code=>{if(!output.includes('locked'))reject(Error('Lock helper failed '+code+': '+errors));});});
    }
    return fetch(url,options);
  };
  await f.store.check();await assert.rejects(f.store.stage({candidateId:next}),/integrity/);
  assert.deepEqual(await readdir(join(f.root,'state','staging')),[],f.store.state().notice??'Cleanup must wait for bounded Windows sharing retries.');
  assert.equal(f.store.state().active.commit,old);
});

test('cleanup never follows a replaced candidate junction outside the staging root',async t=>{
  const f=await fixture(t,{corrupt:true}),fetch=f.store.fetch,outside=join(f.root,'outside');await mkdir(outside);await writeFile(join(outside,'keep.txt'),'Preserve this file');
  f.store.fetch=async(url,options)=>{if(url.endsWith('/LICENSE')){const [directory]=await readdir(join(f.root,'state','staging')),target=join(f.root,'state','staging',directory);await rmdir(target);await symlink(outside,target,'junction');}return fetch(url,options);};
  await f.store.check();await assert.rejects(f.store.stage({candidateId:next}),/integrity/);
  assert.equal(await readFile(join(outside,'keep.txt'),'utf8'),'Preserve this file');assert.match(f.store.state().notice,/directory type/);
});

test('an existing candidate directory must match the exact downloaded upstream contents',async t=>{
  const f=await fixture(t),target=join(f.root,'state','versions',next);await cp(f.bundledDir,target,{recursive:true});
  const manifest=JSON.parse(await readFile(join(target,'manifest.json'),'utf8')),changed=body+'\nUnexpected local replacement.';manifest.commit=next;
  const row=manifest.files.find(item=>item.path.endsWith('SKILL.md'));row.sha256=sha(changed);row.bytes=Buffer.byteLength(changed);await writeFile(join(target,row.path),changed);await writeFile(join(target,'manifest.json'),JSON.stringify(manifest));
  await f.store.check();await assert.rejects(f.store.stage({candidateId:next}),/match|identity|完整/);assert.equal(f.store.state().active.commit,old);assert.equal(f.store.state().candidate.status,'failed');
});
test('confirmation revalidates persisted candidate bytes and cancellation preserves old snapshot',async t=>{
  const f=await fixture(t);await f.store.check();await f.store.stage({candidateId:next});
  await writeFile(join(f.root,'state','versions',next,'skills/test-driven-development/SKILL.md'),'changed');
  await assert.rejects(f.store.activate({candidateId:next,expectedActiveCommit:old}),/integrity|完整|hash/);
  assert.equal(f.store.state().active.commit,old);
  const controller=new AbortController();controller.abort(new Error('cancelled'));
  await assert.rejects(f.store.check({signal:controller.signal}),/cancelled/);assert.equal(f.store.state().active.commit,old);
});
test('bundled skill paths and copyright provenance are validated before exposing contents',async t=>{
  const f=await fixture(t);const manifest=JSON.parse(await readFile(join(f.bundledDir,'manifest.json'),'utf8'));
  assert.equal(manifest.upstream,'obra/superpowers');assert.equal((await f.store.snapshot(old)).skills.length,1);
  manifest.files.push({path:'../escape.md',bytes:1,sha256:sha('x')});await writeFile(join(f.bundledDir,'manifest.json'),JSON.stringify(manifest));
  const other=new SuperpowersStore({root:join(f.root,'invalid'),bundledDir:f.bundledDir});await assert.rejects(other.ready,/path|路径/);other.dispose();
});

test('shipped upstream Markdown matches its pinned Git blobs and exposes all native skills',async t=>{
  const directory=new URL('../vendor/superpowers/',import.meta.url),manifest=JSON.parse(await readFile(new URL('manifest.json',directory),'utf8'));
  assert.equal(manifest.commit,'b36e0829c6d0140e93cfef2ca599b1b07d4a7797');assert.equal(manifest.release,'6.3.0');
  for(const row of manifest.files){assert.ok(row.path==='LICENSE'||row.path.startsWith('skills/')&&row.path.endsWith('.md'));const bytes=await readFile(new URL(row.path,directory));assert.equal(blob(bytes),row.gitBlob,row.path);assert.equal(sha(bytes),row.sha256,row.path);}
  const root=await mkdtemp(join(tmpdir(),'coldx-real-bundle-')),store=new SuperpowersStore({root});t.after(()=>store.dispose());await store.ready;
  assert.equal(store.state().skills.length,14);assert.equal(manifest.files.length,40);
});
