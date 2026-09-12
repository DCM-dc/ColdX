import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const css = await readFile(new URL('../plugin/client/native.css', import.meta.url), 'utf8');

test('Reduced Motion keeps semantic fades while removing native spatial motion', () => {
  const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g)].map(match => match[1]);
  const reduced = blocks.find(block => block.includes('._list_19372_8')) ?? '';

  const surfaces = reduced.match(/:is\(\.\_list_19372_8,[^}]+\}\s*/)?.[0] ?? '';
  assert.match(surfaces, /transition:\s*opacity\s+1[2-8]0ms/i,
    'menus, dialogs, masks and disclosure details should retain a short opacity fade');
  assert.match(surfaces, /transform:\s*none/i,
    'menus, dialogs and disclosure details should not move in Reduced Motion');

  const controls = reduced.match(/:is\(\.\_button_kz6gm_4,[^}]+\}\s*/)?.[0] ?? '';
  assert.match(controls, /transition:[^;]*(?:background-color|border-color|box-shadow)/i,
    'controls should retain semantic state feedback');
  assert.doesNotMatch(controls, /transition:[^;]*transform/i,
    'control press scale must stay disabled');
});

test('Reduced Motion never animates transform in native surfaces', () => {
  const start = css.lastIndexOf('@media (prefers-reduced-motion: reduce)');
  const reduced = css.slice(start);
  assert.doesNotMatch(reduced, /transition:[^;]*transform/i);
  assert.doesNotMatch(reduced, /translate|scale\(/i);
});
