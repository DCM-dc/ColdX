import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const coldx = await readFile(new URL('../plugin/client/coldx.css', import.meta.url), 'utf8');
const native = await readFile(new URL('../plugin/client/native.css', import.meta.url), 'utf8');

function mediaBlock(css, query) {
  const start = css.indexOf(`@media (${query})`);
  assert.notEqual(start, -1, `${query} block should exist`);
  return css.slice(start, css.indexOf('\n}', start) + 2);
}

test('theme-derived material tokens live where native DSH theme tokens exist', () => {
  const root = coldx.match(/\.coldx-shell \[data-slot="root"\]\s*\{([^}]+)\}/)?.[1] ?? '';
  for (const token of ['--coldx-line', '--coldx-muted', '--coldx-wash', '--coldx-material-regular', '--coldx-material-thick']) {
    assert.match(root, new RegExp(`${token.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*:`),
      `${token} must resolve inside the DSH theme scope instead of becoming invalid on <html>`);
  }
  const nativeRoot = native.match(/\.coldx-shell \[data-slot="root"\]\s*\{([^}]+)\}/)?.[1] ?? '';
  for (const token of ['--coldx-native-surface', '--coldx-native-raised', '--coldx-native-line', '--coldx-native-wash', '--coldx-native-selected', '--coldx-native-focus']) {
    assert.match(nativeRoot, new RegExp(`${token.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*:`),
      `${token} must resolve inside the DSH theme scope instead of becoming invalid on <html>`);
  }
});

test('frosted material is limited to floating ColdX composer and workbench tools', () => {
  assert.match(coldx, /@supports\s*\([^\n]+backdrop-filter:[^\n]+\)\s*\{[\s\S]*?\[data-composer-card\][\s\S]*?\.coldx-stage-tools[\s\S]*?\}/i);
  const material = coldx.slice(coldx.indexOf('@supports ((-webkit-backdrop-filter'));
  assert.match(material, /\[data-composer-card\][^}]*background:\s*var\(--coldx-material-regular\)[^}]*-webkit-backdrop-filter:\s*blur\(2[0-9]px\)\s+saturate\(1[2-5][0-9]%\)[^}]*backdrop-filter:\s*blur\(2[0-9]px\)\s+saturate\(1[2-5][0-9]%\)/is);
  assert.match(material, /\.coldx-stage-tools[^}]*background:\s*var\(--coldx-material-regular\)[^}]*-webkit-backdrop-filter:[^}]*backdrop-filter:/is);
  assert.doesNotMatch(material, /\.hHd-Xa_root[^}]*backdrop-filter/i,
    'the sidebar root must never become a backdrop-filter containing block for fixed portals');
});

test('native menus use regular frost while dialogs and settings use a thicker material', () => {
  const start = native.indexOf('@supports ((-webkit-backdrop-filter');
  assert.notEqual(start, -1, 'native material feature query should exist');
  const material = native.slice(start);
  assert.match(material, /:is\(\.\_list_19372_8,\s*\.\_submenu_19372_9\)[^}]*background:\s*var\(--coldx-material-regular\)[^}]*-webkit-backdrop-filter:\s*blur\(2[0-9]px\)[^}]*backdrop-filter:\s*blur\(2[0-9]px\)/is);
  assert.match(material, /:is\(\.\_dialog_15u5s_22,\s*\.jLrgrW_dialog,\s*\.VOzbGW_panel\)[^}]*background:\s*var\(--coldx-material-thick\)[^}]*-webkit-backdrop-filter:\s*blur\(3[0-6]px\)[^}]*backdrop-filter:\s*blur\(3[0-6]px\)/is);
  assert.doesNotMatch(material, /(?:linear|radial|conic)-gradient/i);
});

test('transparency accessibility preferences return every frosted surface to solid paint', () => {
  for (const [css, selectors] of [
    [coldx, ['data-composer-card', 'coldx-stage-tools']],
    [native, ['_list_19372_8', '_submenu_19372_9', '_dialog_15u5s_22', 'jLrgrW_dialog', 'VOzbGW_panel']],
  ]) {
    const reduced = mediaBlock(css, 'prefers-reduced-transparency: reduce');
    const forced = mediaBlock(css, 'forced-colors: active');
    for (const selector of selectors) {
      assert.match(reduced, new RegExp(selector), `${selector} should opt out when transparency is reduced`);
      assert.match(forced, new RegExp(selector), `${selector} should opt out in forced colors`);
    }
    for (const block of [reduced, forced]) {
      assert.match(block, /-webkit-backdrop-filter:\s*none/i);
      assert.match(block, /backdrop-filter:\s*none/i);
      assert.match(block, /background:\s*(?:var\(--dsw-alias-bg-base\)|Canvas)/i);
    }
  }
});

test('increased contrast uses solid materials with a stronger separator', () => {
  for (const [css, selectors] of [
    [coldx, ['data-composer-card', 'coldx-stage-tools']],
    [native, ['_list_19372_8', '_submenu_19372_9', '_dialog_15u5s_22', 'jLrgrW_dialog', 'VOzbGW_panel']],
  ]) {
    const contrast = mediaBlock(css, 'prefers-contrast: more');
    for (const selector of selectors) assert.match(contrast, new RegExp(selector));
    assert.match(contrast, /-webkit-backdrop-filter:\s*none/i);
    assert.match(contrast, /backdrop-filter:\s*none/i);
    assert.match(contrast, /background:\s*var\(--dsw-alias-bg-base\)/i);
  }
});
