import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createMotionRuntime } from '../plugin/client/motion-source.mjs';

// This adapter models WAAPI's presentation layer separately from inline styles.
// Cancelling removes that layer immediately, as the browser does.
function fixture({ reduced = false, waapi = true } = {}) {
  const listeners = new Set();
  const media = {
    matches: reduced,
    addEventListener(type, listener) { assert.equal(type, 'change'); listeners.add(listener); },
    removeEventListener(type, listener) { listeners.delete(listener); },
  };
  const animations = [];
  const environment = {
    matchMedia: () => media,
    getComputedStyle(node) {
      return { opacity: '1', transform: 'none', filter: 'none', width: '100px', height: '40px', ...node.style, ...node.presentation };
    },
    requestAnimationFrame() { throw new Error('A WAAPI transition must not own a frame polling loop'); },
  };
  const create = vm.runInNewContext(`(${createMotionRuntime.toString()})`);
  const runtime = create({ environment });
  function element({ hidden = false, style = {}, rect = {} } = {}) {
    const node = {
      hidden, inert: hidden, style: { ...style }, presentation: {}, animations: [],
      child: { draft: 'Unsent iframe input' },
      layout: { left: 0, top: 0, width: 100, height: 40, ...rect },
      getBoundingClientRect() {
        return visualRect(node, environment.getComputedStyle(node).transform);
      },
    };
    if (waapi) node.animate = (frames, options) => {
      const animation = {
        frames: structuredClone(frames), options: structuredClone(options), onfinish: null,
        cancelled: false, finished: Promise.resolve(),
        sample(frame) { node.presentation = { ...frame }; node.current = animation; },
        cancel() {
          this.inlineAtCancel = { ...node.style };
          this.cancelled = true;
          if (node.current === this) { node.presentation = {}; node.current = null; }
        },
        finish() { this.sample(frames.at(-1)); this.onfinish?.(); },
      };
      animation.sample(frames[0]);
      node.animations.push(animation); animations.push(animation);
      return animation;
    };
    return node;
  }
  return {
    runtime, element, animations, listeners, environment,
    setReduced(value) { media.matches = value; for (const listener of listeners) listener({ matches: value }); },
  };
}

function visualRect(node, transform) {
  let x = 0, y = 0, sx = 1, sy = 1;
  if (transform.startsWith('matrix(')) {
    const values = transform.slice(7, -1).split(',').map(Number);
    [sx, , , sy, x, y] = values;
  } else if (transform !== 'none') {
    const translate = transform.match(/translate\(([-.\d]+)px,\s*([-.\d]+)px\)/);
    const scale = transform.match(/scale\(([-.\d]+)(?:,\s*([-.\d]+))?\)/);
    if (translate) { x = Number(translate[1]); y = Number(translate[2]); }
    if (scale) { sx = Number(scale[1]); sy = Number(scale[2] ?? scale[1]); }
  }
  return {
    left: node.layout.left + x, top: node.layout.top + y,
    width: Number.parseFloat(node.style.width ?? node.layout.width) * sx,
    height: Number.parseFloat(node.style.height ?? node.layout.height) * sy,
  };
}

function closeRect(actual, expected) {
  for (const key of ['left', 'top', 'width', 'height']) assert.ok(Math.abs(actual[key] - expected[key]) < 0.001, `${key}: ${actual[key]} vs ${expected[key]}`);
}

test('redirect captures live presentation before cancelling and ignores an obsolete finish', () => {
  const f = fixture(); const node = f.element(); let completions = 0;
  const first = f.runtime.animate(node, { opacity: '1', transform: 'none' }, { from: { opacity: '0', transform: 'scale(.98)' }, onFinish: () => completions++ });
  first.sample({ opacity: '0.43', transform: 'matrix(0.991, 0, 0, 0.991, 0, 4)' });
  const staleFinish = first.onfinish;
  const second = f.runtime.animate(node, { opacity: '0', transform: 'scale(.98)' }, { from: { opacity: '1', transform: 'none' }, onFinish: () => completions++ });
  assert.equal(first.cancelled, true);
  assert.equal(first.inlineAtCancel.opacity, '0.43');
  assert.equal(second.frames[0].opacity, '0.43');
  assert.equal(second.frames[0].transform, 'matrix(0.991, 0, 0, 0.991, 0, 4)');
  staleFinish(); assert.equal(completions, 0);
  second.finish(); assert.equal(completions, 1);
  assert.equal(node.style.opacity, '0');
});

