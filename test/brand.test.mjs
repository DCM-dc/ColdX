import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createBrandComponents } from '../plugin/client/brand-source.mjs';

const React={createElement:(type,props,...children)=>({type,props:{...props,children:children.flat(Infinity)}})};
const flatten=node=>typeof node==='object'&&node?[node,...(node.props?.children??[]).flatMap(flatten)]:[];
const assetFile=path=>readFile(new URL(path,import.meta.url));
const symbolPng=await assetFile('../plugin/client/assets/coldx-logo.png');
const faviconSvg=(await assetFile('../plugin/client/assets/favicon.svg')).toString().trim();
const assets={symbolHref:`data:image/png;base64,${symbolPng.toString('base64')}`,faviconHref:`data:image/svg+xml;charset=utf-8,${encodeURIComponent(faviconSvg)}`};

test('brand uses the generated PNG without a network request or a replacement drawing',()=>{
  const brand=createBrandComponents(React,assets),mark=brand.Mark({size:24});
  assert.equal(mark.type,'img');assert.equal(mark.props.width,24);assert.equal(mark.props.alt,'ColdX');
  assert.equal(mark.props.src,assets.symbolHref);assert.equal(mark.props.draggable,false);
  assert.deepEqual(mark.props.children,[]);
  assert.equal(decodeURIComponent(brand.faviconHref.split(',')[1]),faviconSvg);
});

test('compact naming stays plain text and adjacent hero graphics do not duplicate its accessible name',()=>{
  const brand=createBrandComponents(React,assets),name=brand.Name(),hero=brand.HeroBrand();
  assert.deepEqual(name.props.children,['ColdX']);
  const graphics=flatten(hero).filter(node=>node.type===brand.Mark);
  assert.equal(graphics.length,1);assert.equal(graphics[0].props.decorative,true);
  const decorative=brand.Mark({decorative:true});
  assert.equal(decorative.props.alt,'');assert.equal(decorative.props['aria-hidden'],true);
  const isolated=vm.runInNewContext(`(${createBrandComponents.toString()})`)(React,assets);
  assert.equal(isolated.Mark({size:16}).props.width,16);
  assert.equal(isolated.Mark().props.src,assets.symbolHref);
  assert.doesNotMatch(JSON.stringify(hero),/🧊|coldx-ice|coldx-wordmark/);
});

test('published brand assets preserve alpha and share their PNG artwork with SVG wrappers',async()=>{
  const require=createRequire(import.meta.url);
  const {createCanvas,loadImage}=createRequire(require.resolve('pdfjs-dist/package.json'))('@napi-rs/canvas');
  const paths=[
    ['../plugin/client/assets/coldx-logo.png','../plugin/client/assets/coldx-symbol.svg',128],
    ['../plugin/client/assets/favicon.png','../plugin/client/assets/favicon.svg',64],
    ['../desktop/assets/icon.png','../desktop/assets/icon.svg',1024],
  ];
  for(const [pngPath,svgPath,size] of paths){
    const png=await assetFile(pngPath),svg=(await assetFile(svgPath)).toString();
    assert.ok(svg.includes(`data:image/png;base64,${png.toString('base64')}`));
    assert.doesNotMatch(svg,/<(?:script|path|filter)|https?:\/\/(?!www\.w3\.org)/i);
    const shipped=await loadImage(png);
    assert.equal(shipped.width,size);assert.equal(shipped.height,size);
    const actual=createCanvas(size,size).getContext('2d');actual.drawImage(shipped,0,0);
    assert.equal(actual.getImageData(0,0,1,1).data[3],0,'transparent outer corner');
    assert.ok(actual.getImageData(0,0,size,size).data.some((value,index)=>index%4===3&&value===255),'visible artwork');
    const embedded=Buffer.from(svg.match(/href="data:image\/png;base64,([^"]+)"/)[1],'base64');
    assert.deepEqual(embedded,png,'SVG wrapper embeds the exact shipped PNG bytes');
  }
  const master=await loadImage(await assetFile('../plugin/client/assets/coldx-logo-source.png'));
  assert.ok(master.width>=1024&&master.height>=1024,'full-resolution generated master retained');
  assert.ok(symbolPng.length<100_000,'UI does not inline the full-resolution master');
});
