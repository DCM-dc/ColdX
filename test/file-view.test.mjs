import test from 'node:test';
import assert from 'node:assert/strict';
import {createFileViewComponents} from '../plugin/client/file-view-source.mjs';
test('file references preserve the current draft and isolate session owners',()=>{
  let draft,cleanup;
  const api=createFileViewComponents({createElement(){},useEffect(fn){cleanup=fn();}},()=>null,()=>{});
  api.InputReferenceBridge({sessionId:'one',input:{draft:'继续修改'},inputActions:{setDraft(value){draft=value;}}});
  assert.throws(()=>api.reference('other','report.md'),/未就绪/);
  api.reference('one','folder/report.md','first\nsecond');
  assert.equal(draft,'继续修改\n@"folder/report.md"\n> first\n> second\n');
  cleanup(); assert.throws(()=>api.reference('one','report.md'),/未就绪/);
});
test('artifact mention resolution only links known paths and rejects ambiguous names',()=>{
  const api=createFileViewComponents({createElement(){}},()=>null,()=>{});
  api.setKnown('one',['a/report.md','b/report.md','图表.png']);
  assert.equal(api.resolve('one','report.md'),undefined);
  assert.equal(api.resolve('other','图表.png'),undefined);
  assert.equal(api.resolve('one','imaginary.txt'),undefined);
  assert.equal(api.resolve('one','a/report.md').title,'a/report.md');
  assert.equal(api.resolve('one','图表.png').label,'打开 图表.png');
});

test('read-only child references return to the owning conversation and preserve its draft once',()=>{
  let draft,opened=0;
  const api=createFileViewComponents({createElement(){},useEffect(fn){fn();}},()=>null,()=>{},undefined,{getReferenceTarget:id=>id==='child'?{sessionId:'parent',open(){opened++;}}:undefined});
  api.InputReferenceBridge({sessionId:'child',input:{draft:''},inputActions:{setDraft(){assert.fail('read-only hidden child input must not receive references');}}});
  api.reference('child','report.md','selected');
  assert.equal(opened,1);
  assert.throws(()=>api.reference('unrelated','report.md'),/未就绪/);
  api.InputReferenceBridge({sessionId:'parent',input:{draft:'继续'},inputActions:{setDraft(value){draft=value;}}});
  assert.equal(draft,'继续\n@"report.md"\n> selected\n');
  draft='unchanged';
  api.InputReferenceBridge({sessionId:'parent',input:{draft:'继续'},inputActions:{setDraft(value){draft=value;}}});
  assert.equal(draft,'unchanged');
});
test('local document links retain encoded filename characters and resolve against the open document',()=>{
  const {parseLocalFileLink:parse}=createFileViewComponents({createElement(){}},()=>null,()=>{});
  for(const href of ['https://example.com/report.pdf','ftp://example.com/report.pdf','tel:123.txt','javascript:evil.txt','//example.com/a.md','#heading']) assert.equal(parse(href),null);
  assert.deepEqual(parse('report%23L2.md','docs/readme.md'),{path:'docs/report#L2.md',line:undefined});
  assert.deepEqual(parse('report.md#L2','docs/readme.md'),{path:'docs/report.md',line:2});
  assert.deepEqual(parse('C:/workspace/report.md:23'),{path:'C:/workspace/report.md',line:23});
  assert.deepEqual(parse('file:///C:/workspace/report.md'),{path:'C:/workspace/report.md',line:undefined});
  assert.deepEqual(parse('file:///tmp/report.md'),{path:'/tmp/report.md',line:undefined});
});