test('rapid page reversal never hides the selected page or replaces mounted content', () => {
  const f = fixture(); const a = f.element(); const b = f.element({ hidden: true });
  const draft = a.child; let exited = 0;
  f.runtime.pages({ from: a, to: b, onExit: () => exited++ });
  const exitingA = a.animations.at(-1); const staleFinish = exitingA.onfinish;
  exitingA.sample({ opacity: '0.7', transform: 'matrix(.995, 0, 0, .995, 0, -2)', filter: 'blur(.4px)' });
  b.animations.at(-1).sample({ opacity: '0.4', transform: 'matrix(.99, 0, 0, .99, 0, 6)', filter: 'blur(1px)' });
  f.runtime.pages({ from: b, to: a });
  assert.equal(a.hidden, false); assert.equal(a.inert, false); assert.equal(b.inert, true);
  assert.equal(a.animations.at(-1).frames[0].opacity, '0.7');
  staleFinish(); assert.equal(a.hidden, false); assert.equal(exited, 0);
  b.animations.at(-1).finish(); assert.equal(b.hidden, true);
  a.animations.at(-1).finish(); assert.equal(a.hidden, false);
  assert.equal(a.child, draft); assert.equal(a.child.draft, 'Unsent iframe input');
});

test('page motion has bounded spring overshoot, monotonic opacity and sharp readable content', () => {
  const f = fixture(); const a = f.element(); const b = f.element({ hidden: true });
  f.runtime.pages({ from: a, to: b, direction: 1 });
  const exit = a.animations.at(-1);
  const enter = b.animations.at(-1);
  assert.ok(exit.options.duration < enter.options.duration);
  const positions = enter.frames.map(frame => visualRect(b, frame.transform));
  assert.ok(positions.some(p => p.top < 0), 'spring crosses its resting point');
  assert.ok(positions.every(p => p.top >= -1 && p.width <= b.layout.width * 1.005), 'no large bounce or text magnification');
  for (let i = 1; i < enter.frames.length; i++) assert.ok(Number(enter.frames[i].opacity) >= Number(enter.frames[i - 1].opacity), 'opacity never bounces with position');
  assert.ok(enter.frames.every(frame => frame.filter === 'none'), 'text must not blur during navigation');
  assert.equal(enter.frames.at(-1).transform, 'none');
  assert.equal(enter.frames.at(-1).filter, 'none');
});

test('keyboard navigation settles every exit immediately; reduced motion substitutes a semantic crossfade', () => {
  const f = fixture(); const a = f.element(); const b = f.element({ hidden: true }); const c = f.element({ hidden: true }); const d = f.element({ hidden: true });
  f.runtime.pages({ from: a, to: b });
  const count = f.animations.length;
  f.runtime.pages({ from: b, to: c, keyboard: true });
  assert.equal(f.animations.length, count);
  assert.equal(a.hidden, true); assert.equal(b.hidden, true); assert.equal(c.hidden, false); assert.equal(c.inert, false);
  assert.ok(f.animations.every(animation => animation.cancelled));
  f.setReduced(true);
  f.runtime.pages({ from: c, to: d });
  const reduced = f.animations.slice(count);
  assert.equal(reduced.length, 2, 'reduced motion keeps a short semantic fade');
  assert.ok(reduced.every(animation => animation.options.duration <= 180));
  assert.ok(reduced.every(animation => animation.frames.every(frame => frame.transform === 'none' && frame.filter === 'none')));
  reduced.forEach(animation => animation.finish());
  assert.equal(c.hidden, true); assert.equal(d.hidden, false); assert.equal(d.inert, false);
  f.runtime.press(d, true);
  assert.equal(d.style.transform, 'none'); assert.equal(f.animations.length, count + 2);
});

test('an OS reduced-motion change finishes pending visuals and disposal removes its listener', () => {
  const f = fixture(); const a = f.element(); const b = f.element({ hidden: true });
  f.runtime.pages({ from: a, to: b });
  f.setReduced(true);
  assert.equal(a.hidden, true); assert.equal(b.hidden, false); assert.equal(b.inert, false);
  assert.ok(f.animations.every(animation => animation.cancelled));
  assert.equal(b.style.filter, 'none'); assert.equal(b.style.transform, 'none');
  f.runtime.dispose(); assert.equal(f.listeners.size, 0);
});

