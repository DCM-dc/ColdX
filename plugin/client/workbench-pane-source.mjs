// One owner for the native conversation's right-hand work area. Serialized by DSH.
export function createWorkbenchPane(React) {
  const h = React.createElement;
  const states = new Map(), listeners = new Set(), returnTargets = new Map();
  let fileController;
  const motionInputs = new Map();
  const empty = Object.freeze({ active: null, activeDocument: null, documents: Object.freeze([]) });
  const views = [['timeline', '进度'], ['evidence', '成果'], ['files', '文件'], ['browser', '浏览器'], ['desktop', '电脑']];
  const get = sessionId => states.get(sessionId) ?? empty;
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  const update = (sessionId, change) => {
    const previous = get(sessionId);
    if (Object.entries(change).every(([key, value]) => previous[key] === value)) return;
    states.set(sessionId, { ...previous, ...change }); for (const listener of listeners) listener();
  };
  function rememberFocus(sessionId, origin) {
    if (get(sessionId).active === null) {
      const target = origin ?? (typeof document === 'object' ? document.activeElement : null);
      returnTargets.set(sessionId, target);
      motionInputs.set(sessionId, target?.matches?.(':focus-visible') ? 'instant' : 'pointer');
    } else motionInputs.set(sessionId, 'instant'); // Switching views never slides the reading area again.
  }
  function open(sessionId, active, origin) {
    if (typeof sessionId !== 'string' || !views.some(([id]) => id === active)) return false;
    rememberFocus(sessionId, origin);
    update(sessionId, { active, activeDocument: null }); return true;
  }
  function openDocument(sessionId, path, origin) {
    if (typeof sessionId !== 'string' || typeof path !== 'string' || !path || path === '.') return false;
    rememberFocus(sessionId, origin);
    const current = get(sessionId), documents = current.documents.includes(path) ? current.documents : [...current.documents, path].slice(-12);
    update(sessionId, { active: 'files', activeDocument: path, documents });
    return true;
  }
  function selectDocument(sessionId, path) {
    if (!get(sessionId).documents.includes(path)) return false;
    if (fileController?.open) return fileController.open(sessionId, path);
    return openDocument(sessionId, path);
  }
  function closeDocument(sessionId, path, { prefer } = {}) {
    const current = get(sessionId), index = current.documents.indexOf(path);
    if (index < 0) return null;
    const documents = current.documents.filter(item => item !== path);
    const neighbor = prefer === null ? null : documents.includes(prefer) ? prefer : documents[Math.max(0, index - 1)] ?? null;
    update(sessionId, { documents, activeDocument: current.activeDocument === path ? neighbor : current.activeDocument });
    return neighbor;
  }
  function close(sessionId, expected) {
    if (expected && get(sessionId).active !== expected) return false;
    update(sessionId, { active: null, activeDocument: null }); return true;
  }
  const usePane = sessionId => React.useSyncExternalStore(subscribe, () => get(sessionId), () => empty);
  const restoreFocus = (sessionId, fallback) => {
    const target = returnTargets.get(sessionId); returnTargets.delete(sessionId);
    (target?.isConnected !== false && target?.focus ? target : fallback)?.focus?.({ preventScroll: true });
  };

  function Tabs({ sessionId }) {
    const state = usePane(sessionId), rail = React.useRef(null), focusAfterClose = React.useRef(false);
    React.useLayoutEffect(() => {
      if (!focusAfterClose.current) return;
      focusAfterClose.current = false;
      rail.current?.querySelector?.('[role="tab"][aria-selected="true"]')?.focus?.({ preventScroll: true });
    }, [state.active, state.activeDocument, state.documents]);
    React.useEffect(() => {
      const node = rail.current, selected = node?.querySelector?.('[role="tab"][aria-selected="true"]');
      if (!node?.closest?.('.cx-workbench-panel')?.open || !selected) return;
      const visible = selected.closest?.('.cx-workbench-document-tab') ?? selected;
      const bounds = node.getBoundingClientRect(), tab = visible.getBoundingClientRect();
      if (tab.left < bounds.left) node.scrollLeft += tab.left - bounds.left;
      else if (tab.right > bounds.right) node.scrollLeft += tab.right - bounds.right;
    }, [state.active, state.activeDocument, state.documents]);
    const entries = views.flatMap(([id, label]) => id === 'files'
      ? [{id,label}, ...state.documents.map(path => ({path,label:path.replaceAll('\\','/').split('/').at(-1) || path}))]
      : [{id,label}]);
    const selected = entry => entry.path ? state.active === 'files' && state.activeDocument === entry.path
      : state.active === entry.id && (entry.id !== 'files' || state.activeDocument === null);
    const select = (entry, keyboard) => {
      if (entry.path) selectDocument(sessionId, entry.path);
      else if (entry.id === 'files' && fileController?.open) fileController.open(sessionId, '.');
      else open(sessionId, entry.id);
      if (keyboard) queueMicrotask(() => {
        // A view change may replace the rail. Resolve the live rail in this panel.
        const root = rail.current?.closest?.('.wSkVaW_root');
        const tabs = root?.querySelectorAll?.('.cx-workbench-panel[data-open="true"] [role="tab"]');
        [...(tabs ?? [])].find(tab => entry.path ? tab.dataset.workbenchFile === entry.path : tab.dataset.workbenchTab === entry.id)?.focus?.();
      });
    };
    return h('nav', { className: 'cx-workbench-tabs', ref: rail, role: 'tablist', 'aria-label': '工作面板内容', onKeyDown: event => {
      const current = Math.max(0, entries.findIndex(selected));
      const index = event.key === 'ArrowRight' ? (current + 1) % entries.length : event.key === 'ArrowLeft' ? (current + entries.length - 1) % entries.length : event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : -1;
      if (index < 0) return;
      event.preventDefault(); select(entries[index], true);
    } }, entries.map(entry => entry.path
      ? h('div', { key:`file:${entry.path}`, className:'cx-workbench-document-tab', role:'presentation', 'data-active':selected(entry) },
        h('button', { type:'button', role:'tab', 'data-workbench-file':entry.path, title:entry.path,
          'aria-label':`文件：${entry.path}`, 'aria-selected':selected(entry), tabIndex:selected(entry) ? 0 : -1,
          onClick:event=>select(entry,event.detail===0) }, entry.label),
        h('button', { type:'button', className:'cx-workbench-document-close', 'aria-label':`关闭 ${entry.path}`,
          onClick:event=>{
            // Only a focused keyboard activation needs a new tab stop. Pointer
            // closes and external/programmatic closes preserve the user's focus.
            if (event.detail === 0 && typeof document === 'object' && document.activeElement === event.currentTarget) focusAfterClose.current = true;
            const closed = fileController?.close ? fileController.close(sessionId,entry.path) : closeDocument(sessionId,entry.path);
            if (closed === false) focusAfterClose.current = false;
          } }, '×'))
      : h('button', { key:entry.id, type:'button', role:'tab', 'data-workbench-tab':entry.id,
        'aria-selected':selected(entry), tabIndex:selected(entry) ? 0 : -1, onClick:event=>select(entry,event.detail===0) }, entry.label)));
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
  return { get, subscribe, open, close, openDocument, selectDocument, closeDocument,
    bindFiles: controller => { fileController = controller; }, usePane, Tabs, usePanel };
}
