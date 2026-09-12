import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join,dirname,resolve,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {ensureProfile} from '../lib/profile.mjs';
import {coldxModelDisplayName} from '../lib/model-names.mjs';
import {dshRequire} from '../plugin/page-native.mjs';

const official=['DeepSeek-V4.1-Flash','DeepSeek-V4-Flash','DeepSeek-V4-Flash-Vision-Exp','DeepSeek-V4-Pro'];
const legacy=['DeepSeek V4.1 Flash · Vision','DeepSeek Flash · 兼容名称','DeepSeek Flash · Vision 兼容名称','DeepSeek V4 Pro'];
async function profile(t) {
  const home=await mkdtemp(join(tmpdir(),'coldx-model-names-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const options={home,dshRoot:dirname(dshRequire.resolve('@deepseek-ai/dsh/package.json')),projectRoot:resolve('.'),persona:'You are ColdX.'};
  const result=await ensureProfile(options),patch=JSON.parse(await readFile(result.patchPath,'utf8'));
  const models=patch.find(row=>row.id==='llm-deepseek').config.models;
  return {options,result,patch,models};
}

test('existing managed profiles refresh official names without rewriting user configuration or selection',async t=>{
  const f=await profile(t);
  const selection=JSON.stringify(f.patch.find(row=>row.id==='agent-default-model'));
  for(let index=0;index<f.models.length;index++)f.models[index].name=legacy[index];
  await writeFile(f.result.patchPath,JSON.stringify(f.patch));
  const userText='# My provider connection and name stay user-owned.\r\n'+JSON.stringify([{id:'llm-deepseek',config:{apiKey:'offline-fixture-key',baseURL:'https://offline-fixture.invalid',models:[{...f.models[0],name:'我的研究模型'}]}}])+'\r\n';
  const userPath=join(f.result.profileDir,'cordis.patch.yml');await writeFile(userPath,userText);
  await ensureProfile(f.options);
  const after=JSON.parse(await readFile(f.result.patchPath,'utf8'));
  assert.deepEqual(after.find(row=>row.id==='llm-deepseek').config.models.map(model=>model.name),official);
  assert.ok(JSON.stringify(after.find(row=>row.id==='agent-default-model'))===selection,'startup only refreshes display metadata, not the chosen route');
  assert.ok(await readFile(userPath,'utf8')===userText,'the complete user configuration remains byte-for-byte unchanged');
});

test('only recognized unnamed models and exact old product labels receive official display names',async t=>{
  const {models}=await profile(t);
  for(let index=0;index<models.length;index++){
    const model=models[index];
    assert.equal(coldxModelDisplayName({...model,name:legacy[index]}),official[index]);
    assert.equal(coldxModelDisplayName({...model,name:undefined}),official[index]);
    assert.equal(coldxModelDisplayName({...model,name:model.id}),official[index]);
    for(const name of ['我的研究模型','Custom · Vision',`${legacy[index]} · 我的配置`])assert.equal(coldxModelDisplayName({...model,name}),name);
  }
  assert.equal(coldxModelDisplayName({id:'unlisted-fixture',name:legacy[0]}),legacy[0]);
  assert.equal(coldxModelDisplayName({id:'unlisted-fixture'}),'unlisted-fixture');
});

test('the pinned native metadata seam normalizes existing catalogs for every model-directory consumer',async t=>{
  const {models}=await profile(t);
  // Use the actual desktop patch engine against the exact installed package.
  // This works both before and after the root applies the pending native patch.
  const parser=await readFile(new URL('../scripts/desktop/native-patches.mjs',import.meta.url),'utf8');
  const {parsePatch,patchText}=new Function('isAbsolute',parser.slice(parser.indexOf('function parsePatch('),parser.indexOf('async function installedPackages('))+';return{parsePatch,patchText};')(isAbsolute);
  const patch=await readFile(new URL('../patches/@deepseek-ai__dsh-llm-deepseek@0.1.1-rc.2.patch',import.meta.url),'utf8');
  const hunks=parsePatch(patch).find(file=>file.path==='lib/index.js').hunks;
  const installed=await readFile(dshRequire.resolve('@deepseek-ai/dsh-llm-deepseek'),'utf8');
  const alreadyApplied=installed.includes('function coldxModelDisplayName(');
  const applied=alreadyApplied?hunks:hunks.filter(hunk=>!hunk.lines.some(line=>line.kind==='+'&&line.text.includes('function coldxModelDisplayName(')));
  const reversed=applied.map(hunk=>({...hunk,oldStart:hunk.newStart,oldCount:hunk.newCount,newStart:hunk.oldStart,newCount:hunk.oldCount,lines:hunk.lines.map(line=>({...line,kind:line.kind==='+'?'-':line.kind==='-'?'+':' '}))}));
  const original=patchText(installed,reversed),updated=patchText(original,hunks);
  const normalizer=updated.match(/^function coldxModelDisplayName\(model\) \{[\s\S]*?^\}/m)?.[0];
  const modelInfo=updated.match(/^function modelInfo\(provider, model\) \{[\s\S]*?^\}/m)?.[0];
  const listModels=updated.match(/\tlistModels\(provider\) \{\n([\s\S]*?)\n\t\}/)?.[1];
  assert.ok(normalizer&&modelInfo&&listModels,'native adapter metadata entry points must remain available');
  const list=new Function(`${normalizer}\n${modelInfo}\nreturn function(provider){${listModels}\n};`)();
  const catalog=models.map((model,index)=>({...model,name:legacy[index]}));
  catalog.push({...models[0],id:'unlisted-fixture',name:legacy[0]},{...models[0],name:'我的研究模型'});
  const before=JSON.stringify(catalog);
  const adapter={config:{options:()=>({models:catalog})}};
  const projected=await list.call(adapter,'fixture-provider');
  assert.deepEqual(projected.map(model=>model.name),[...official,legacy[0],'我的研究模型']);
  assert.ok(projected.every((model,index)=>model.id===catalog[index].id&&model.description===catalog[index].description&&JSON.stringify(model.inputModalities)===JSON.stringify(catalog[index].inputModalities)),'the projection preserves IDs and capability metadata');
  assert.ok(JSON.stringify(catalog)===before,'existing provider settings are never mutated by presentation');
  assert.ok(normalizer===coldxModelDisplayName.toString(),'the native patch embeds the reviewed pure function without drift');
});
