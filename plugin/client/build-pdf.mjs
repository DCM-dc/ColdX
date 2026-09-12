import { build } from 'esbuild';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = dirname(require.resolve('pdfjs-dist/package.json'));

// Binary resources are embedded in the bundle; their full notices must travel
// with it even when production installs omit the PDF.js development dependency.
export async function copyPdfLicenses(destination = fileURLToPath(new URL('./pdf-licenses/', import.meta.url))) {
  const copied = [];
  for (const directory of ['', 'cmaps', 'standard_fonts', 'wasm']) {
    const names = (await readdir(join(root, directory))).filter(name => /^(?:LICENSE|NOTICE)(?:[._-].*)?$/.test(name)).sort();
    await mkdir(join(destination, directory), { recursive: true });
    for (const name of names) {
      await copyFile(join(root, directory, name), join(destination, directory, name));
      copied.push([directory, name].filter(Boolean).join('/'));
    }
  }
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  await writeFile(join(destination, 'README.txt'), `ColdX PDF preview third-party notices\n\nPDF.js / pdfjs-dist ${version}\nSource: https://github.com/mozilla/pdf.js\nDistribution: https://www.npmjs.com/package/pdfjs-dist/v/${version}\n\nThe full upstream notices below accompany the bundled PDF.js code, CMaps, standard fonts and WebAssembly resources. Paths are preserved from the pdfjs-dist distribution.\n\n${copied.map(path => `- ${path}`).join('\n')}\n`);
  return copied;
}

export async function buildPdfBundle({ write = true } = {}) {
  const assets = {};
  for (const [kind, directory, allow] of [
    ['cMapUrl', 'cmaps', /\.bcmap$/],
    ['standardFontDataUrl', 'standard_fonts', /\.(?:pfb|ttf)$/],
    ['wasmUrl', 'wasm', /^(?:jbig2|openjpeg|qcms_bg)\.wasm$/],
  ]) {
    assets[kind] = {};
    for (const name of (await readdir(join(root, directory))).filter(name => allow.test(name)).sort()) {
      assets[kind][name] = (await readFile(join(root, directory, name))).toString('base64');
    }
  }
  const worker = await build({ entryPoints: [join(root, 'legacy/build/pdf.worker.mjs')], bundle: true, format: 'iife', platform: 'browser',
    target: ['chrome130'], minify: true, write: false, legalComments: 'inline', logLevel: 'silent' });
  // PDF data cannot initiate network requests. Binary assets go through the allowlisted factory.
  const guard = 'globalThis.fetch=()=>Promise.reject(new Error("PDF preview network disabled"));globalThis.XMLHttpRequest=class{constructor(){throw new Error("PDF preview network disabled")}};';
  const runtime = await build({ entryPoints: [fileURLToPath(new URL('./pdf-runtime-entry.mjs', import.meta.url))], bundle: true,
    format: 'iife', globalName: '__ColdXPdfRuntime', platform: 'browser', target: ['chrome130'], minify: true, write: false,
    legalComments: 'inline', logLevel: 'silent', define: { __COLDX_PDF_RESOURCES__: JSON.stringify(assets), __COLDX_PDF_WORKER__: JSON.stringify(guard + worker.outputFiles[0].text) } });
  const code = runtime.outputFiles[0].text;
  if (write) {
    await copyPdfLicenses();
    await writeFile(new URL('./pdf-runtime.js', import.meta.url), code);
  }
  return code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await buildPdfBundle();
