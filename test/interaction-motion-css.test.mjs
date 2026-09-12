import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../plugin/client/interaction.css', import.meta.url), 'utf8');

test('decision completion and custom input entrance preserve restrained continuity', () => {
  const choice = css.match(/\.coldx-choice\s*\{([^}]+)\}/)?.[1] ?? '';
  assert.match(choice, /transition:[^;]*opacity\s+\d+ms/i, 'non-selected choices should fade to their completed opacity');
  assert.match(css, /@starting-style\s*\{[\s\S]*?\.coldx-light-input\s*\{[^}]*opacity:\s*0[^}]*transform:\s*translateY\(-?\d+px\)/i,
    'the newly inserted custom input should enter from a tiny offset');
});

test('Reduced Motion keeps only short semantic color and opacity changes in decisions', () => {
  const start = css.indexOf('@media (prefers-reduced-motion: reduce)');
  const reduced = css.slice(start, css.indexOf('@media (prefers-reduced-transparency: reduce)', start));
  assert.doesNotMatch(reduced, /transition:\s*none/i);
  assert.match(reduced, /\.coldx-light-input[^}]*transform:\s*none/i);
  assert.match(reduced, /transition:[^;]*(?:opacity|color)/i);
  assert.doesNotMatch(reduced, /translate|scale|blur/i);
});
