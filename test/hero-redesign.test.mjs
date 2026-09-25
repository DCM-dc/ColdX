import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createWorkspaceShell } from '../plugin/client/workspace-shell-source.mjs';

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: 'fragment',
};

function walk(node, visit) {
  if (node == null || typeof node !== 'object') return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

test('new-task hero gives useful guidance without shadow controls or fictitious state', () => {
  const factory = new Function(`return (${createWorkspaceShell.toString()})`)();
  const { Home } = factory(React);
  const tree = Home();
  const nodes = [];
  walk(tree, node => nodes.push(node));
  assert.equal(nodes.filter(node => node.type === 'h1').length, 1);
  assert.equal(nodes.find(node => node.type === 'h1')?.children[0], '今天想完成什么？');
  assert.equal(nodes.filter(node => node.type === 'button' || node.type === 'a').length, 0,
    'examples are guidance; the native composer owns submission and references');
  assert.ok(nodes.some(node => node.props?.className === 'cx-home-flow'));
  assert.ok(nodes.some(node => node.props?.className === 'cx-home-examples'));
  assert.match(JSON.stringify(tree), /目标|成果|工作区/);
  assert.doesNotMatch(JSON.stringify(tree), /正在运行|已完成|一键生成/);
});

test('hero stylesheet has theme aliases, narrow layout and reduced-motion treatment', async () => {
  const css = await readFile(new URL('../plugin/client/hero-redesign.css', import.meta.url), 'utf8');
  assert.match(css, /\.coldx-shell \.cx-workspace-home/);
  assert.match(css, /--dsw-alias-(bg-base|label-primary)/);
  assert.match(css, /max-width:\s*600px/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.doesNotMatch(css, /transition:\s*all|animation-iteration-count:\s*infinite/);
});
