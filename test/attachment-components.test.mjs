import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttachmentComponents } from '../plugin/client/attachment-source.mjs';
import { createFrostComponents } from '../plugin/client/frost-source.mjs';
import vm from 'node:vm';

const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
const attachments = createAttachmentComponents(React, createFrostComponents(React));

test('file references use the native safe @ grammar', () => {
  assert.equal(attachments.formatFileMention({ path: 'src/app.mjs', kind: 'file' }), '@src/app.mjs');
  assert.equal(attachments.formatFileMention({ path: 'docs/My Notes.md', kind: 'file' }), '@"docs/My Notes.md"');
  assert.equal(attachments.formatFileMention({ path: 'src', kind: 'directory' }), '@src/');
  assert.equal(attachments.formatFileMention({ path: 'unsafe"name.md', kind: 'file' }), undefined);
});

test('file references append without copying file contents into the prompt', () => {
  assert.equal(attachments.appendFileMention('', '@README.md'), '@README.md');
  assert.equal(attachments.appendFileMention('检查', '@README.md'), '检查 @README.md');
  assert.equal(attachments.appendFileMention('检查\n', '@README.md'), '检查\n@README.md');
});

function composerFixture() {
  const hooks = [], effects = [];
  let cursor = 0, tree;
  const listeners = new Map();
  const document = {
    body: {}, documentElement: {},
    addEventListener(type, listener) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
  };
  const opener = { isConnected: true, focus() { document.activeElement = this; } };
  document.activeElement = opener;
  const modalCalls = [];
  const dialogElement = {
    open: false,
    showModal() { this.open = true; modalCalls.push('showModal'); document.activeElement = this; },
    close() { this.open = false; modalCalls.push('close'); },
  };
  const windowListeners = new Map();
  const window = {
    innerWidth: 1200, innerHeight: 800,
    addEventListener(type, listener) { (windowListeners.get(type) ?? windowListeners.set(type, new Set()).get(type)).add(listener); },
    removeEventListener(type, listener) { windowListeners.get(type)?.delete(listener); },
  };
  const react = {
    Fragment: 'fragment', createElement: React.createElement,
    useRef(value) { return hooks[cursor++] ??= { current: value }; },
    useState(initial) {
      const i = cursor++; if (!(i in hooks)) hooks[i] = initial;
      return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }];
    },
    useEffect(setup, deps) {
      const i = cursor++, old = hooks[i];
      if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) {
        const next = { deps }; hooks[i] = next; effects.push(() => { old?.cleanup?.(); next.cleanup = setup(); });
      }
    },
  };
  const create = vm.runInNewContext(`(${createAttachmentComponents.toString()})`, { document, window });
  const { ComposerAttachments } = create(react, { Surface: 'surface', Action: 'action' });
  const props = { attachments: [], canAcceptDrop: true, onAddImages() {} };
  const all = node => node && typeof node === 'object' ? [node, ...(node.props?.children ?? []).flat(Infinity).flatMap(all)] : [];
  function render() {
    cursor = 0; tree = ComposerAttachments(props);
    for (const node of all(tree)) if (node.type === 'dialog' && node.props.ref) node.props.ref.current = dialogElement;
    while (effects.length) effects.shift()();
  }
  function dispatch(type, event) { for (const listener of listeners.get(type) ?? []) listener(event); }
  render();
  return {
    document, dispatch, render, props, modalCalls, opener,
    nodes: () => all(tree),
    dropVisible: () => all(tree).some(node => node.props?.className === 'cx-attachment-drop'),
    unmount() { for (const hook of hooks) hook?.cleanup?.(); },
  };
}

test('drag overlay resets when a file drag leaves the browser viewport', () => {
  const f = composerFixture();
  const dataTransfer = { types: ['Files'], files: [] };
  const preventDefault = () => {};
  f.dispatch('dragenter', { dataTransfer, preventDefault });
  f.dispatch('dragenter', { dataTransfer, preventDefault });
  f.render();
  assert.equal(f.dropVisible(), true);

  f.dispatch('dragleave', { dataTransfer, target: f.document.body, clientX: 0, clientY: 400 });
  f.render();
  assert.equal(f.dropVisible(), false);
  f.unmount();
});

test('image preview enters the modal top layer and restores focus when closed', () => {
  const f = composerFixture();
  f.props.attachments = [{ id: 'image-a', previewUrl: 'blob:image-a', file: { name: 'preview.png' } }];
  f.render();
  f.nodes().find(node => node.props.className === 'cx-attachment-preview').props.onClick(); f.render();
  assert.deepEqual(f.modalCalls, ['showModal']);
  assert.equal(f.nodes().find(node => node.type === 'dialog').props['aria-label'], '图片预览');
  f.render();
  assert.deepEqual(f.modalCalls, ['showModal']);
  f.nodes().find(node => node.props.className === 'cx-attachment-lightbox-close').props.onClick(); f.render();
  assert.equal(f.nodes().some(node => node.props.className === 'cx-attachment-lightbox'), false);
  assert.deepEqual(f.modalCalls, ['showModal', 'close']);
  assert.equal(f.document.activeElement, f.opener);
  f.unmount();
});

