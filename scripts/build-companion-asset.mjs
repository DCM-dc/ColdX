import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';

// Resize the untouched generated master once at build time; no browser canvas.
export async function buildCompanionAsset(){
  const require=createRequire(import.meta.url);
  const {createCanvas,loadImage}=createRequire(require.resolve('pdfjs-dist/package.json'))('@napi-rs/canvas');
  const image=await loadImage(await readFile(new URL('../plugin/client/assets/companion-source.png',import.meta.url)));
  const canvas=createCanvas(256,256),ctx=canvas.getContext('2d');
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(image,0,0,256,256);
  const bytes=await canvas.encode('png');
  await writeFile(new URL('../plugin/client/assets/companion.png',import.meta.url),bytes);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}
