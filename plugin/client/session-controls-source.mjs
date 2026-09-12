// Self-contained: the native lazy client serializes this factory with Function#toString.
export function createSessionControls(React, createFrostComponents) {
  const h = React.createElement;
  const { Surface, Action } = createFrostComponents;
  const isNumber = value => typeof value === 'number' && Number.isFinite(value);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const nodeById = id => typeof document === 'undefined' ? null : document.getElementById?.(id) ?? null;

  function effectivePlanState(plan) {
    if (!plan || typeof plan !== 'object') return { known: false, active: false, pending: false, effective: false, label: 'Plan 状态未知', transition: null };
    const active = Boolean(plan.active);
    const pending = Boolean(plan.pending);
    const effective = pending ? !active : active;
    const transition = pending ? (effective ? 'on' : 'off') : null;
    return {
      known: true, active, pending, effective, transition,
      label: pending ? `Plan 待${effective ? '开启' : '关闭'}` : (active ? 'Plan 已开启' : 'Plan 已关闭'),
    };
  }

  function goalPreference(projection) {
    const known = Boolean(projection) && typeof projection === 'object' && typeof projection.goal === 'boolean';
    return { known, selected: known ? projection.goal : false };
  }

  function cacheStats(tokenUsage, contextPressure) {
    const cacheFields = ['uncachedInputTokens', 'cacheReadTokens'];
    const hasCounts = Boolean(tokenUsage) && cacheFields.every(key => isNumber(tokenUsage[key]) && tokenUsage[key] >= 0);
    const denominator = hasCounts ? tokenUsage.uncachedInputTokens + tokenUsage.cacheReadTokens : null;
    const cacheKnown = isNumber(denominator) && denominator > 0;
    const ratio = cacheKnown ? tokenUsage.cacheReadTokens / denominator : null;
    const percent = ratio === null ? null : Math.round(clamp(ratio * 100, 0, 100));
    const numerator = isNumber(contextPressure?.projectedTokens) ? contextPressure.projectedTokens : contextPressure?.pressureTokens;
    const windowSize = contextPressure?.contextWindow;
    const contextKnown = isNumber(numerator) && isNumber(windowSize) && windowSize > 0;
    const contextPercent = contextKnown ? Math.round(clamp((numerator / windowSize) * 100, 0, 100)) : null;
    const cache = {
      known: cacheKnown, ratio, percent, denominator, label: percent === null ? '暂无统计' : `${percent}%`,
      uncachedInputTokens: cacheKnown ? tokenUsage.uncachedInputTokens : null,
      outputTokens: cacheKnown && isNumber(tokenUsage.outputTokens) ? tokenUsage.outputTokens : null,
      cacheReadTokens: cacheKnown ? tokenUsage.cacheReadTokens : null,
      cacheWriteTokens: cacheKnown && isNumber(tokenUsage.cacheWriteTokens) ? tokenUsage.cacheWriteTokens : null,
    };
    const context = { known: contextKnown, percent: contextPercent, label: contextPercent === null ? '暂无统计' : `${contextPercent}%` };
    return { cache, context, cacheRatio: ratio, cachePercent: percent, cacheLabel: cache.label, contextPercent, contextLabel: context.label };
  }

  // DSH creates/reuses a blank Host session when its workspace is selected.
  // Writing a command there publishes a nonblank conversation, so mode choices
  // remain browser draft state until the first real composer admission.
  function createModeCoordinator({ executeCommand, readSession } = {}) {
    const home = Symbol('unbound-composer'), drafts = new Map(), listeners = new Set();
    let disposed = false;
    const keyOf = id => typeof id === 'string' && id ? id : home;
    const blank = snapshot => snapshot?.blank === true || snapshot?.composerPhase === 'blank';
    const publish = (key, value) => { if (value) drafts.set(key,value); else drafts.delete(key); for (const listener of listeners) listener(); };
    const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
    const getSnapshot = (id, snapshot) => drafts.get(keyOf(id)) ?? (blank(snapshot) ? drafts.get(home) : undefined) ?? null;
    const decode = command => command === '/plan' ? ['plan',true] : command === '/plan off' ? ['plan',false]
      : command === '/coldx-goal on' ? ['goal',true] : command === '/coldx-goal off' ? ['goal',false] : null;
    async function run(id, command, snapshot) {
      if (disposed) throw new Error('模式控件已关闭。');
      const change = decode(command);
      if (!change) throw new Error('不支持的模式命令。');
      const key = keyOf(id), state = readSession?.(id) ?? snapshot;
      const draft = getSnapshot(id,state);
      if (draft?.phase === 'sending') throw new Error('首条消息正在提交，请稍候。');
      if (key === home || blank(state) || draft && draft.phase !== 'committed') {
        const next = { ...draft, [change[0]]:change[1], phase:'draft' };
        if (key !== home && !drafts.has(key) && drafts.has(home)) publish(home,null);
        publish(key,next);
        return;
      }
      if (draft) publish(key,null);
      if (typeof executeCommand !== 'function') throw new Error('当前无法切换模式。');
      await executeCommand(id,command);
    }
    async function beforeSend(session, signal) {
      const id = session.sessionId, key = keyOf(id), snapshot = session.getSnapshot();
      let draft = getSnapshot(id,snapshot);
      if (!draft || draft.phase === 'committed') return;
      if (key === home) throw new Error('请先选择工作区。');
      if (draft.phase === 'sending') throw new Error('首条消息正在提交，请稍候。');
      signal?.throwIfAborted();
      if (disposed) throw new Error('模式控件已关闭。');
      if (!drafts.has(key)) { publish(home,null); publish(key,draft); }
      const ticket = {};
      publish(key,{...draft,phase:'sending',ticket});
      const owned = () => !disposed && drafts.get(key)?.ticket === ticket;
      const release = () => { if (owned()) publish(key,{...drafts.get(key),phase:'draft',ticket:undefined}); };
      try {
        for (const mode of ['goal','plan']) {
          if (typeof draft[mode] !== 'boolean') continue;
          const projection = session.projections?.get?.(mode === 'goal' ? 'coldx.codingMode' : 'plan');
          const active = mode === 'goal' ? goalPreference(projection).selected : effectivePlanState(projection).effective;
          const applied = drafts.get(key)?.applied?.[mode] ?? active;
          if (applied === draft[mode]) continue;
          signal?.throwIfAborted();
          if (!owned()) throw new Error('模式控件已关闭。');
          if (typeof executeCommand !== 'function') throw new Error('当前无法切换模式。');
          // Both native commands set an explicit desired state; neither toggles.
          await executeCommand(id,mode === 'goal' ? `/coldx-goal ${draft.goal ? 'on' : 'off'}` : draft.plan ? '/plan' : '/plan off',signal);
          if (!owned()) throw new Error('模式控件已关闭。');
          publish(key,{...drafts.get(key),applied:{...drafts.get(key).applied,[mode]:draft[mode]}});
        }
        signal?.throwIfAborted();
        return {
          commit() { if (owned()) publish(key,{...drafts.get(key),phase:'committed',ticket:undefined}); },
          release,
        };
      } catch (error) { release(); throw error; }
    }
    function useControls(props) {
      const snapshot = props.useSession?.(value => value);
      const id = props.sessionId ?? snapshot?.sessionId;
      const nativeGoal = props.useProjection?.('coldx.codingMode');
      const nativePlan = props.useProjection?.('plan');
      const draft = React.useSyncExternalStore(subscribe,() => getSnapshot(id,snapshot),() => null);
      React.useEffect(() => {
        if (draft?.phase !== 'committed') return;
        const goalReady = typeof draft.goal !== 'boolean' || goalPreference(nativeGoal).selected === draft.goal;
        const planReady = typeof draft.plan !== 'boolean' || effectivePlanState(nativePlan).effective === draft.plan;
        if (goalReady && planReady && drafts.get(keyOf(id)) === draft) publish(keyOf(id),null);
      },[id,draft,nativeGoal,nativePlan]);
      return { ...props, sessionId:id, locked:props.locked || draft?.phase === 'sending',
        executeCommand: command => run(id,command,snapshot),
        useProjection(key) {
          if (key === 'coldx.codingMode') return typeof draft?.goal === 'boolean' ? {goal:draft.goal} : nativeGoal;
          if (key === 'plan') return typeof draft?.plan === 'boolean' ? {active:draft.plan,pending:false} : nativePlan;
          return props.useProjection?.(key);
        },
      };
    }
    return { run, beforeSend, useControls, getSnapshot, subscribe,
      dispose() { disposed=true; drafts.clear(); listeners.clear(); } };
  }

  // Blank native composer surfaces are not themselves focusable. Delegate only
  // their background hits; never replace the textarea, its selection or events.
  function focusComposerSurface(event) {
    if (event.defaultPrevented || event.button !== undefined && event.button !== 0) return false;
    const target = event.target;
    if (!target?.matches?.('[data-composer-card], .uV2eYG_row, .uV2eYG_tools, .uV2eYG_trailing, .uV2eYG_modes, .uV2eYG_scroll, .uV2eYG_grow')) return false;
    const card = target.closest?.('[data-composer-card]');
    const input = card?.querySelector?.('textarea.uV2eYG_input');
    if (!input || input.disabled || input.readOnly) return false;
    event.preventDefault?.();
    input.focus?.({ preventScroll: true });
    return true;
  }

  function shouldHideModeReceipt(node) {
    if (node?.kind !== 'command' || node.outcome?.kind !== 'success') return false;
    const args = typeof node.args === 'string' ? node.args.trim() : node.args === null ? '' : undefined;
    // Older ColdX profiles intentionally omitted command args from the log.
    // Recognize only their exact successful acknowledgement, never an error or arbitrary output.
    if (node.name === 'coldx-goal' && ['Goal mode selected for the next direct human request.', 'Goal mode turned off.'].includes(node.outcome.text)) return true;
    return node.name === 'plan' && (args === '' || args === 'off')
      || node.name === 'coldx-goal' && (args === 'on' || args === 'off');
  }

  function ModeCommandReceipt({ node }) {
    if (shouldHideModeReceipt(node)) return null;
    const failed = node?.outcome?.kind === 'error';
    return h('div', { className: 'cx-mode-command-receipt', role: failed ? 'alert' : 'status', 'data-state': failed ? 'error' : node?.outcome ? 'done' : 'running' },
      h('strong', null, node?.name ? `/${node.name}` : '模式命令'),
      h('p', null, node?.outcome?.text ?? (failed ? '模式切换失败。' : node?.outcome ? '命令已完成。' : '正在切换模式…')));
  }

  function ModeChip({ mode, selected, locked, pending: projectedPending, executeCommand, command, sessionId }) {
    const [leaving, setLeaving] = React.useState(false);
    const [error, setError] = React.useState('');
    const mounted = React.useRef(true);
    const activeRequest = React.useRef(null);
    const owner = React.useRef(sessionId); owner.current = sessionId;
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    React.useEffect(() => { activeRequest.current = null; setLeaving(false); setError(''); }, [sessionId]);
    async function remove() {
      if (activeRequest.current || locked || projectedPending) return;
      const ticket = { sessionId }; activeRequest.current = ticket; setLeaving(true); setError('');
      try {
        if (typeof executeCommand !== 'function') throw new Error('当前无法切换模式。');
        await executeCommand(command);
      } catch (reason) {
        if (mounted.current && owner.current === sessionId && activeRequest.current === ticket) setError(reason?.message || String(reason));
      } finally {
        if (activeRequest.current === ticket) {
          activeRequest.current = null;
          if (mounted.current && owner.current === sessionId) setLeaving(false);
        }
      }
    }
    if (!selected) return null;
    return h('span', { className: 'rS3zOq_wrap cx-coding-mode-chip-wrap' },
      h('button', { type: 'button', className: 'rS3zOq_chip cx-coding-mode-chip', 'data-selected-mode': mode.toLowerCase(),
        'aria-label': `关闭 ${mode} 模式`, disabled: locked || projectedPending || leaving, onClick: remove },
      mode, h('span', { className: 'rS3zOq_close', 'aria-hidden': true }, h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none' },
        h('path', { d: 'M3 3l6 6M9 3L3 9', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' })))),
      error && h('span', { className: 'rS3zOq_error', role: 'alert' }, error));
  }

  function CodingModeChips({ sessionId, useProjection, locked = false, executeCommand }) {
    const goal = goalPreference(useProjection?.('coldx.codingMode'));
    const plan = effectivePlanState(useProjection?.('plan'));
    return h('span', { className: 'cx-coding-mode-chips', 'aria-label': '已选择的 Coding mode' },
      h(ModeChip, { mode: 'Plan', selected: plan.effective, pending: plan.pending, locked, executeCommand, sessionId, command: '/plan off' }),
      h(ModeChip, { mode: 'Goal', selected: goal.selected, locked, executeCommand, sessionId, command: '/coldx-goal off' }));
  }

  function ModeChoice({ id, mode, description, selected, projectedPending, command, pending, run, compact = false }) {
    const blocked = pending || projectedPending;
    const glyph = compact && h('svg', { viewBox:'0 0 20 20', width:18, height:18, fill:'none', stroke:'currentColor', strokeWidth:1.5, strokeLinecap:'round', strokeLinejoin:'round', 'aria-hidden':true },
      mode === 'Goal' ? h('path', {d:'M17 8a7 7 0 1 1-5-5M13 2v5h5M13 7l-3 3M12 10a2 2 0 1 1-2-2'})
        : h('path', {d:'M7 13c0-2-2-2-2-5a5 5 0 0 1 10 0c0 3-2 3-2 5M7 13h6M8 16h4M9 18h2M10 0v1M1 8h1M18 8h1'}));
    return h(Action, {
      id, className: 'cx-coding-mode-choice', role: 'menuitemcheckbox', 'aria-checked': selected,
      'data-mode': mode.toLowerCase(), 'data-pending': projectedPending ? 'true' : undefined,
      disabled: compact ? false : blocked, 'aria-disabled': compact && blocked ? true : undefined, onClick: () => { if (!blocked) return run(command); },
    }, compact ? glyph : h('span', { className: 'cx-coding-mode-check', 'aria-hidden': true }, selected ? '✓' : ''),
    h('span', { className: 'cx-coding-mode-copy' }, h('span', { className: 'cx-coding-mode-name' }, compact ? (mode === 'Goal' ? '目标' : '计划模式') : mode), h('span', { className: 'cx-coding-mode-description' }, description)),
    compact && h('span', {className:'cx-composer-menu-check', 'aria-hidden':true}, selected ? '✓' : ''),
    projectedPending && h('span', { className: 'cx-coding-mode-pending', 'aria-hidden': true }, '…'));
  }

  function CodingModeControl({ sessionId, useProjection, executeCommand, locked = false, embedded = false }) {
    const goal = goalPreference(useProjection?.('coldx.codingMode'));
    const plan = effectivePlanState(useProjection?.('plan'));
    const cache = cacheStats(useProjection?.('tokenUsage')).cache;
    const [open, setOpen] = React.useState(false);
    const [menuPresent, setMenuPresent] = React.useState(false);
    const [pending, setPending] = React.useState(false);
    const [error, setError] = React.useState('');
    const motion = 'quiet';
    const mounted = React.useRef(true);
    const pendingRef = React.useRef(null);
    const requestEpoch = React.useRef(0);
    const sessionRef = React.useRef(sessionId);
    sessionRef.current = sessionId;
    const menuId = React.useId();
    const triggerId = `${menuId}-trigger`;
    const goalId = `${menuId}-goal`;
    const planId = `${menuId}-plan`;

    React.useEffect(() => {
      mounted.current = true;
      return () => { mounted.current = false; };
    }, []);
    React.useEffect(() => {
      requestEpoch.current += 1;
      pendingRef.current = null;
      setPending(false); setOpen(false); setMenuPresent(false); setError('');
    }, [sessionId]);

    function close(restoreFocus = true) {
      setOpen(false);
      if (restoreFocus) nodeById(triggerId)?.focus?.();
    }

    React.useEffect(() => {
      if (!open) return;
      const preferred = goal.selected ? goalId : (plan.effective && !plan.pending ? planId : goalId);
      nodeById(preferred)?.focus?.();
    }, [open, menuPresent]);

    React.useEffect(() => {
      if (!open || typeof document === 'undefined') return undefined;
      const onKeyDown = event => { if (event.key === 'Escape') { event.preventDefault?.(); close(); } };
      const onPointerDown = event => {
        const target = event.target;
        if (nodeById(menuId)?.contains?.(target) || nodeById(triggerId)?.contains?.(target)) return;
        close(false);
      };
      document.addEventListener('keydown', onKeyDown);
      document.addEventListener('pointerdown', onPointerDown);
      return () => { document.removeEventListener('keydown', onKeyDown); document.removeEventListener('pointerdown', onPointerDown); };
    }, [open]);

    async function run(command) {
      if (pendingRef.current) return;
      const ownerSession = sessionId;
      const ticket = { sessionId: ownerSession, epoch: requestEpoch.current };
      pendingRef.current = ticket;
      setPending(true); setError('');
      try {
        if (typeof executeCommand !== 'function') throw new Error('当前无法切换模式。');
        await executeCommand(command);
        if (mounted.current && sessionRef.current === ownerSession && pendingRef.current === ticket) {
          const ownsFocus = typeof document !== 'undefined' && nodeById(menuId)?.contains?.(document.activeElement);
          if (!embedded) close(Boolean(ownsFocus));
        }
      } catch (reason) {
        if (mounted.current && sessionRef.current === ownerSession && pendingRef.current === ticket) {
          const message = typeof reason === 'string' ? reason : (reason?.message || String(reason));
          setError(message || '命令执行失败。');
        }
      } finally {
        if (pendingRef.current === ticket) {
          pendingRef.current = null;
          if (mounted.current && sessionRef.current === ownerSession) setPending(false);
        }
      }
    }

    const trigger = h(Action, {
      label: 'Coding mode', className: 'cx-coding-mode-trigger', id: triggerId,
      'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-controls': menuId,
      'data-session-id': sessionId, onClick: () => {
        if (open) setOpen(false);
        else { setMenuPresent(true); setOpen(true); }
      },
    }, 'Coding mode');

    function onMenuKeyDown(event) {
      if (event.key === 'Tab') { setOpen(false); return; }
      if (event.key === 'Escape') { event.preventDefault?.(); event.stopPropagation?.(); close(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault?.();
      const candidates = [nodeById(goalId), nodeById(planId)].filter(node => node && !(node.disabled ?? node.props?.disabled));
      if (candidates.length === 0) return;
      const active = typeof document === 'undefined' ? null : document.activeElement;
      const index = Math.max(0, candidates.indexOf(active));
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? candidates.length - 1
        : event.key === 'ArrowDown' ? (index + 1) % candidates.length
        : (index - 1 + candidates.length) % candidates.length;
      candidates[next]?.focus?.();
    }

    if (embedded) return h(React.Fragment, null,
      h(ModeChoice, { id:goalId, mode:'Goal', compact:true, description:'设置要持续追求的目标', selected:goal.selected, command:`/coldx-goal ${goal.selected ? 'off' : 'on'}`, pending:pending || locked, run }),
      h(ModeChoice, { id:planId, mode:'Plan', compact:true, description:plan.effective ? '已开启计划模式' : '开启计划模式', selected:plan.effective, projectedPending:plan.pending, command:plan.effective ? '/plan off' : '/plan', pending:pending || locked, run }),
      error && h('p', {className:'cx-coding-mode-error',role:'alert'}, error));

    return h('div', { className: 'cx-coding-mode-root' },
      h('div', { className: 'cx-coding-mode-bar' },
        trigger,
        cache.known && h('span', { className: 'cx-coding-cache-badge', 'data-cache-badge': 'true', title: '会话累计输入缓存命中率' }, `缓存 ${cache.label}`)),
      menuPresent && h(Surface, {
        material: 'regular', floating: true, className: 'cx-coding-mode-menu',
        id: menuId, role: 'menu', 'aria-label': 'Coding mode', 'data-motion': motion,
        'data-presence': open ? 'open' : 'closed', 'aria-hidden': open ? undefined : true,
        inert: open ? undefined : '',
        onTransitionEnd: event => { if (event.target === event.currentTarget && !open) setMenuPresent(false); },
        onTransitionCancel: event => { if (event.target === event.currentTarget && !open) setMenuPresent(false); },
        onKeyDown: onMenuKeyDown,
      },
      h(ModeChoice, {
        id: goalId, mode: 'Goal', description: '从下一条对话生成目标并持续推进', selected: goal.selected,
        command: `/coldx-goal ${goal.selected ? 'off' : 'on'}`, pending: pending || locked, run,
      }),
      h(ModeChoice, {
        id: planId, mode: 'Plan', description: '先生成计划，经确认后再执行', selected: plan.effective,
        projectedPending: plan.pending, command: plan.effective ? '/plan off' : '/plan', pending: pending || locked, run,
      })),
      error && h('p', { className: 'cx-coding-mode-error', role: 'alert', 'aria-live': 'assertive' }, error));
  }

  return { CodingModeControl, CodingModeChips, ModeCommandReceipt, shouldHideModeReceipt, focusComposerSurface, effectivePlanState, goalPreference, cacheStats, createModeCoordinator };
}