test('image preview closes on Escape, backdrop, attachment removal, and unmount', () => {
  for (const dismiss of ['escape', 'backdrop', 'remove', 'unmount']) {
    const f = composerFixture();
    f.props.attachments = [{ id: 'image-a', previewUrl: 'blob:image-a' }]; f.render();
    f.nodes().find(node => node.props.className === 'cx-attachment-preview').props.onClick(); f.render();
    const modal = f.nodes().find(node => node.type === 'dialog');
    assert.ok(modal, 'preview uses a native modal dialog');
    if (dismiss === 'escape') {
      let prevented = false;
      modal.props.onCancel({ preventDefault() { prevented = true; } });
      assert.equal(prevented, true);
    } else if (dismiss === 'backdrop') {
      modal.props.onMouseDown({ currentTarget: modal, target: {} }); f.render();
      assert.deepEqual(f.modalCalls, ['showModal'], 'clicking the image keeps the preview open');
      modal.props.onMouseDown({ currentTarget: modal, target: modal });
    } else if (dismiss === 'remove') {
      f.props.attachments = []; f.render();
    } else f.unmount();
    if (dismiss !== 'unmount') { f.render(); f.unmount(); }
    assert.deepEqual(f.modalCalls, ['showModal', 'close'], dismiss);
    assert.equal(f.document.activeElement, f.opener, dismiss);
  }
});

function uploadFixture() {
  const hooks = [], effects = [], requests = [], drafts = [];
  let cursor = 0, alive = true, lateWrites = 0, tree;
  const react = {
    Fragment: 'fragment', createElement: React.createElement,
    useSyncExternalStore: (_subscribe, read) => read(),
    useRef(value) { return hooks[cursor++] ??= { current: value }; },
    useState(initial) {
      const i = cursor++; if (!(i in hooks)) hooks[i] = initial;
      return [hooks[i], value => { if (!alive) lateWrites++; hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }];
    },
    useEffect(setup, deps) {
      const i = cursor++, old = hooks[i];
      if (!old || deps.some((v, j) => !Object.is(v, old.deps[j]))) {
        const next = { deps }; hooks[i] = next; effects.push(() => { old?.cleanup?.(); next.cleanup = setup(); });
      }
    },
  };
  const create = vm.runInNewContext(`(${createAttachmentComponents.toString()})`, { AbortController, setTimeout, clearTimeout });
  const { AttachmentControl } = create(react, { Surface: 'surface', Action: 'action' });
  let props = { sessionId: 'a', draft: '检查', setDraft(value) { drafts.push(value); props = { ...props, draft: value }; },
    uploadFile(file, signal) { return new Promise((resolve, reject) => requests.push({ file, signal, resolve, reject })); } };
  function render() { cursor = 0; tree = AttachmentControl(props); while (effects.length) effects.shift()(); }
  const all = node => node && typeof node === 'object' ? [node, ...(node.props?.children ?? []).flat(Infinity).flatMap(all)] : [];
  const text = node => node && typeof node === 'object' ? (node.props?.children ?? []).flat(Infinity).map(text).join('') : String(node ?? '');
  render();
  return { requests, drafts, render,
    start(files) { return all(tree).find(n => n.props['data-cx-file-upload']).props.onChange({ currentTarget: { files, value: '' } }); },
    edit(draft) { props = { ...props, draft }; render(); },
    switchSession() { props = { ...props, sessionId: 'b', draft: '' }; render(); },
    text: () => text(tree),
    unmount() { for (const hook of hooks) hook?.cleanup?.(); alive = false; },
    lateWrites: () => lateWrites,
  };
}

test('sequential uploads preserve edits made during upload and retain partial success', async () => {
  const f = uploadFixture();
  const pending = f.start([{ name: 'a.txt', size: 1 }, { name: 'b.txt', size: 1 }]);
  f.render(); f.edit('请检查');
  f.requests[0].resolve({ path: '.coldx/uploads/a.txt' });
  await new Promise(resolve => setImmediate(resolve)); f.render();
  assert.equal(f.drafts[0], '请检查 @.coldx/uploads/a.txt');
  f.requests[1].reject(new Error('disk full')); await pending; f.render();
  assert.equal(f.drafts.length, 1);
  f.unmount();
});

test('session switching and unmount abort uploads and discard late receipts', async () => {
  for (const mode of ['switch', 'unmount']) {
    const f = uploadFixture();
    const pending = f.start([{ name: 'notes.txt', size: 1 }]);
    if (mode === 'switch') f.switchSession(); else f.unmount();
    assert.equal(f.requests[0].signal.aborted, true);
    f.requests[0].resolve({ path: '.coldx/uploads/notes.txt' }); await pending;
    assert.equal(f.drafts.length, 0); assert.equal(f.lateWrites(), 0);
    if (mode === 'switch') f.unmount();
  }
});

test('upload batches reject excess files and oversize files before reading bytes', async () => {
  const f = uploadFixture();
  await f.start(Array.from({ length: 9 }, () => ({ size: 1 })));
  await f.start([{ size: 8 * 1024 * 1024 + 1 }]);
  assert.equal(f.requests.length, 0); f.unmount();
});
