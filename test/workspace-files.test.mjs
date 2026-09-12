import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listWorkspaceFiles, readWorkspaceFile } from '../plugin/workspace-files.mjs';
import * as fs from 'node:fs/promises';
import * as paths from 'node:path';
import vm from 'node:vm';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'coldx-view-'));
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested', '报告.md'), '# Report\nreal contents');
  await writeFile(join(root, 'image.png'), Buffer.from([137,80,78,71,13,10,26,10]));
  return root;
}
test('workspace browsing and preview return real files with canonical relative paths', async () => {
  const root = await fixture();
  const listing = await listWorkspaceFiles(root, { path: '.' });
  assert.equal(listing.entries[0].kind, 'directory');
  assert.equal(listing.entries[0].path, 'nested');
  const file = await readWorkspaceFile(root, { path: join(root, 'nested', '报告.md') });
  assert.equal(file.path, 'nested/报告.md');
  assert.equal(file.kind, 'markdown');
  assert.equal(file.text, '# Report\nreal contents');
  assert.equal(file.truncated, false);
  const image = await readWorkspaceFile(root, { path: 'image.png' });
  assert.equal(image.kind, 'image');
  assert.equal(image.mime, 'image/png');
  assert.equal(Buffer.from(image.base64, 'base64').length, 8);
});
test('file operations reject traversal, directories as files, malformed requests and links outside workspace', async t => {
  const root = await fixture();
  for (const path of ['../outside.txt', '/etc/passwd', 'a\u0000b']) {
    await assert.rejects(readWorkspaceFile(root, { path }));
  }
  await assert.rejects(readWorkspaceFile(root, { path: 'nested' }), /regular file/);
  await assert.rejects(listWorkspaceFiles(root, { path: '.', extra: true }), /request/);
  const outside = await mkdtemp(join(tmpdir(), 'coldx-outside-'));
  await writeFile(join(outside, 'secret.txt'), 'outside');
  try { await symlink(outside, join(root, 'escape'), 'junction'); }
  catch (error) { if (error.code === 'EPERM') return t.diagnostic('Symlink permission unavailable'); throw error; }
  await assert.rejects(readWorkspaceFile(root, { path: 'escape/secret.txt' }), /workspace/);
});
test('absolute workspace aliases and canonical paths share the same bounded preview root', async t => {
  const root = await fixture();
  const alias = join(await mkdtemp(join(tmpdir(), 'coldx-workspace-alias-')), 'workspace');
  try { await symlink(root, alias, 'junction'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Directory links unavailable'); throw error; }
  for (const path of [join(alias, 'nested', '报告.md'), join(root, 'nested', '报告.md'), 'nested/报告.md']) {
    const file = await readWorkspaceFile(alias, { path });
    assert.equal(file.path, 'nested/报告.md');
    assert.equal(file.text, '# Report\nreal contents');
  }
  const outside = join(await mkdtemp(join(tmpdir(), 'coldx-alias-outside-')), 'private.md');
  await writeFile(outside, 'outside');
  await assert.rejects(readWorkspaceFile(alias, { path: outside }), /workspace/);
});
test('preview bounds large content and reports cancellation', async () => {
  const root = await fixture();
  await writeFile(join(root, 'large.txt'), 'x'.repeat(3 * 1024 * 1024));
  const file = await readWorkspaceFile(root, { path: 'large.txt' });
  assert.equal(file.truncated, true);
  assert.equal(file.text.length, 2 * 1024 * 1024);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readWorkspaceFile(root, { path: 'image.png' }, controller.signal), /abort/i);
});
test('preview binds the opened file identity when its path is swapped and restored during open', async () => {
  const root = await fixture();
  const target = join(root,'nested','报告.md'), saved = join(root,'nested','saved.md');
  const outside = join(await mkdtemp(join(tmpdir(),'coldx-swap-')),'outside.txt');
  await writeFile(outside,'OUTSIDE_FIXTURE');
  const source = await fs.readFile(new URL('../plugin/workspace-files.mjs',import.meta.url),'utf8');
  const runtime = vm.runInNewContext(source.replace(/^import .*;\r?$/gmu,'').replaceAll('export async function ','async function ')+'\n({readWorkspaceFile})',{
    ...fs,...paths,Buffer,TextDecoder,
    open:async(file,flags)=>{
      await fs.rename(target,saved);
      await fs.link(outside,target);
      const handle = await fs.open(file,flags);
      await fs.unlink(target); await fs.rename(saved,target);
      return handle;
    },
  });
  await assert.rejects(runtime.readWorkspaceFile(root,{path:'nested/报告.md'}),/identity changed/);
  assert.equal(await fs.readFile(target,'utf8'),'# Report\nreal contents');
});
test('PowerShell UTF-16 files remain previewable text, including non-ASCII documents', async()=>{
  const root=await fixture();
  await writeFile(join(root,'report.html'),Buffer.concat([Buffer.from([255,254]),Buffer.from('<h1>中英对译</h1>','utf16le')]));
  const file=await readWorkspaceFile(root,{path:'report.html'});
  assert.equal(file.kind,'html'); assert.equal(file.encoding,'utf-16le'); assert.equal(file.text,'<h1>中英对译</h1>');
  assert.deepEqual(Buffer.from(file.downloadBase64,'base64'),await fs.readFile(join(root,'report.html')));
  await writeFile(join(root,'extracted.html'),'<p>PDF\u0000text</p>');
  const extracted=await readWorkspaceFile(root,{path:'extracted.html'});
  assert.equal(extracted.kind,'html'); assert.equal(extracted.replacedNulls,1);
  assert.deepEqual(Buffer.from(extracted.downloadBase64,'base64'),await fs.readFile(join(root,'extracted.html')));
});
