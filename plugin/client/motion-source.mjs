// Self-contained: build.mjs can inject this factory with Function#toString.
// One runtime per workbench. It owns visual styles only, never the page tree,
// focus, application state, a timer, or a requestAnimationFrame loop.
export function createMotionRuntime({ environment = globalThis, reducedMotion } = {}) {
  const records = new Map();
  const pageNodes = new Set();
  const media = environment.matchMedia?.('(prefers-reduced-motion: reduce)');
  let disposed = false;
  let activePage = null;
  const rest = { opacity: '1', transform: 'none', filter: 'none' };
  const reduce = () => Boolean(typeof reducedMotion === 'function' ? reducedMotion() : reducedMotion ?? media?.matches);
  // Reduced Motion keeps semantic fades but drops spatial movement. Individual
  // effects opt in with `reducedFade`; press and indicator motion remain still.
  const immediate = options => options.instant || options.keyboard || (reduce() && !options.reducedFade);

  function record(node) {
    if (!records.has(node)) records.set(node, { original: new Map(), animation: null, target: {}, complete: null });
    return records.get(node);
  }

  function write(node, styles) {
    const state = record(node);
    for (const [property, value] of Object.entries(styles)) {
      if (!state.original.has(property)) state.original.set(property, node.style[property] ?? '');
      node.style[property] = value;
    }
  }

  function presentation(node, properties) {
    const view = environment.getComputedStyle?.(node) ?? node.ownerDocument?.defaultView?.getComputedStyle(node) ?? node.style;
    return Object.fromEntries(properties.map(property => [property, view[property] || node.style[property] || rest[property] || '']));
  }

  function easing(node, name, fallback) {
    return environment.getComputedStyle?.(node)?.getPropertyValue?.(name)?.trim() || fallback;
  }

  function detach(state) {
    const animation = state.animation;
    state.animation = null;
    state.spring = null;
    state.complete = null;
    if (animation) {
      animation.onfinish = null;
      animation.oncancel = null;
      animation.cancel();
    }
  }

  // Stop freezes the presentation. Use dispose/release to restore original CSS.
  function stop(node) {
    const state = records.get(node);
    if (!state?.animation) return;
    write(node, presentation(node, Object.keys(state.target)));
    detach(state);
  }

  // `from` applies to a new animation only. On interruption, live computed
  // values take precedence; the old fill is removed only after they are saved.
  function animate(node, targetStyles, options = {}) {
    if (disposed || !node?.style) return null;
    const state = record(node);
    const target = { ...targetStyles };
    const live = presentation(node, [...new Set([...Object.keys(state.target), ...Object.keys(target)])]);
    const start = state.animation ? live : { ...live, ...options.from };
    const velocity = options.velocity ?? springVelocity(state);
    write(node, live);
    detach(state);
    state.target = target;
    state.staticTarget = options.staticTarget;
    const complete = () => {
      if (disposed || state.complete !== complete) return;
      write(node, immediate(options) ? options.staticTarget ?? target : target);
      detach(state);
      options.onFinish?.();
    };
    state.complete = complete;
    if (immediate(options) || !node.animate || options.duration === 0) {
      complete();
      return null;
    }
    write(node, start);
    try {
      // Sample a continuous physical response once; the compositor plays it.
      // Retargeting inherits both the visible pose and the old spring velocity.
      const spring = options.spring ? springTrack(start, target, velocity, options) : null;
      const frames = spring?.frames ?? (typeof options.frames === 'function' ? options.frames(start, target) : [start, target]);
      const animation = node.animate(frames, {
        duration: options.duration ?? 200,
        easing: spring ? 'linear' : options.easing ?? easing(node, '--ds-ease-out', 'cubic-bezier(.23,1,.32,1)'),
        fill: 'both',
      });
      state.animation = animation;
      state.spring = spring;
      animation.onfinish = complete;
      // WAAPI rejects finished on cancellation. Cancellation is normal input.
      animation.finished?.catch(() => {});
      return animation;
    } catch {
      // A missing/unsupported WAAPI property must not block the interaction.
      complete();
      return null;
    }
  }

  function rememberPage(node) {
    if (!node) return;
    const state = record(node);
    if (!state.visibility) state.visibility = { hidden: node.hidden, inert: node.inert };
    pageNodes.add(node);
  }

  // Call in a layout effect after choosing the page, without cancelling the
  // previous effect. Only dispose in the workbench's unmount cleanup.
  function pages({ from = activePage, to, keyboard = false, instant = false, direction = 1, onExit } = {}) {
    if (disposed) return;
    rememberPage(from); rememberPage(to);
    activePage = to ?? null;
    const reduced = reduce();
    const options = { keyboard, instant, reducedFade: reduced };
    if (immediate(options) || !to?.animate) {
      for (const node of pageNodes) {
        animate(node, rest, { instant: true });
        node.hidden = node !== to;
        node.inert = node !== to;
        write(node, { zIndex: node === to ? '1' : '0' });
      }
      if (from && from !== to) onExit?.(from);
      return;
    }
    if (from && from !== to) {
      from.hidden = false;
      from.inert = true;
      write(from, { zIndex: '0' });
      animate(from, { opacity: '0', transform: reduced ? 'none' : `translateY(${-8 * Math.sign(direction || 1)}px) scale(.985)`, filter: 'none' }, {
        duration: reduced ? 120 : 160,
        reducedFade: reduced,
        onFinish() {
          if (activePage === from) return;
          from.hidden = true;
          write(from, rest);
          onExit?.(from);
        },
      });
    }
    if (!to) return;
    to.hidden = false;
    to.inert = false;
    write(to, { zIndex: '1' });
    if (to === from) return;
    animate(to, rest, {
      from: { opacity: '0', transform: reduced ? 'none' : `translateY(${16 * Math.sign(direction || 1)}px) scale(.98)`, filter: 'none' },
      // Content is readable after 160ms; only the sub-pixel spring tail remains.
      duration: reduced ? 160 : 440,
      reducedFade: reduced,
      spring: reduced ? undefined : { response: .3, damping: .8 },
    });
  }

  function validRect(rect) {
    return rect && ['left', 'top', 'width', 'height'].every(key => Number.isFinite(rect[key])) && rect.width > 0 && rect.height > 0;
  }

  const transform = (x, y, sx = 1, sy = 1) => `translate(${x}px, ${y}px) scale(${sx}, ${sy})`;

  // previousRect MUST be getBoundingClientRect() before the layout mutation,
  // including the currently animated presentation. No reparenting/cloning.
  // Apply to a card wrapper, not an iframe's measured viewport height.
  function flip(node, previousRect, options = {}) {
    if (disposed || !node?.style || !validRect(previousRect)) return null;
    stop(node);
    write(node, { transform: 'none', transformOrigin: '0 0' });
    const next = node.getBoundingClientRect();
    if (!validRect(next)) return null;
    return animate(node, { transform: 'none' }, {
      ...options, duration: options.duration ?? 240,
      from: { transform: transform(previousRect.left - next.left, previousRect.top - next.top, previousRect.width / next.width, previousRect.height / next.height) },
    });
  }

  function matrix(value) {
    const Constructor = environment.DOMMatrixReadOnly ?? environment.DOMMatrix;
    if (Constructor) {
      try { const m = new Constructor(value === 'none' ? undefined : value); return { x: m.m41, y: m.m42, sx: m.m11, sy: m.m22, b: m.m12, c: m.m21 }; } catch { /* Translation/scale fallback for environments without DOMMatrix. */ }
    }
    const result = { x: 0, y: 0, sx: 1, sy: 1, b: 0, c: 0 };
    const match = value.match(/^matrix(3d)?\(([^)]+)\)$/);
    if (match) {
      const values = match[2].split(',').map(Number);
      return { x: values[match[1] ? 12 : 4], y: values[match[1] ? 13 : 5], sx: values[0], sy: values[match[1] ? 5 : 3], b: values[1], c: values[match[1] ? 4 : 2] };
    }
    const translate = value.match(/translate\(([-.\d]+)px,\s*([-.\d]+)px\)/);
    const scale = value.match(/scale\(([-.\d]+)(?:,\s*([-.\d]+))?\)/);
    if (translate) { result.x = Number(translate[1]); result.y = Number(translate[2]); }
    const translateX = value.match(/translateX\(([-.\d]+)px\)/);
    const translateY = value.match(/translateY\(([-.\d]+)px\)/);
    if (translateX) result.x = Number(translateX[1]);
    if (translateY) result.y = Number(translateY[1]);
    if (scale) { result.sx = Number(scale[1]); result.sy = Number(scale[2] ?? scale[1]); }
    return result;
  }

  function springVelocity(state) {
    return state?.spring && state.animation ? state.spring.velocity(Number(state.animation.currentTime) || 0) : {};
  }

  function springTrack(start, target, velocity, options) {
    const initial = matrix(start.transform ?? 'none'), end = matrix(target.transform ?? 'none');
    const { response = .3, damping = .8 } = options.spring;
    const omega = 2 * Math.PI / response, decay = damping * omega;
    const frequency = omega * Math.sqrt(Math.max(0, 1 - damping * damping));
    const duration = options.duration ?? 440;
    const keys = ['x', 'y', 'sx', 'sy', 'b', 'c'];
    function sample(key, ms) {
      const t = ms / 1000, displacement = initial[key] - end[key], speed = velocity[key] ?? 0;
      const envelope = Math.exp(-decay * t);
      if (frequency < .00001) {
        const coefficient = speed + omega * displacement;
        const offset = displacement + coefficient * t;
        return { value: end[key] + envelope * offset, velocity: envelope * (coefficient - omega * offset) };
      }
      const coefficient = (speed + decay * displacement) / frequency;
      const cos = Math.cos(frequency * t), sin = Math.sin(frequency * t);
      const offset = displacement * cos + coefficient * sin;
      return { value: end[key] + envelope * offset, velocity: envelope * (-decay * offset + frequency * (coefficient * cos - displacement * sin)) };
    }
    const count = Math.ceil(duration / (1000 / 120));
    const frames = Array.from({ length: count + 1 }, (_, i) => {
      if (i === 0) return { ...start, offset: 0 };
      if (i === count) return { ...target, offset: 1 };
      const ms = duration * i / count;
      const pose = Object.fromEntries(keys.map(key => [key, sample(key, ms).value]));
      const frame = { ...target, offset: i / count, transform: `matrix(${pose.sx}, ${pose.b}, ${pose.c}, ${pose.sy}, ${pose.x}, ${pose.y})` };
      if (target.opacity !== undefined) {
        const progress = 1 - Math.pow(1 - Math.min(1, ms / 160), 3);
        frame.opacity = String(Number(start.opacity) + (Number(target.opacity) - Number(start.opacity)) * progress);
      }
      return frame;
    });
    return { frames, velocity: ms => Object.fromEntries(keys.map(key => [key, sample(key, Math.min(duration, Math.max(0, ms))).velocity])) };
  }

  // A dedicated empty plate: position:absolute; left:0; top:0;
  // pointer-events:none. targetRect is in its container's CSS coordinates.
  // Width/height change once, then transform animates the visual bounds.
  function indicator(node, targetRect, options = {}) {
    if (disposed || !node?.style || !validRect(targetRect)) return null;
    const state = record(node);
    const previous = state.indicatorRect;
    if (previous && !immediate(options) && ['left', 'top', 'width', 'height'].every(key => previous[key] === targetRect[key])) return state.animation;
    const current = matrix(presentation(node, ['transform']).transform);
    const velocity = springVelocity(state);
    for (const key of ['sx', 'b']) if (velocity[key]) velocity[key] *= (previous?.width ?? targetRect.width) / targetRect.width;
    for (const key of ['sy', 'c']) if (velocity[key]) velocity[key] *= (previous?.height ?? targetRect.height) / targetRect.height;
    stop(node);
    write(node, { width: `${targetRect.width}px`, height: `${targetRect.height}px`, transformOrigin: '0 0' });
    state.indicatorRect = { ...targetRect };
    return animate(node, { transform: transform(targetRect.left, targetRect.top) }, {
      ...options, instant: !previous || options.instant, duration: options.duration ?? 440,
      spring: { response: .3, damping: .8 }, velocity,
      from: { transform: transform(current.x, current.y, current.sx * (previous?.width ?? targetRect.width) / targetRect.width, current.sy * (previous?.height ?? targetRect.height) / targetRect.height) },
    });
  }

  // Attach to pointerdown/up/cancel (and lostpointercapture); never delay the
  // click handler. Use a separate wrapper if the card itself is using FLIP.
  function press(node, pressed, options = {}) {
    if (disposed || !node?.style) return null;
    // pointerup is followed by lostpointercapture; neither duplicate releases
    // nor a pointerleave over untouched controls should manufacture a bounce.
    if (!pressed && !records.get(node)?.pressed) return null;
    const state = record(node);
    if (state.pressed === pressed) return state.animation;
    state.pressed = pressed;
    if (state.pressBase === undefined) {
      state.pressInline = node.style.transform ?? '';
      state.pressBase = presentation(node, ['transform']).transform;
    }
    const baseline = state.pressBase;
    const target = pressed && !immediate(options) ? `${baseline === 'none' ? '' : `${baseline} `}scale(.98)` : baseline;
    return animate(node, { transform: target }, {
      ...options, duration: 140, staticTarget: { transform: baseline },
      // Frequent controls give feedback without a decorative release bounce.
      spring: undefined,
      onFinish() {
        if (!state.pressed) {
          // A hover/expanded transition can be mid-frame on pointerdown. That
          // sampled pose is not an authored resting style; return ownership to
          // CSS after release, and sample afresh for the next gesture.
          node.style.transform = state.pressInline;
          delete state.pressBase;
          delete state.pressInline;
          state.staticTarget = undefined;
        }
        options.onFinish?.();
      },
    });
  }

  function materialize(node, options = {}) {
    return animate(node, { opacity: '1', transform: 'none' }, {
      ...options, duration: 160, reducedFade: true,
      from: { opacity: '0', transform: 'none' },
      spring: undefined,
    });
  }

  function confirm(node, options = {}) {
    if (disposed || !node?.style) return null;
    const reduced = reduce();
    const state = record(node);
    const shadow = state.original.get('boxShadow') ?? presentation(node, ['boxShadow']).boxShadow;
    return animate(node, { opacity: '1', transform: 'none', boxShadow: shadow }, {
      ...options, duration: reduced ? 160 : 420, reducedFade: true,
      from: { opacity: '.82', transform: reduced ? 'none' : 'scale(.96)' },
      frames: (start, target) => [
        { ...start, offset: 0 },
        { ...target, transform: reduced ? 'none' : 'scale(1.025)', boxShadow: '0 0 0 4px rgba(120, 200, 230, .28)', offset: .48 },
        { ...target, offset: 1 },
      ],
    });
  }

  function release(node) {
    const state = records.get(node);
    if (!state) return;
    detach(state);
    for (const [property, value] of state.original) node.style[property] = value;
    if (state.visibility) { node.hidden = state.visibility.hidden; node.inert = state.visibility.inert; }
    records.delete(node);
    pageNodes.delete(node);
    if (activePage === node) activePage = null;
  }

  const onPreference = () => {
    if (!reduce()) return;
    for (const [node, state] of records) {
      if (state.complete) state.complete();
      else if (state.staticTarget) write(node, state.staticTarget);
    }
  };
  media?.addEventListener?.('change', onPreference);
  function dispose() {
    if (disposed) return;
    disposed = true;
    media?.removeEventListener?.('change', onPreference);
    for (const node of records.keys()) release(node);
  }
  return { animate, pages, flip, indicator, press, materialize, confirm, stop, release, dispose };
}
