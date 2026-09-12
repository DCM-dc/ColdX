import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep the original imagegen PNG intact. All shipping sizes derive from that master.
// Canvas is build-time only; the client gets one compact self-contained PNG.
export async function buildBrandAssets() {
  const require = createRequire(import.meta.url);
  const {createCanvas,loadImage} = createRequire(require.resolve('pdfjs-dist/package.json'))('@napi-rs/canvas');
  const source = await loadImage(await readFile(new URL('../plugin/client/assets/coldx-logo-source.png', import.meta.url)));
  const pngHref = bytes => `data:image/png;base64,${bytes.toString('base64')}`;
  const svg = (size, href) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><title>ColdX</title><image width="${size}" height="${size}" href="${href}"/></svg>`;
  const resize = async size => {
    const canvas = createCanvas(size,size), context = canvas.getContext('2d');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source,0,0,size,size);
    return canvas.encode('png');
  };
  const symbol = await resize(128), favicon = await resize(64);
  const canvas = createCanvas(1024,1024), context = canvas.getContext('2d');
  context.fillStyle = '#f5f6f8';
  context.beginPath();
  context.roundRect(40,40,944,944,224);
  context.fill();
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source,104,104,816,816);
  const desktop = await canvas.encode('png');
  const symbolHref = pngHref(symbol), faviconSvg = svg(64,pngHref(favicon));
  const files = {
    '../plugin/client/assets/coldx-logo.png': symbol,
    '../plugin/client/assets/favicon.png': favicon,
    '../plugin/client/assets/coldx-symbol.svg': svg(128,symbolHref) + '\n',
    '../plugin/client/assets/favicon.svg': faviconSvg + '\n',
    '../desktop/assets/icon.png': desktop,
    '../desktop/assets/icon.svg': svg(1024,pngHref(desktop)) + '\n',
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = new URL(relativePath, import.meta.url);
    await mkdir(dirname(fileURLToPath(path)), {recursive:true});
    await writeFile(path, contents);
  }
  return {symbolHref, faviconHref:`data:image/svg+xml;charset=utf-8,${encodeURIComponent(faviconSvg)}`};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await buildBrandAssets();
