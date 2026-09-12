import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const css = await readFile(new URL('../plugin/client/native.css', import.meta.url), 'utf8');
test('exact native command and model secondary surfaces use bounded Frost hierarchy', () => {
  for (const selector of ['._3e4SsG_menu[aria-label="触发候选建议"]', '._3e4SsG_item', '._3e4SsG_active', '._3e4SsG_itemName', '._3e4SsG_itemDescription', '._7KE1Ra_menu[role="menu"]', '._7KE1Ra_groups', '._7KE1Ra_group', '._7KE1Ra_groupTitle', '._7KE1Ra_option', '._7KE1Ra_selected', '._7KE1Ra_modelName', '._7KE1Ra_description', '._3e4SsG_viewport']) assert.ok(css.includes(selector), `missing ${selector}`);
  const section = css.slice(css.indexOf('/* Frost composer secondary surfaces'));
  for (const contract of ['--cx-sys-material-regular', 'max-height:', 'overflow-y: auto', ':focus-visible', 'outline:', 'box-shadow:', 'border-radius:', 'cx-secondary-materialize', '520ms', '._7KE1Ra_check']) assert.ok(section.includes(contract), `missing ${contract}`);
  assert.doesNotMatch(section, /(?:^|[;{]\s*)(?:position|top|bottom|left|right):\s*(?:fixed|absolute|\d)/, 'native portal positioning must remain native');
});
test('secondary menus materialize with solid accessible fallbacks and narrow layouts', () => {
  const section = css.slice(css.indexOf('/* Frost composer secondary surfaces'));
  for (const contract of ['@keyframes cx-secondary-materialize', '@keyframes cx-secondary-fade', 'prefers-reduced-motion: reduce', 'prefers-reduced-transparency: reduce', 'prefers-contrast: more', 'forced-colors: active', 'max-width: 640px', 'pointer: coarse', 'min-height: 44px', 'backdrop-filter: none', 'Highlight', '160ms']) assert.ok(section.includes(contract), `missing ${contract}`);
  assert.match(section, /@keyframes cx-secondary-materialize\s*\{[\s\S]*?translateY\(12px\)/);
});


test('native model names wrap and floating composer children do not nest glass', async () => {
  assert.match(css, /\._7KE1Ra_modelName\s*\{[^}]*white-space:\s*normal/);
  const coldx = await readFile(new URL('../plugin/client/coldx.css', import.meta.url), 'utf8');
  assert.match(coldx, /\[data-composer-card\]:has\([^}]*\._3e4SsG_menu[^}]*\._7KE1Ra_menu[^}]*backdrop-filter:\s*none/);
});
