import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = () => readFile(new URL('../plugin/client/coldx.css', import.meta.url), 'utf8');

test('Coding mode uses a compact Frost menu and projection tags with expressive transform motion', async () => {
  const source = await css();
  assert.match(source, /\.coldx-shell \.cx-coding-mode-menu \{[^}]*width: min\(320px,[^}]*max-height: min\(240px,/s);
  assert.match(source, /\.coldx-shell \.cx-coding-mode-choice \{[^}]*grid-template-columns:/s);
  assert.match(source, /\.coldx-shell \.cx-coding-mode-tag \{[^}]*transition:[^;}]*opacity 260ms[^;}]*transform 260ms/s);
  assert.match(source, /\.coldx-shell \.cx-coding-mode-menu \{[^}]*transition:[^;}]*opacity 240ms[^;}]*transform 240ms/s);
  assert.match(source, /\.cx-coding-mode-menu\[data-presence="closed"\] \{[^}]*scale\(\.9[4-7]\)[^}]*opacity: 0/s);
  assert.match(source, /\.cx-coding-mode-tag\[data-presence="closed"\] \{[^}]*transform:[^}]*opacity: 0/s);
  assert.match(source, /@starting-style \{[\s\S]*\.cx-coding-mode-menu\[data-presence="open"\][^}]*scale\(\.9[4-7]\)[^}]*opacity: 0[\s\S]*\.cx-coding-mode-tag\[data-presence="open"\][^}]*opacity: 0/);
  assert.doesNotMatch(source, /\.cx-work-mode-/);
  const hoverGate = source.indexOf('@media (hover: hover) and (pointer: fine)');
  assert.ok(hoverGate >= 0);
  assert.doesNotMatch(source.slice(0, hoverGate), /\.cx-coding-mode-choice:hover/);
  assert.doesNotMatch(source, /cx-coding[^}]*transition(?:-property)?:[^;]*(?:width|height|left|top)/s);
});

test('Coding mode keeps pointer targets, narrow layout, and preference fallbacks', async () => {
  const source = await css();
  const pointer = source.match(/@media \(pointer: coarse\) \{([\s\S]*?)(?=\n@media|$)/)?.[1] ?? '';
  assert.match(pointer, /\.cx-coding-mode-choice[^}]*min-height: 48px/s);
  const hover = source.match(/@media \(hover: hover\) and \(pointer: fine\) \{([\s\S]*?)(?=\n@media|$)/)?.[1] ?? '';
  assert.match(hover, /\.cx-coding-mode-choice:hover/);
  assert.match(source, /@media \(max-width: 640px\) \{[^}]*\.cx-coding-mode-menu[^}]*width: min\(300px, calc\(100vw - 32px\)\)/s);
  assert.match(source, /@media \(prefers-reduced-motion: reduce\) \{[^}]*\.cx-coding-mode-menu[^}]*transition: opacity 140ms ease/s);
  for (const preference of ['prefers-reduced-transparency: reduce', 'prefers-contrast: more', 'forced-colors: active']) {
    const start = source.lastIndexOf(`@media (${preference})`);
    assert.ok(start >= 0, preference);
    const tail = source.slice(start, start + 700);
    assert.match(tail, /\.cx-coding-mode-menu/);
    assert.match(tail, /backdrop-filter: none/);
  }
});
