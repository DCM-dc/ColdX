import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../plugin/client/terminal.css', import.meta.url), 'utf8');

test('Terminal is a bounded bottom-left session panel with readable output', () => {
  for (const token of ['.cx-terminal-panel', 'position: fixed', 'inset-inline-start:', 'inset-block-end:', '.cx-terminal-output', 'overflow: auto', 'white-space: pre-wrap', '.cx-terminal-settings']) assert.ok(css.includes(token), token);
  assert.doesNotMatch(css, /content:\s*attr\([^)]*(?:command|output)/i);
});

test('Terminal honors small screens, contrast, and reduced motion', () => {
  for (const token of ['@media (max-width: 760px)', '@media (prefers-reduced-motion: reduce)', '@media (prefers-reduced-transparency: reduce)', '@media (forced-colors: active)', 'min-height: 44px']) assert.ok(css.includes(token), token);
  assert.doesNotMatch(css, /transition:[^;}]*(?:\bwidth\b|\bheight\b|\bfilter\b)/i);
});

test('Terminal uses the shared Frost tokens and stays above the active composer', () => {
  for (const token of ['--cx-sys-text-muted', '--cx-sys-status-danger', '--cx-sys-status-success', '--cx-sys-surface-elevated', 'inset-block-end: max(132px', 'z-index: 6']) assert.ok(css.includes(token), token);
  for (const stale of ['--cx-sys-text-secondary', '--cx-sys-danger', '--cx-sys-success', '--cx-sys-field']) assert.ok(!css.includes(stale), stale);
});
