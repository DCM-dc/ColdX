import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { surfaceCascade } from './helpers/surface-cascade.mjs';

const files = ['coldx.css', 'native.css', 'interaction.css', 'frost.css', 'attachment.css', 'activity.css', 'terminal.css', 'workbench.css'];
const bundled = (await Promise.all(files.map(file => readFile(new URL(`../plugin/client/${file}`, import.meta.url), 'utf8')))).join('\n');

test('workbench menus stay opaque after earlier material rules, including accessibility preferences', () => {
  for (const material of ['thin', 'regular', 'thick']) {
    for (const preference of ['none', 'prefers-reduced-transparency: reduce', 'prefers-contrast: more', 'forced-colors: active']) {
      const computed = surfaceCascade(bundled, preference, material, true);
      assert.equal(computed['backdrop-filter'], 'none', `${material}: ${preference}`);
      assert.equal(computed['-webkit-backdrop-filter'], 'none', `${material}: ${preference}`);
      assert.equal(computed.background, 'var(--cx-wb-surface)', 'the theme-aware opaque workbench surface wins');
    }
  }
});

test('workbench styling leaves a standalone authored Frost surface outside the shell unchanged', () => {
  for (const material of ['thin', 'regular', 'thick']) {
    const computed = surfaceCascade(bundled, 'none', material, false);
    assert.match(computed['backdrop-filter'], /^blur\(/);
    assert.equal(computed.background, `var(--cx-sys-material-${material})`);
  }
});
