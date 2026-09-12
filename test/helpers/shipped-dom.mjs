import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Execute the attribute setter and registration table from DSH's shipped
// frontend, not the unrelated react-dom 19 package also installed by pnpm.
const source = await readFile(new URL('../../node_modules/.pnpm/@deepseek-ai+dsh-web-frontend@0.1.1-rc.2/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-ClqxG24t.js', import.meta.url), 'utf8');
assert.ok(source.includes('Ce.version="18.3.1"'));
const start = source.indexOf('function L(e,t,r,o){');
const end = source.indexOf('var ie=n.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED', start);
assert.ok(start >= 0 && end > start, 'update extraction if the pinned native renderer changes');
const renderer = vm.runInNewContext(`${source.slice(start, end)}; ({ write: z, inertRegistration: V.inert })`, {
  // The setter's name-validation cache accepts the known-valid name "inert".
  w: name => name === 'inert',
});
assert.equal(renderer.inertRegistration, undefined);

export function renderIframeInert(node, value) {
  node.attributes ??= new Map();
  renderer.write({
    setAttribute(name, text) { node.attributes.set(name, text); },
    removeAttribute(name) { node.attributes.delete(name); },
  }, 'inert', value, false);
  // Model the HTML boolean attribute's reflected DOM property. Existing inner
  // focus is retained in the fixture: its controls become excluded by inert.
  node.inert = node.attributes.has('inert');
}

export function canReceiveInnerKey(frame) {
  return Boolean(frame.focusedInside && !frame.inert);
}
