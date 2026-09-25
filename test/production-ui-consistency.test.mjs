import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('production client ships the keyboard, touch, and forced-colors chrome rules', async () => {
  const bundle = await readFile(new URL('../plugin/client/client.js', import.meta.url), 'utf8');
  const consistencySource = await readFile(new URL('../plugin/client/ui-consistency.css', import.meta.url), 'utf8');
  const end = bundle.lastIndexOf('); }');
  const start = bundle.lastIndexOf(', "', end);
  assert.ok(end > start && start >= 0, 'the generated client must contain serialized presentation CSS');
  const css = JSON.parse(bundle.slice(start + 2, end));
  const consistency = css.indexOf('/* Application chrome only.');
  const rebuild = css.indexOf('/* Desktop geometry calibrated');

  assert.ok(consistency >= 0, 'the production client must include ui-consistency.css');
  assert.ok(rebuild > consistency, 'the rebuilt shell must follow compatibility rules for layout precedence');
  assert.ok(css.includes(consistencySource), 'production CSS must contain the full reviewed consistency stylesheet');
  assert.ok(css.includes('.coldx-shell .YDXeBa_sessionRow:focus-within .YDXeBa_time { display: none; }'));
  assert.ok(css.includes('.coldx-shell .YDXeBa_iconButton { width: 44px; height: 44px; }'));
  assert.match(css, /\.coldx-shell \.cx-file-code > \[data-highlighted="true"\] \{ outline: 1px solid Highlight; \}/);
});
