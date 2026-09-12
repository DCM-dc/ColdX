import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildPdfBundle, copyPdfLicenses } from '../plugin/client/build-pdf.mjs';
import { createPdfViewComponents } from '../plugin/client/pdf-view-source.mjs';

import { samplePdf } from './helpers/pdf-fixture.mjs';

test('PDF model rejects incomplete/oversize data and bounds render memory at extreme zoom', () => {
  const { decodePdf, canvasSize } = createPdfViewComponents({ createElement() {} });
  const bytes = samplePdf(); assert.deepEqual(decodePdf(Buffer.from(bytes).toString('base64')), bytes);
  assert.throws(() => decodePdf('%%not-base64'), /无效/);
  assert.throws(() => decodePdf('a'.repeat(4 * Math.ceil(8 * 1024 * 1024 / 3) + 4)), /8 MB/);
  const dimensions = canvasSize({ width: 30000, height: 20000 }, 4);
  assert.ok(dimensions.width * dimensions.height <= 8_000_000);
  assert.throws(() => canvasSize({ width: Infinity, height: 20 }), /尺寸/);
  const isolated = vm.runInNewContext(`(${createPdfViewComponents.toString()})`);
  assert.equal(typeof isolated({ createElement() {} }).PdfPreview, 'function');
});

test('pinned PDF.js actually renders page pixels and extracts text from both pages without rereading data', async () => {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const require = createRequire(import.meta.url);
  const canvasApi = createRequire(require.resolve('pdfjs-dist/package.json'))('@napi-rs/canvas');
  const task = getDocument({ data: samplePdf(), disableFontFace: true, useSystemFonts: true, useWorkerFetch: false, verbosity: 0 });
  try {
    const pdf = await task.promise; assert.equal(pdf.numPages, 2);
    for (const number of [1, 2]) {
      const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 1 });
      const canvas = canvasApi.createCanvas(viewport.width, viewport.height);
      await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      assert.ok(pixels.some((value, index) => index % 4 !== 3 && value < 100), 'actual non-white PDF text pixels');
      const text = await page.getTextContent();
      assert.match(text.items.map(item => item.str ?? '').join(' '), number === 1 ? /page one/ : /page two/);
      page.cleanup();
    }
  } finally { await task.destroy(); }
});

test('self-contained browser bundle opens a native Worker and closing aborts loading and releases it', async () => {
  const code = await buildPdfBundle({ write: false });
  const workers = [], blobs = new Map(); let revoked = 0;
  class Worker {
    constructor(url) { this.url = url; this.listeners = new Map(); workers.push(this); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name) { this.listeners.delete(name); }
    postMessage() {}
    terminate() { this.terminated = true; }
  }
  const context = { console, setTimeout, clearTimeout, Uint8Array, Uint8ClampedArray, ArrayBuffer, structuredClone, TextEncoder, TextDecoder, AbortController,
    ReadableStream, DOMException, Blob, Worker, atob, Response, Request, Headers, URLSearchParams, URL: class extends URL {
      static createObjectURL(blob) { const id = `blob:pdf-${blobs.size}`; blobs.set(id, blob); return id; }
      static revokeObjectURL() { revoked++; }
    }, DOMMatrix: class {}, navigator: { platform: 'Win32', userAgent: 'Chrome/146' }, document: {} };
  vm.runInNewContext(code, context);
  assert.equal(context.__ColdXPdfRuntime.version, '6.3.289');
  const task = context.__ColdXPdfRuntime.open(samplePdf());
  assert.equal(workers.length, 1);
  assert.match(await blobs.get(workers[0].url).text(), /PDF preview network disabled/);
  task.destroy();
  await assert.rejects(task.promise, /closed|destroyed/i);
  assert.equal(workers[0].terminated, true); assert.equal(revoked, 1);
});

test('standalone distribution preserves complete upstream notices alongside embedded binary assets', async t => {
  const destination = await mkdtemp(join(tmpdir(), 'coldx-pdf-notices-'));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const copied = await copyPdfLicenses(destination);
  const require = createRequire(import.meta.url), upstream = dirname(require.resolve('pdfjs-dist/package.json'));
  for (const directory of ['', 'cmaps', 'standard_fonts', 'wasm']) {
    const originals = (await readdir(join(upstream, directory))).filter(name => /^(LICENSE|NOTICE)/.test(name));
    assert.ok(originals.length, `upstream notices exist for ${directory || 'PDF.js'}`);
    for (const name of originals) {
      const relative = [directory, name].filter(Boolean).join('/');
      assert.ok(copied.includes(relative));
      assert.deepEqual(await readFile(join(destination, relative)), await readFile(join(upstream, relative)), `${relative} is copied unmodified`);
    }
  }
  assert.match(await readFile(join(destination, 'README.txt'), 'utf8'), /https:\/\/github.com\/mozilla\/pdf.js/);
});