test('a moving selection plate preserves its actual bounds when redirected to another size', () => {
  const f = fixture(); const node = f.element();
  f.runtime.indicator(node, { left: 10, top: 4, width: 80, height: 32 });
  assert.equal(f.animations.length, 0, 'first placement must not fly from the origin');
  f.runtime.indicator(node, { left: 90, top: 4, width: 120, height: 40 });
  node.animations.at(-1).sample({ transform: 'matrix(.8, 0, 0, .9, 40, 4)' });
  const visible = node.getBoundingClientRect();
  f.runtime.indicator(node, { left: 250, top: 8, width: 180, height: 44 });
  closeRect(visualRect(node, node.animations.at(-1).frames[0].transform), visible);
  node.animations.at(-1).finish();
  closeRect(node.getBoundingClientRect(), { left: 250, top: 8, width: 180, height: 44 });
});

test('a pointer-driven selection plate crosses its target and springs back', () => {
  const f = fixture(); const node = f.element();
  f.runtime.indicator(node, { left: 10, top: 4, width: 80, height: 32 });
  f.runtime.indicator(node, { left: 90, top: 8, width: 120, height: 40 });
  const animation = node.animations.at(-1);
  const bounds = animation.frames.map(frame => visualRect(node, frame.transform));
  assert.ok(bounds.some(rect => rect.left > 90), 'a small natural overshoot');
  assert.ok(bounds.every(rect => rect.left < 94), 'no exaggerated target crossing');
  assert.equal(animation.frames.at(-1).transform, 'translate(90px, 8px) scale(1, 1)');
});

test('FLIP maps the captured visible rectangle through a layout change, including an interruption', () => {
  const f = fixture(); const node = f.element({ rect: { left: 10, top: 20, width: 100, height: 40 } });
  const old = node.getBoundingClientRect(); node.layout = { left: 150, top: 80, width: 120, height: 50 };
  f.runtime.flip(node, old);
  closeRect(node.getBoundingClientRect(), old);
  node.animations.at(-1).sample({ transform: 'matrix(.9, 0, 0, .9, -50, -20)' });
  const moving = node.getBoundingClientRect(); node.layout = { left: 220, top: 100, width: 140, height: 60 };
  f.runtime.flip(node, moving);
  closeRect(node.getBoundingClientRect(), moving);
  node.animations.at(-1).finish(); closeRect(node.getBoundingClientRect(), node.layout);
});

test('stop freezes the visible frame and dispose restores owned styles without late callbacks', () => {
  const f = fixture(); const node = f.element({ style: { opacity: '.85', color: 'red' } }); let completed = false;
  const animation = f.runtime.animate(node, { opacity: '0', filter: 'blur(2px)' }, { onFinish: () => { completed = true; } });
  animation.sample({ opacity: '0.51', filter: 'blur(1px)' }); const stale = animation.onfinish;
  f.runtime.stop(node);
  assert.equal(node.style.opacity, '0.51'); assert.equal(animation.cancelled, true);
  f.runtime.dispose(); f.runtime.dispose(); stale();
  assert.equal(completed, false); assert.equal(node.style.opacity, '.85'); assert.equal(node.style.filter, ''); assert.equal(node.style.color, 'red');
  f.runtime.animate(node, { opacity: '0' }); assert.equal(node.style.opacity, '.85');
});

test('missing WAAPI uses an immediately usable final state', () => {
  const f = fixture({ waapi: false }); const a = f.element(); const b = f.element({ hidden: true });
  f.runtime.pages({ from: a, to: b });
  assert.equal(a.hidden, true); assert.equal(b.hidden, false); assert.equal(b.inert, false);
  assert.equal(b.style.opacity, '1'); assert.equal(f.animations.length, 0);
});

test('pointer release reverses from the live pressed pose without delaying application input', () => {
  const f = fixture(); const node = f.element();
  f.runtime.press(node, true);
  node.animations.at(-1).sample({ transform: 'matrix(.985, 0, 0, .985, 0, 0)' });
  f.runtime.press(node, false);
  assert.equal(node.animations.at(-1).frames[0].transform, 'matrix(.985, 0, 0, .985, 0, 0)');
  node.child.draft = 'Input accepted while moving';
  assert.equal(node.child.draft, 'Input accepted while moving');
});

test('routine control feedback is brief and never rebounds beyond its resting size', () => {
  const f = fixture(); const node = f.element();
  f.runtime.press(node, true);
  node.animations.at(-1).finish();
  assert.equal(node.style.transform, 'scale(.98)');
  f.runtime.press(node, false);
  const release = node.animations.at(-1);
  const scales = release.frames.map(frame => visualRect(node, frame.transform).width / node.layout.width);
  assert.ok(scales.every(scale => scale >= .98 && scale <= 1), 'routine controls must not inflate on release');
  assert.ok(release.options.duration <= 180, 'routine feedback must settle promptly');
  assert.equal(release.frames.at(-1).transform, 'none');
});

