// Self-contained: the native lazy client serializes this factory with Function#toString.
export function createFrostComponents(React, createMotionRuntime) {
  const h = React.createElement;
  const join = (...names) => names.filter(Boolean).join(' ');
  const defaultMotion = createMotionRuntime?.();
  const runtime = motion => (motion === undefined ? defaultMotion : motion)?.current ?? (motion === undefined ? defaultMotion : motion);

  function pressHandlers(motion, disabled = false, caller = {}) {
    const invoke = (name, event, pressed, options) => {
      caller[name]?.(event);
      if (!disabled) runtime(motion)?.press?.(event.currentTarget, pressed, options);
    };
    return {
      onPointerDown(event) {
        caller.onPointerDown?.(event);
        if (disabled || (event.button !== undefined && event.button !== 0)) return;
        event.currentTarget?.setPointerCapture?.(event.pointerId);
        runtime(motion)?.press?.(event.currentTarget, true);
      },
      onPointerUp: event => invoke('onPointerUp', event, false),
      onPointerCancel: event => invoke('onPointerCancel', event, false, { cancelled: true }),
      onLostPointerCapture: event => invoke('onLostPointerCapture', event, false, { cancelled: true }),
      onPointerLeave: event => invoke('onPointerLeave', event, false, { cancelled: true }),
      onBlur: event => invoke('onBlur', event, false, { instant: true }),
    };
  }

  function Surface({ as: Tag = 'div', elementRef, className, material = 'solid', floating, children, ...props }) {
    return h(Tag, { ...props, ref: elementRef, className: join('cx-surface', className), 'data-material': props['data-material'] ?? material,
      'data-floating': props['data-floating'] ?? (floating ? 'true' : undefined) }, children);
  }

  function Action({ label, elementRef, children, className, motion, disabled = false, type = 'button', onPointerDown, onPointerUp, onPointerCancel, onLostPointerCapture, onPointerLeave, onBlur, ...props }) {
    const caller = { onPointerDown, onPointerUp, onPointerCancel, onLostPointerCapture, onPointerLeave, onBlur };
    return h('button', {
      ...props, ref: elementRef, type, disabled, className: join('cx-action', className), 'aria-label': props['aria-label'] ?? label,
      ...pressHandlers(motion, disabled, caller),
    }, children ?? label);
  }

  function Status({ label, children, className, tone = 'neutral', ...props }) {
    return h('p', { ...props, className: join('cx-status', className), 'data-tone': tone, role: props.role ?? 'status', 'aria-live': props['aria-live'] ?? 'polite' }, children ?? label);
  }

  function Field({ label, hint, error, className, children, ...props }) {
    return h('label', { ...props, className: join('cx-field', className), 'data-invalid': Boolean(error) || undefined },
      h('span', { className: 'cx-field-label' }, label),
      hint && h('span', { className: 'cx-field-hint' }, hint),
      children,
      error && h('span', { className: 'cx-field-error', role: 'alert' }, error));
  }

  function Meter({ label, value = 0, min = 0, max = 100, className, children, ...props }) {
    const floor = Number.isFinite(min) ? min : 0;
    const ceiling = Number.isFinite(max) && max >= floor ? max : floor;
    const numeric = Number.isFinite(value) ? value : floor;
    const current = Math.min(ceiling, Math.max(floor, numeric));
    const ratio = ceiling === floor ? 0 : (current - floor) / (ceiling - floor);
    const text = `${Math.round(ratio * 100)}%`;
    return h('div', { ...props, className: join('cx-meter', className), role: 'meter', 'aria-label': props['aria-label'] ?? label,
      'aria-valuemin': floor, 'aria-valuemax': ceiling, 'aria-valuenow': current, 'aria-valuetext': text },
    h('span', { className: 'cx-meter-track', 'aria-hidden': true }, h('span', { className: 'cx-meter-fill', style: { transform: `scaleX(${ratio})` } })),
    h('span', { className: 'cx-meter-value' }, children ?? text));
  }

  function Disclosure({ label, children, className, ...props }) {
    return h('details', { ...props, className: join('cx-disclosure', className) }, h('summary', null, label), children);
  }

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    defaultMotion?.dispose?.();
  }
  return { Surface, Action, Status, Field, Meter, Disclosure, pressHandlers, dispose };
}
