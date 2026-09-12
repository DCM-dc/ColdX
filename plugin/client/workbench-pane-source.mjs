// One owner for the native conversation's right-hand work area. Serialized by DSH.
export function createWorkbenchPane(React) {
  const h = React.createElement;
  const states = new Map(), listeners = new Set(), returnTargets = new Map();
  const motionInputs = new Map();
  const empty = Object.freeze({ active: null });
  const views = [['timeline', '进度'], ['evidence', '成果'], ['files', '文件']];
  const get = sessionId => states.get(sessionId) ?? empty;
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  const update = (sessionId, active) => {
    if (get(sessionId).active === active) return;
    states.set(sessionId, { active }); for (const listener of listeners) listener();
  };
  function open(sessionId, active, origin) {
    if (typeof sessionId !== 'string' || !views.some(([id]) => id === active)) return false;
    if (get(sessionId).active === null) {
      const target = origin ?? (typeof document === 'object' ? document.activeElement : null);
      returnTargets.set(sessionId, target);
      motionInputs.set(sessionId, target?.matches?.(':focus-visible') ? 'instant' : 'pointer');
    } else motionInputs.set(sessionId, 'instant'); // Switching views never slides the reading area again.
    update(sessionId, active); return true;
  }
  function close(sessionId, expected) {
    if (expected && get(sessionId).active !== expected) return false;
    update(sessionId, null); return true;
  }
  const usePane = sessionId => React.useSyncExternalStore(subscribe, () => get(sessionId), () => empty);
  const restoreFocus = (sessionId, fallback) => {
    const target = returnTargets.get(sessionId); returnTargets.delete(sessionId);
    (target?.isConnected !== false && target?.focus ? target : fallback)?.focus?.({ preventScroll: true });
  };

  function Tabs({ sessionId }) {
    const state = usePane(sessionId), rail = React.useRef(null);
    const select = (id, keyboard) => {
      open(sessionId, id);
      if (keyboard) queueMicrotask(() => {
        // A view change may replace the rail. Resolve the live rail in this panel.
        const root = rail.current?.closest?.('.wSkVaW_root');
        root?.querySelector?.(`.cx-workbench-panel[data-open="true"] [data-workbench-tab="${id}"]`)?.focus?.();
      });
    };
    return h('nav', { className: 'cx-workbench-tabs', ref: rail, role: 'tablist', 'aria-label': '工作面板内容', onKeyDown: event => {
      const current = views.findIndex(([id]) => id === state.active);
      const index = event.key === 'ArrowRight' ? (current + 1) % views.length : event.key === 'ArrowLeft' ? (current + views.length - 1) % views.length : event.key === 'Home' ? 0 : event.key === 'End' ? views.length - 1 : -1;
      if (index < 0) return;
      event.preventDefault(); select(views[index][0], true);
    } }, views.map(([id, label]) => h('button', { key: id, type: 'button', role: 'tab', 'data-workbench-tab': id,
      'aria-selected': state.active === id, tabIndex: state.active === id ? 0 : -1, onClick: event => select(id, event.detail === 0) }, label)));
  }

  function usePanel({ sessionId, panelRef, triggerRef, present, visible, onClose }) {
    const onCloseRef = React.useRef(onClose); onCloseRef.current = onClose;
    const previous = React.useRef({sessionId,visible:false});
    (React.useLayoutEffect ?? React.useEffect)(() => {
      let returnOnClose = previous.current.sessionId === sessionId && previous.current.visible && !visible;
      previous.current = {sessionId,visible};
      const panel = panelRef.current, root = panel?.closest?.('.wSkVaW_root');
      const header = root?.querySelector?.('.wSkVaW_header');
      if (!present || !panel || !root) return;
      panel.dataset.motion = motionInputs.get(sessionId) ?? 'instant';
      const align = () => {
        const rect = root.getBoundingClientRect(), top = Math.max(rect.top, header?.getBoundingClientRect().bottom ?? rect.top);
        const mode = rect.width >= 960 ? 'docked' : 'drawer';
        panel.style.setProperty('--cx-workbench-top', `${top - rect.top}px`);
        panel.style.setProperty('--cx-workbench-viewport-top', `${top}px`);
        panel.dataset.mode = mode;
        if (!visible) {
          if (panel.open) panel.close();
          if (returnOnClose && get(sessionId).active === null) restoreFocus(sessionId, triggerRef?.current);
          returnOnClose = false;
          return;
        }
        const modal = panel.matches?.(':modal') ?? false;
        if (panel.open && modal !== (mode === 'drawer')) panel.close();
        if (!panel.open) {
          const focused = document.activeElement;
          if (mode === 'drawer') panel.showModal();
          else {
            panel.show();
            // Nonmodal inspection must not steal the conversation's typing focus.
            if (focused && !panel.contains(focused)) focused.focus?.({ preventScroll: true });
          }
        }
      };
      align();
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(align) : null;
      observer?.observe(root); if (header) observer?.observe(header);
      const keydown = event => {
        if (!visible || event.defaultPrevented || event.key !== 'Escape' || panel.matches?.(':modal')) return;
        motionInputs.set(sessionId, 'instant'); panel.dataset.motion = 'instant';
        event.preventDefault(); onCloseRef.current?.();
      };
      document.addEventListener('keydown', keydown);
      return () => { observer?.disconnect(); document.removeEventListener('keydown', keydown); if (panel.open) panel.close(); };
    }, [sessionId, present, visible]);
    return {
      onCancel: event => { event.preventDefault(); motionInputs.set(sessionId, 'instant'); if (panelRef.current) panelRef.current.dataset.motion = 'instant'; onCloseRef.current?.(); },
      onPointerDown: event => {
        if (event.target !== event.currentTarget || !event.currentTarget.matches?.(':modal')) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onCloseRef.current?.();
      },
    };
  }
  return { get, subscribe, open, close, usePane, Tabs, usePanel };
}
