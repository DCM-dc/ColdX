import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const coldx = await readFile(new URL('../plugin/client/coldx.css', import.meta.url), 'utf8');
const native = await readFile(new URL('../plugin/client/native.css', import.meta.url), 'utf8');

test('the composer uses a tinted milky frost with a light-catching edge', () => {
  const root = coldx.match(/\.coldx-shell \[data-slot="root"\]\s*\{([^}]+)\}/)?.[1] ?? '';
  assert.match(root, /--coldx-material-regular:\s*color-mix\([^;]*color-mix\([^;]*#cfe8f2[^;]*transparent\)/i,
    'frost needs a subtle cool tint as well as alpha or it disappears on a white canvas');
  const composer = coldx.match(/\.coldx-shell \[data-composer-card\]\s*\{([^}]+)\}/)?.[1] ?? '';
  assert.match(composer, /box-shadow:[^;]*inset\s+0\s+1px\s+0/i,
    'the top edge should catch light like a thick frosted surface');
  assert.match(composer, /box-shadow:[^;]*0\s+2[0-9]px\s+6[0-9]px/i,
    'the floating composer needs a soft long shadow to separate it from the canvas');
});

test('conversation bubbles and tool rows form a readable layered trajectory', () => {
  assert.match(native, /\.gdEzaW_bubble[^}]*background:\s*var\(--coldx-native-selected\)[^}]*box-shadow:/i);
  const rows = native.match(/:is\(\.QWLzlG_row,\s*\._Xvjua_row\)\s*\{([^}]+)\}/)?.[1] ?? '';
  assert.match(rows, /border:\s*1px\s+solid\s+transparent/i);
  assert.match(rows, /transition:[^;]*background-color[^;]*border-color/i);
  const hover = native.match(/@media \(hover: hover\) and \(pointer: fine\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(hover, /QWLzlG_row|_Xvjua_row/,
    'high-frequency tool rows may gain quiet colour feedback only behind a fine-pointer hover query');
});

test('rare hero motion and pointer controls share one restrained spring language', () => {
  assert.match(coldx, /\.coldx-hero\s*\{[^}]*animation:\s*coldx-appear\s+5[0-9]0ms\s+var\(--coldx-spring-sheet\)/i);
  assert.match(coldx, /\.coldx-hero \.coldx-ice-cube\s*\{[^}]*animation:\s*coldx-cube-settle/i);
  assert.match(native, /:is\(\.uV2eYG_add,\s*\.uV2eYG_primary,\s*\._7KE1Ra_trigger,\s*\.Sh0Q9G_trigger\)[^}]*transition:[^;]*transform[^;]*var\(--coldx-spring-control\)/i);
  assert.match(native, /:is\(\.uV2eYG_add,\s*\.uV2eYG_primary,\s*\._7KE1Ra_trigger,\s*\.Sh0Q9G_trigger\):active[^}]*scale\(\.9[4-8]\)/i);
});

test('Reduced Motion keeps the polish but removes hero and composer movement', () => {
  const coldxReduced = coldx.slice(coldx.indexOf('@media (prefers-reduced-motion:reduce)'));
  const nativeReduced = [...native.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g)].map(match => match[1]).join('\n');
  assert.match(coldxReduced, /\.coldx-hero[^}]*animation:\s*none/i);
  assert.match(coldxReduced, /\.coldx-hero \.coldx-ice-cube[^}]*animation:\s*none/i);
  assert.match(nativeReduced, /\.uV2eYG_add[^}]*transform:\s*none/i);
  assert.doesNotMatch(nativeReduced, /transition:[^;]*transform/i);
});

test('the real execution surface is a readable scrollable timeline', () => {
  for (const selector of [
    'coldx-process-panel', 'coldx-process-summary', 'coldx-process-list',
    'coldx-process-item', 'coldx-process-index', 'coldx-process-mark',
    'coldx-process-name', 'coldx-process-tool', 'coldx-process-status',
  ]) assert.match(coldx, new RegExp(`\\.${selector}\\b`), `${selector} needs a visual treatment`);

  const list = coldx.match(/\.coldx-process-list\s*\{([^}]+)\}/)?.[1] ?? '';
  assert.match(list, /overflow(?:-y)?:\s*auto/i, 'long real runs must remain scrollable');
  assert.match(list, /list-style:\s*none/i);
  const item = coldx.match(/\.coldx-process-item\s*\{([^}]+)\}/)?.[1] ?? '';
  assert.match(item, /display:\s*grid/i);
  assert.match(item, /grid-template-columns:/i);
});

test('process state is encoded by material, text and a restrained live signal', () => {
  assert.match(coldx, /\.coldx-process-summary\s*\{[^}]*border:[^}]*box-shadow:/is);
  assert.match(coldx, /\.coldx-process-item\[data-status="running"\][^}]*background:/i);
  for (const status of ['running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted']) {
    assert.match(coldx, new RegExp(`\\.coldx-process-item\\[data-status="${status}"\\]`), `${status} requires a semantic visual state`);
  }
  assert.match(coldx, /\.coldx-process-item\[data-status="running"\]\s+\.coldx-process-mark::after[^}]*animation:\s*coldx-process-pulse/i,
    'only the current live marker should pulse');
});

test('process entrance and live signal have non-motion accessibility equivalents', () => {
  assert.match(coldx, /\.coldx-process-item\s*\{[^}]*animation:\s*coldx-process-enter[^}]*var\(--coldx-spring-sheet\)/is);
  const reduced = coldx.slice(coldx.lastIndexOf('@media (prefers-reduced-motion:reduce)'));
  assert.match(reduced, /\.coldx-process-item[^}]*animation:\s*none/i);
  assert.match(reduced, /\.coldx-process-mark::after[^}]*animation:\s*none/i);
  const transparency = coldx.slice(coldx.indexOf('@media (prefers-reduced-transparency: reduce)'));
  assert.match(transparency, /\.coldx-process-summary/i);
  assert.match(transparency, /\.coldx-process-item\[data-status="running"\]/i);
  assert.match(transparency, /backdrop-filter:\s*none/i);
});
