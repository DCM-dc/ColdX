// Native choices and task-specific previews share the same owner-bound carrier.
// Self-contained: the native lazy client serializes this factory.
export function createInteractionComponents(React, buildPageDocument, createInteractionSubmitter, readTheme, createMotionRuntime, subscribeTheme) {
  const h = React.createElement;
  const chevron = h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true }, h('path', { d: 'm9 5 7 7-7 7', strokeLinecap: 'round', strokeLinejoin: 'round' }));
  const check = h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': true }, h('path', { d: 'm5 12 4 4L19 6', strokeLinecap: 'round', strokeLinejoin: 'round' }));
  const closed = page => page.status === 'cancelled' || page.status === 'interrupted';
  const ready = (questions, answers) => questions.every(q => answers[q.id]?.selected.length || answers[q.id]?.custom.trim());
  const optionKey = option => option.id ?? option.label;

  function useMotion() {
    const motion = React.useRef(null);
    React.useLayoutEffect(() => {
      const runtime = createMotionRuntime?.();
      motion.current = runtime;
      return () => { runtime?.dispose(); motion.current = null; };
    }, []);
    return motion;
  }

  function pressHandlers(motion, disabled) {
    const release = event => motion.current?.press(event.currentTarget, false);
    const cancel = event => motion.current?.press(event.currentTarget, false, { cancelled: true });
    return {
      onPointerDown: event => {
        if (disabled || event.button > 0) return;
        motion.current?.press(event.currentTarget, true);
        event.currentTarget.setPointerCapture?.(event.pointerId);
      },
      onPointerUp: release, onPointerCancel: cancel, onLostPointerCapture: cancel,
    };
  }

  function Preview({ source, label, description, active, frameState, onPanel, onEngage, onHeight }) {
    const frame = React.useRef(null);
    const channel = React.useRef(null);
    if (!channel.current) channel.current = `coldx-preview-${crypto.randomUUID()}`;
    const [loaded, setLoaded] = React.useState(false);
    const live = React.useRef({ active, onEngage, onHeight });
    live.current = { active: active && frameState === 'active', onEngage, onHeight };
    // Projection replay may replace every object. Only source changes are a
    // new document; a new object identity must not reset a user's iframe draft.
    const html = source?.html ?? '', css = source?.css ?? '', script = source?.script ?? '';
    const doc = React.useMemo(() => source ? buildPageDocument({ html, css, script, channel: channel.current, theme: readTheme() }) : '', [Boolean(source), html, css, script]);
    const syncTheme = () => frame.current?.contentWindow?.postMessage({ type: 'coldx:theme', channel: channel.current, theme: readTheme() }, '*');
    React.useEffect(() => {
      const unsubscribe = subscribeTheme?.(syncTheme);
      syncTheme();
      return () => unsubscribe?.();
    }, []);
    React.useEffect(() => {
      const receive = event => {
        const data = event.data;
        if (event.source !== frame.current?.contentWindow || data?.channel !== channel.current) return;
        if (data.type === 'coldx:ready') { syncTheme(); return; }
        if (data.type === 'coldx:engage') { if (live.current.active) live.current.onEngage?.(); return; }
        if (data.type === 'coldx:resize') {
          if (!live.current.active || !Number.isFinite(data.height) || data.height <= 0) return;
          // A 100vh document can echo the viewport with a one-pixel rounding
          // difference. Keep that stable while accepting real content changes.
          const current = frame.current?.clientHeight;
          const height = current > 0 && Math.abs(data.height - current) <= 2 ? current : data.height;
          live.current.onHeight?.(Math.max(180, Math.min(480, Math.ceil(height))));
          return;
        }
        if (data.type !== 'coldx:submit' || typeof data.requestId !== 'string') return;
        event.source.postMessage({ type: 'coldx:result', channel: channel.current, requestId: data.requestId, ok: false, error: '这是效果预览，请使用下方按钮确认选择。' }, '*');
      };
      window.addEventListener('message', receive);
      return () => window.removeEventListener('message', receive);
    }, []);
    return h('div', { className: 'coldx-option-preview', ref: onPanel, hidden: !active, inert: !active, 'data-loaded': !source || loaded },
      source ? h('iframe', { ref: frame, title: `${label} · 效果预览`, srcDoc: doc, sandbox: 'allow-scripts', referrerPolicy: 'no-referrer', inert: !active || frameState !== 'active' ? '' : undefined, 'data-state': frameState, tabIndex: active && frameState === 'active' ? 0 : -1, onLoad: () => { syncTheme(); setLoaded(true); } })
        : h('div', { className: 'coldx-preview-empty' }, h('span', { className: 'coldx-preview-orbit', 'aria-hidden': true }, check), h('strong', null, label), description && h('p', null, description)));
  }

  function PreviewDeck({ options, selectedId, keyboard, onEngage, frameState }) {
    const visited = React.useRef(new Set());
    const panels = React.useRef(new Map());
    const previous = React.useRef(null);
    const [heights, setHeights] = React.useState(() => new Map());
    const motion = useMotion();
    const selected = options.find(option => optionKey(option) === selectedId);
    if (selected) visited.current.add(selectedId);
    React.useLayoutEffect(() => {
      const to = panels.current.get(selectedId);
      const from = panels.current.get(previous.current);
      if (motion.current) motion.current.pages({ from, to, keyboard, instant: previous.current === null });
      else for (const [id, node] of panels.current) { node.hidden = id !== selectedId; node.inert = id !== selectedId; }
      previous.current = selectedId;
      // Keep the previous presentation alive until the next transition takes
      // it over. A selection-change cleanup must not cancel it first.
    }, [selectedId, keyboard]);
    return h('div', { className: 'coldx-preview-stage' },
      h('div', { className: 'coldx-preview-viewport', style: { height: heights.get(selectedId) ?? 240 } }, options.filter(option => visited.current.has(optionKey(option))).map(option => h(Preview, {
        key: optionKey(option), source: option.preview, label: option.label, description: option.description,
        active: optionKey(option) === selectedId, onEngage, frameState,
        onHeight: height => setHeights(current => current.get(optionKey(option)) === height ? current : new Map(current).set(optionKey(option), height)),
        onPanel: node => { if (node) panels.current.set(optionKey(option), node); else panels.current.delete(optionKey(option)); },
      }))),
      frameState !== 'active' && h('div', { className: 'coldx-page-unavailable' }, frameState === 'settled' ? '已确认 · 内容仍可回看' : '交互已结束 · 内容仍可回看'),
      h('div', { className: 'coldx-preview-caption' }, h('span', null, h('i', { 'aria-hidden': true }), selected?.label), h('span', null, '效果预览')));
  }

  function ChoiceList({ question, metadata, data, disabled, keyboard, onChoose, onCommit }) {
    const grid = React.useRef(null);
    const plate = React.useRef(null);
    const buttons = React.useRef(new Map());
    const motion = useMotion();
    const options = question.options ?? [];
    const selection = data.selected[0];
    const live = React.useRef(null);
    live.current = { selection, keyboard };
    function position(instant = false) {
      const button = buttons.current.get(live.current.selection);
      if (!button || !plate.current || question.multiSelect) return;
      motion.current?.indicator(plate.current, { left: button.offsetLeft, top: button.offsetTop, width: button.offsetWidth, height: button.offsetHeight }, { instant, keyboard: live.current.keyboard });
    }
    React.useLayoutEffect(() => { position(); }, [selection, keyboard, options.map(option => option.label).join('\0')]);
    React.useEffect(() => {
      if (!grid.current) return;
      const observer = new ResizeObserver(() => position(true));
      observer.observe(grid.current);
      return () => observer.disconnect();
    }, []);
    const tabLabel = options.some(option => option.label === selection) ? selection : options[0]?.label;
    const onKeys = (event, index) => {
      if (disabled || event.isComposing) return;
      const delta = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
      if (!question.multiSelect && (delta || event.key === 'Home' || event.key === 'End')) {
        event.preventDefault(); event.stopPropagation();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + delta + options.length) % options.length;
        onChoose(options[next].label, { keyboard: true, commit: false });
        buttons.current.get(options[next].label)?.focus();
      } else if (event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault(); event.stopPropagation();
        onChoose(options[index].label, { keyboard: true, commit: false });
      } else if (event.key === 'Enter') {
        event.preventDefault(); event.stopPropagation();
        if (question.multiSelect) onCommit();
        else onChoose(options[index].label, { keyboard: true, commit: true });
      }
    };
    return h('div', { ref: grid, className: 'coldx-choice-grid', 'data-count': options.length, 'data-multiple': Boolean(question.multiSelect), 'data-has-plate': Boolean(createMotionRuntime && selection && !question.multiSelect), role: question.multiSelect ? 'group' : 'radiogroup', 'aria-label': question.question },
      !question.multiSelect && h('span', { ref: plate, className: 'coldx-choice-plate', hidden: !selection, 'aria-hidden': true }),
      options.map((option, index) => {
        const meta = metadata?.options?.find(item => item.label === option.label);
        const selected = data.selected.includes(option.label);
        return h('button', {
          key: option.label, ref: node => { if (node) buttons.current.set(option.label, node); else buttons.current.delete(option.label); },
          className: 'coldx-choice', type: 'button', role: question.multiSelect ? 'checkbox' : 'radio', 'aria-checked': selected, disabled,
          tabIndex: question.multiSelect || option.label === tabLabel ? 0 : -1,
          onClick: event => onChoose(option.label, { keyboard: event.detail === 0 }), onKeyDown: event => onKeys(event, index),
          ...pressHandlers(motion, disabled),
        }, h('span', { className: 'coldx-choice-top' }, h('span', { className: 'coldx-choice-symbol', 'aria-hidden': true }, selected ? check : String(index + 1).padStart(2, '0')), meta?.recommended && h('span', { className: 'coldx-recommended' }, '推荐')),
        h('span', { className: 'coldx-choice-label' }, option.label),
        (option.description || meta?.description) && h('span', { className: 'coldx-choice-caption' }, option.description || meta.description),
        h('span', { className: 'coldx-choice-arrow', 'aria-hidden': true }, chevron));
      }));
  }

  function QuestionFrame({ page, active, inline = false, carrier, sessionId, onPanel, onHeight, onEngage, onContinue }) {
    const metadata = page.metadata;
    const panel = React.useRef(null), body = React.useRef(null), status = React.useRef(null);
    const savedQuestions = React.useRef(null);
    if (carrier?.payload?.questions) savedQuestions.current = carrier.payload.questions;
    const questions = carrier?.payload?.questions ?? savedQuestions.current ?? [{ id: page.questionId, question: metadata?.question ?? page.question ?? page.title, options: metadata?.options ?? [], multiSelect: metadata?.multiSelect }];
    const initial = () => Object.fromEntries(questions.map(q => {
      const withPreview = metadata?.options?.some(option => option.preview);
      const suggested = metadata?.options?.find(option => option.recommended) ?? metadata?.options?.[0];
      return [q.id, { selected: page.status === 'selected' ? metadata?.selectedLabels ?? [] : withPreview && !q.multiSelect && suggested ? [suggested.label] : [], custom: '' }];
    }));
    const [answers, setAnswers] = React.useState(initial);
    const answersRef = React.useRef(answers); answersRef.current = answers;
    const [busy, setBusy] = React.useState(false), [accepted, setAccepted] = React.useState(false), [error, setError] = React.useState('');
    const [customOpen, setCustomOpen] = React.useState({});
    const [previewChoice, setPreviewChoice] = React.useState({});
    const [keyboard, setKeyboard] = React.useState(false);
    const mounted = React.useRef(false), pending = React.useRef(null), acceptedRef = React.useRef(false);
    const submit = React.useMemo(() => createInteractionSubmitter(), []);
    const motion = useMotion();
    const live = React.useRef(null);
    live.current = { page, carrier, questions, metadata, active, onHeight, onEngage, onContinue };
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current = null; }; }, []);
    React.useEffect(() => {
      if (!body.current) return;
      const observer = new ResizeObserver(() => {
        if (!body.current?.offsetHeight) return;
        const chrome = [...(panel.current?.children ?? [])].filter(node => !node.classList.contains('coldx-frame-area')).reduce((sum, node) => sum + node.offsetHeight, 0);
        live.current.onHeight?.(Math.ceil(Math.max(280, Math.min(2400, body.current.offsetHeight)) + chrome));
      });
      observer.observe(body.current);
      return () => observer.disconnect();
    }, [page.pageId]);
    const unavailable = closed(page);
    const settled = !unavailable && (accepted || page.status === 'selected');
    const disabled = busy || settled || unavailable || !carrier;
    const phase = unavailable ? 'closed' : settled ? 'done' : busy ? 'working' : 'waiting';
    const previousPhase = React.useRef(phase);
    const entered = React.useRef(false);
    React.useLayoutEffect(() => {
      if (!entered.current && active && !settled && !unavailable) {
        entered.current = true; motion.current?.materialize(panel.current);
      }
    }, [active]);
    React.useLayoutEffect(() => {
      if (previousPhase.current !== 'done' && phase === 'done' && active) motion.current?.confirm(panel.current);
      if (previousPhase.current !== phase && status.current) motion.current?.animate(status.current,
        { opacity: '1', transform: 'none', filter: 'none' },
        { from: { opacity: '.45', transform: 'none', filter: 'none' }, duration: 180, keyboard, reducedFade: true });
      previousPhase.current = phase;
    }, [phase, keyboard]);

    async function commit(next = answersRef.current) {
      const current = live.current;
      if (!mounted.current || pending.current || acceptedRef.current || closed(current.page) || current.page.status === 'selected' || !current.carrier || !ready(current.questions, next)) return;
      const operation = { pageId: current.page.pageId, carrierKey: current.carrier.key };
      pending.current = operation;
      setBusy(true); setError('');
      const isCurrent = () => mounted.current && pending.current === operation && live.current.page.pageId === operation.pageId && !closed(live.current.page)
        && (!live.current.carrier || live.current.carrier.key === operation.carrierKey);
      try {
        await submit({ carrier: current.carrier, sessionId,
          constraints: current.metadata ? { [current.page.questionId]: { allowCustom: current.metadata.allowCustom } } : {},
          answers: current.questions.map(q => ({ id: q.id, selected: next[q.id]?.selected ?? [], custom: next[q.id]?.custom ?? '' })),
        });
        if (!isCurrent()) return;
        acceptedRef.current = true; setAccepted(true);
        if (live.current.active) live.current.onContinue?.();
      } catch (err) {
        if (isCurrent()) setError(typeof err?.message === 'string' ? err.message : '提交失败，请重试。');
      } finally {
        if (pending.current === operation) { pending.current = null; if (mounted.current) setBusy(false); }
      }
    }

    const choose = (q, label, options = {}) => {
      if (pending.current || acceptedRef.current || disabled) return;
      const before = answersRef.current[q.id] ?? { selected: [], custom: '' };
      const selected = q.multiSelect ? before.selected.includes(label) ? before.selected.filter(value => value !== label) : [...before.selected, label] : [label];
      const next = { ...answersRef.current, [q.id]: { selected, custom: q.multiSelect ? before.custom : '' } };
      answersRef.current = next; setAnswers(next); setKeyboard(Boolean(options.keyboard));
      setPreviewChoice(previous => ({ ...previous, [q.id]: label }));
      live.current.onEngage?.();
      const quick = questions.length === 1 && !q.multiSelect && !metadata?.options?.some(option => option.preview);
      if (options.commit === true || options.commit !== false && quick) void commit(next);
    };
    const quick = questions.length === 1 && !questions[0].multiSelect && questions[0].options?.length && !metadata?.options?.some(option => option.preview) && !customOpen[questions[0].id];
    const visibleError = !settled && !unavailable && error;
    const note = unavailable ? '这次操作已结束。' : settled ? '选择已送达。' : visibleError || (busy ? '正在确认…' : quick ? keyboard ? '按 Enter 确认选择' : '点选即可继续' : metadata?.options?.some(option => option.preview) ? '切换效果，准备好后确认。' : '准备好后继续。');
    const engage = () => { if (live.current.active) live.current.onEngage?.(); };
    return h('div', { className: 'coldx-page-panel coldx-decision-panel', ref: node => { panel.current = node; onPanel?.(node); }, hidden: !active, inert: !active,
      role: inline ? 'group' : 'tabpanel', id: `coldx-panel-${page.pageId}`, 'aria-label': inline ? page.title : undefined,
      'aria-labelledby': inline ? undefined : `coldx-tab-${page.pageId}`, 'data-state': phase,
      onPointerDownCapture: engage, onWheelCapture: engage, onKeyDownCapture: engage, onTouchStartCapture: engage,
    },
      h('div', { className: 'coldx-page-titlebar' }, h('span', { className: 'coldx-context-label' }, '一起决定'),
        h('span', { ref: status, className: 'coldx-state-pill', 'data-state': phase, role: active ? 'status' : undefined }, settled ? check : h('i', { 'aria-hidden': true }), settled ? '已确认' : unavailable ? '已结束' : busy ? '正在确认' : '等待选择')),
      h('div', { className: 'coldx-frame-area coldx-decision-scroll' },
        h('div', { ref: body, className: 'coldx-decision-body' }, questions.map((q, index) => {
          const data = answers[q.id] ?? { selected: [], custom: '' };
          const options = q.options ?? [];
          const previewOptions = metadata?.options ?? [];
          const suggested = previewOptions.find(option => option.recommended) ?? previewOptions[0];
          const preview = previewOptions.find(option => option.label === previewChoice[q.id]) ?? previewOptions.find(option => option.label === data.selected[0]) ?? suggested;
          return h('section', { className: 'coldx-decision', key: q.id, 'aria-label': q.question },
            questions.length > 1 && h('span', { className: 'coldx-step-label' }, `${String(index + 1).padStart(2, '0')} / ${String(questions.length).padStart(2, '0')}`),
            h('h2', { className: 'coldx-decision-title' }, q.question),
            q.detail && h('details', { className: 'coldx-disclosure' }, h('summary', null, '查看细节'), h('p', null, q.detail)),
            previewOptions.some(option => option.preview) && h(PreviewDeck, { frameState: unavailable ? page.status : settled ? 'settled' : 'active', options: previewOptions, selectedId: preview && optionKey(preview), keyboard, onEngage: () => { if (live.current.active) live.current.onEngage?.(); } }),
            options.length > 0 && h(ChoiceList, { question: q, metadata, data, disabled, keyboard, onChoose: (label, choiceOptions) => choose(q, label, choiceOptions), onCommit: () => void commit() }),
            (metadata?.allowCustom !== false || !options.length) && h('div', { className: 'coldx-custom' },
              options.length > 0 && h('button', { className: 'coldx-text-action', type: 'button', disabled, 'aria-expanded': Boolean(customOpen[q.id]), onClick: () => setCustomOpen(previous => ({ ...previous, [q.id]: !previous[q.id] })) }, '我有别的想法', h('span', { 'aria-hidden': true }, customOpen[q.id] ? '−' : '+')),
              (!options.length || customOpen[q.id]) && h('input', { className: 'coldx-light-input', type: 'text', value: data.custom, disabled, placeholder: options.length ? '补充一句…' : '写下你的想法…', 'aria-label': q.question, maxLength: 8000,
                onChange: event => {
                  const next = { ...answersRef.current, [q.id]: { selected: q.multiSelect ? data.selected : [], custom: event.target.value } };
                  answersRef.current = next; setAnswers(next); setError(''); live.current.onEngage?.();
                },
                onKeyDown: event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); setKeyboard(true); void commit(); } },
              })));
        }), !quick && !settled && !unavailable && h('div', { className: 'coldx-decision-action' }, h('button', {
          type: 'button', className: 'coldx-primary-action', disabled: disabled || !ready(questions, answers),
          onClick: event => { setKeyboard(event.detail === 0); void commit(); }, ...pressHandlers(motion, disabled || !ready(questions, answers)),
        }, busy ? '正在确认…' : metadata?.submitLabel || '确认并继续', chevron)))),
      h('div', { className: 'coldx-page-foot', role: active ? 'status' : undefined, 'data-error': Boolean(visibleError), 'data-settled': settled }, h('span', { className: 'coldx-page-dot', 'aria-hidden': true }), note));
  }
  return { QuestionFrame };
}