test('untouched and duplicate releases never start a rebound', () => {
  const f = fixture(); const node = f.element();
  f.runtime.press(node, false);
  assert.equal(f.animations.length, 0);
  f.runtime.press(node, true);
  f.runtime.press(node, true);
  assert.equal(f.animations.length, 1, 'repeated pointerdown is idempotent');
  f.runtime.press(node, false);
  const release = node.animations.at(-1);
  f.runtime.press(node, false, { cancelled: true });
  assert.equal(f.animations.length, 2, 'lostpointercapture after pointerup does not restart release');
  assert.equal(release.cancelled, false);
});

test('cancelled press settles without a release overshoot', () => {
  const f = fixture(); const node = f.element();
  f.runtime.press(node, true); node.animations.at(-1).finish();
  f.runtime.press(node, false, { cancelled: true });
  assert.ok(node.animations.at(-1).frames.every(frame => visualRect(node, frame.transform).width <= node.layout.width));
});

test('spring retarget preserves momentum as well as the visible position', () => {
  const f = fixture(); const node = f.element();
  f.runtime.indicator(node, { left: 0, top: 0, width: 100, height: 40 });
  f.runtime.indicator(node, { left: 160, top: 0, width: 100, height: 40 });
  const forward = node.animations.at(-1);
  const mid = forward.frames[8];
  forward.currentTime = mid.offset * forward.options.duration;
  forward.sample(mid);
  const visible = node.getBoundingClientRect();
  f.runtime.indicator(node, { left: 0, top: 0, width: 100, height: 40 });
  const reverse = node.animations.at(-1);
  closeRect(visualRect(node, reverse.frames[0].transform), visible);
  assert.ok(visualRect(node, reverse.frames[1].transform).left > visible.left, 'the moving plate slows before reversing, instead of hitting a velocity wall');
  reverse.finish();
  closeRect(node.getBoundingClientRect(), { left: 0, top: 0, width: 100, height: 40 });
});

test('turning on reduced motion releases a held press even after the press animation finished', () => {
  const f = fixture(); const node = f.element();
  f.runtime.press(node, true); node.animations.at(-1).finish();
  f.setReduced(true);
  assert.equal(node.style.transform, 'none');
});

test('dispose cancels active transitions, restores visibility and ignores their saved callbacks', () => {
  const f = fixture(); const a = f.element(); const b = f.element({ hidden: true }); let exits = 0;
  f.runtime.pages({ from: a, to: b, onExit: () => exits++ });
  const callbacks = f.animations.map(animation => animation.onfinish);
  f.runtime.dispose();
  assert.ok(f.animations.every(animation => animation.cancelled));
  assert.equal(a.hidden, false); assert.equal(a.inert, false); assert.equal(b.hidden, true); assert.equal(b.inert, true);
  assert.equal(a.style.zIndex, ''); assert.equal(b.style.transform, '');
  for (const callback of callbacks) callback();
  assert.equal(exits, 0); assert.equal(b.hidden, true);
});


test('Frost materialize and confirm recipes interrupt, fade accessibly and release original styles', () => {
  for (const reduced of [false, true]) {
    const f = fixture({ reduced }); const node = f.element({ style: { boxShadow: '0 1px 2px black' } });
    assert.equal(typeof f.runtime.materialize, 'function'); assert.equal(typeof f.runtime.confirm, 'function');
    const entrance = f.runtime.materialize(node);
    assert.ok(entrance.options.duration <= 180);
    assert.ok(entrance.frames.every(frame => frame.transform === 'none'), 'routine surfaces fade without spatial overshoot');
    entrance.sample({ opacity: '.6', transform: 'none' });
    const bloom = f.runtime.confirm(node);
    assert.equal(entrance.cancelled, true); assert.equal(bloom.frames[0].opacity, '.6');
    assert.equal(bloom.options.duration, reduced ? 160 : 420);
    assert.ok(bloom.frames.some(frame => frame.boxShadow?.includes('120, 200, 230')));
    if (!reduced) assert.ok(bloom.frames.some(frame => frame.transform === 'scale(1.025)'));
    for (const animation of [entrance, bloom]) for (const frame of animation.frames) {
      assert.equal(frame.filter, undefined); if (reduced) assert.equal(frame.transform, 'none');
    }
    bloom.finish(); assert.equal(node.style.boxShadow, '0 1px 2px black');
    f.runtime.release(node); assert.equal(node.style.transform, ''); assert.equal(node.style.boxShadow, '0 1px 2px black');
    f.runtime.dispose(); assert.equal(f.listeners.size, 0);
  }
});
