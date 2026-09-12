import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../plugin/client/activity.css', import.meta.url), 'utf8');

test('Activity Lens is a real nonmodal responsive side sheet with a stable utility trigger', () => {
  for (const token of [
    '.cx-activity-lens', '.cx-activity-trigger', '.cx-activity-sheet', 'position: fixed',
    'inset-block:', 'inset-inline-end:', 'max-width:', 'overflow-y: auto',
    'container-type: inline-size', '.cx-activity-grid', '.cx-activity-timeline',
    '.cx-activity-evidence', '.cx-activity-source', '.cx-activity-background',
  ]) assert.ok(css.includes(token), `missing ${token}`);
  assert.doesNotMatch(css, /cx-activity-(?:scrim|backdrop)/i);
});

test('responsive sheet, coarse pointer, and system preference contracts are explicit', () => {
  for (const token of [
    '@container activity-sheet (min-width: 720px)', '@container activity-sheet (max-width: 519px)',
    '@media (max-width: 640px)', '@media (pointer: coarse)', 'min-height: 44px',
    '@media (prefers-reduced-motion: reduce)', '@media (prefers-reduced-transparency: reduce)',
    '@media (prefers-contrast: more)', '@media (forced-colors: active)',
    'backdrop-filter: none', 'Canvas', 'CanvasText', 'Highlight',
  ]) assert.ok(css.includes(token), `missing ${token}`);
});

test('motion stays compositor-safe and a single latest live mark owns the loop', () => {
  assert.match(css, /\.cx-activity-live-mark\[data-latest="true"\][\s\S]*animation:\s*cx-activity-live-ring\s+1\.65s/);
  assert.match(css, /@keyframes cx-activity-live-ring[\s\S]*transform:[\s\S]*opacity:/);
  assert.doesNotMatch(css, /transition:[^;}]*(?:\bwidth\b|\bheight\b|\bfilter\b)/i);
  const keyframes = [...css.matchAll(/@keyframes[^\{]+\{([\s\S]*?)\n\}/g)].map(match => match[1]).join('\n');
  assert.doesNotMatch(keyframes, /\b(?:width|height|filter|backdrop-filter)\s*:/i);
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /animation:\s*none/);
  assert.match(reduced, /scroll-behavior:\s*auto/);
});
