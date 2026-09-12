import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = () => readFile(new URL('../plugin/client/frost.css', import.meta.url), 'utf8');

test('Frost declares semantic, motion, and bounded material tokens', async () => {
  const source = await css();
  for (const token of ['--cx-sys-surface', '--cx-sys-text', '--cx-sys-accent', '--cx-sys-separator', '--cx-sys-focus', '--cx-sys-status-success', '--cx-sys-material-regular', '--cx-motion-press', '--cx-motion-materialize']) {
    assert.match(source, new RegExp(`${token}:`));
  }
  assert.match(source, /blur\(16px\)|blur\(24px\)|blur\(36px\)/);
  assert.match(source, /\.cx-surface\[data-floating="true"\]\[data-material="(?:thin|regular|thick)"\]/);
  assert.doesNotMatch(source, /\.cx-surface\[data-material="(?:thin|regular|thick)"\] \{[^}]*backdrop-filter: blur/s);
  assert.match(source, /\.cx-surface \.cx-surface\[data-material\] \{[^}]*backdrop-filter: none/s);
  const finalFloatingBlur = source.lastIndexOf('.cx-surface[data-floating="true"][data-material="thick"]');
  const nestedReset = source.lastIndexOf('.cx-surface .cx-surface[data-material]');
  assert.ok(nestedReset > finalFloatingBlur, 'the nested-surface reset must cascade after every floating blur rule');
  assert.match(source.slice(nestedReset, source.indexOf('}', nestedReset) + 1), /background: var\(--cx-sys-surface-elevated\); -webkit-backdrop-filter: none; backdrop-filter: none;/);
});

test('Frost provides resilient component, input, and preference rules without structural-sidebar blur', async () => {
  const source = await css();
  assert.match(source, /\.cx-action:focus-visible/);
  assert.match(source, /@media \(pointer: coarse\)/);
  assert.match(source, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(source, /@media \(prefers-reduced-transparency: reduce\)/);
  assert.match(source, /@media \(prefers-contrast: more\)/);
  assert.match(source, /@media \(forced-colors: active\)/);
  assert.match(source, /@media \(prefers-contrast: more\) \{[^}]*-webkit-backdrop-filter: none; backdrop-filter: none;/s);
  assert.match(source, /@media \(forced-colors: active\) \{[^}]*-webkit-backdrop-filter: none; backdrop-filter: none;/s);
  assert.doesNotMatch(source, /(?:sidebar|Sidebar)[^{]*\{[^}]*backdrop-filter/s);
  assert.match(source, /transition(?:-property)?:[^;]*(?:transform|opacity|color|border|box-shadow)/);
  assert.doesNotMatch(source, /transition(?:-property)?:[^;]*(?:width|height|left|top)/);
});

// Evaluate the declaration that wins, not the mere presence of a reset string.
// frost.css is appended last by the production build.
test('Frost and Coding-mode floating materials become solid in the bundled preference cascade', async () => {
  const { surfaceCascade } = await import('./helpers/surface-cascade.mjs');
  const bundled = (await Promise.all(['coldx.css', 'native.css', 'interaction.css', 'frost.css'].map(file => readFile(new URL(`../plugin/client/${file}`, import.meta.url), 'utf8')))).join('\n');
  for (const codingMode of [false, true]) for (const material of ['thin', 'regular', 'thick']) {
    const ordinary = surfaceCascade(bundled, 'none', material, codingMode);
    assert.match(ordinary['backdrop-filter'], /^blur\(/, 'the evaluator must match the floating allowlist');
    for (const preference of ['prefers-reduced-transparency: reduce', 'prefers-contrast: more', 'forced-colors: active']) {
      const computed = surfaceCascade(bundled, preference, material, codingMode);
      const label = `${codingMode ? 'coding-mode' : 'Frost'} ${material} ${preference}`;
      assert.equal(computed['backdrop-filter'], 'none', `${label}: unprefixed filter`);
      assert.equal(computed['-webkit-backdrop-filter'], 'none', `${label}: prefixed filter`);
      assert.equal(computed.background, preference === 'forced-colors: active' ? 'Canvas' : 'var(--cx-sys-surface)', `${label}: solid paint`);
    }
  }
});
