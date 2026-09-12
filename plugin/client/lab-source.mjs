// Serialized by the native client build. All data and effects use DSH Connection.
export function createLabComponents(React, createMotionRuntime) {
  const h = React.createElement;
  const icon = (path, props = {}) => h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, ...props }, h('path', { d: path }));
  const paths = { close: 'm6 6 12 12M6 18 18 6', arrow: 'M5 12h14m-6-6 6 6-6 6', check: 'm5 12 4 4L19 6', folder: 'M3 7V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z', file: 'M6 3h8l4 4v14H6V3Zm8 0v5h4M9 12h6M9 16h5', copy: 'M8 8h12v13H8V8ZM16 8V3H3v13h5', stop: 'M6 6h12v12H6z', refresh: 'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2' };
  const bytesLabel = bytes => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;

  function Lab({ ctx, sessionId, onClose }) {
    const [run, setRun] = React.useState(null);
    const [planId, setPlanId] = React.useState('mixed');
    const [overrides, setOverrides] = React.useState({});
    const [picked, setPicked] = React.useState(null);
    const [custom, setCustom] = React.useState('');
    const [phase, setPhase] = React.useState('loading');
    const [error, setError] = React.useState('');
    const [result, setResult] = React.useState(null);
    const [copied, setCopied] = React.useState(false);
    const mounted = React.useRef(false);
    const epoch = React.useRef(0);
    const controllers = React.useRef(new Set());
    const applying = React.useRef(false);
    const activeApply = React.useRef(null);
    const createId = React.useRef(null);
    const lastSubmit = React.useRef(null);
    const motion = React.useRef(null);
    const nodes = React.useRef(new Map());
    const nodeRefs = React.useRef(new Map());
    const prior = React.useRef(new Map());
    const pills = React.useRef(new Map());
    const rail = React.useRef(null);
    const plate = React.useRef(null);
    const keyboard = React.useRef(false);
    const latestPlanId = React.useRef(planId); latestPlanId.current = planId;
    const previewId = React.useId();
    const getMotion = () => motion.current ??= createMotionRuntime();
    function fileRef(id) {
      if (!nodeRefs.current.has(id)) nodeRefs.current.set(id, node => {
        const previous = nodes.current.get(id);
        if (previous && previous !== node) motion.current?.release(previous);
        if (node) nodes.current.set(id, node); else nodes.current.delete(id);
      });
      return nodeRefs.current.get(id);
    }
    if (!createId.current) createId.current = crypto.randomUUID();
    const busy = phase === 'applying';

    async function call(method, request, signal) {
      if (!sessionId || !ctx?.connection?.rpc) throw new Error('当前任务尚未连接，请稍后重试。');
      const response = await ctx.connection.rpc.call('/api', `coldxLab/${method}`, { args: { agentId: sessionId, request } }, signal);
      if (!response?.ok) throw new Error(response?.error?.message || '暂时无法完成操作，请重试。');
      return response.value;
    }
    async function load() {
      const ticket = ++epoch.current;
      const controller = new AbortController(); controllers.current.add(controller);
      applying.current = false;
      setPhase('loading'); setError(''); setRun(null); setResult(null); setOverrides({}); setPicked(null);
      try {
        const value = await call('create', { requestId: createId.current }, controller.signal);
        if (mounted.current && ticket === epoch.current) { setRun(value); setPhase('ready'); }
      } catch (failure) {
        if (mounted.current && ticket === epoch.current) { setError(controller.signal.aborted ? '准备已停止，可以重新打开样例。' : failure.message); setPhase('error'); }
      } finally { controllers.current.delete(controller); }
    }
    React.useEffect(() => {
      mounted.current = true;
      void load();
      return () => {
        mounted.current = false; epoch.current++;
        for (const controller of controllers.current) controller.abort('ColdX lab closed');
        controllers.current.clear(); motion.current?.dispose(); motion.current = null;
      };
    }, [ctx, sessionId]);

    const currentPlan = run?.plans.find(plan => plan.id === planId);
    const entries = currentPlan?.entries.map(entry => ({ ...entry, group: overrides[entry.fileId] ?? entry.group })) ?? [];
    const folders = [];
    for (const entry of entries) {
      const parts = planId === 'mixed' && !Object.hasOwn(overrides, entry.fileId) ? entry.group.split('/') : [entry.group];
      const label = parts[0], subgroup = parts.slice(1).join('/');
      let folder = folders.find(item => item.label === label);
      if (!folder) { folder = { label, files: [], groups: [] }; folders.push(folder); }
      folder.files.push(entry);
      let group = folder.groups.find(item => item.label === subgroup);
      if (!group) { group = { label: subgroup, files: [] }; folder.groups.push(group); }
      group.files.push(entry);
    }
    const subgroupCount = folders.reduce((sum, folder) => sum + folder.groups.filter(group => group.label).length, 0);
    const selectedFile = run?.files.find(file => file.id === picked);
    function capture() { prior.current = new Map([...nodes.current].map(([id, node]) => [id, node.getBoundingClientRect()])); }
    function changePlan(id, byKeyboard = false) {
      if (applying.current || id === planId) return;
      capture(); keyboard.current = byKeyboard; setPlanId(id); setResult(null); setCopied(false);
    }
    function changeGroup(group, byKeyboard = false) {
      if (!picked || applying.current) return;
      if (group !== null && (!group.trim() || group !== group.trim() || group.length > 48 || /[<>:"/\\|?*\x00-\x1f]/.test(group) || /[. ]$/.test(group) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i.test(group))) {
        setError('分组名请使用简短文字，不含斜杠或特殊路径符号。'); return;
      }
      capture(); keyboard.current = byKeyboard; setError(''); setResult(null); setCopied(false);
      setOverrides(previous => { const next = { ...previous }; if (group === null) delete next[picked]; else next[picked] = group; return next; });
    }
    React.useLayoutEffect(() => {
      if (!run) return;
      const runtime = getMotion();
      for (const [id, node] of nodes.current) {
        const old = prior.current.get(id);
        if (old) runtime.flip(node, old, { keyboard: keyboard.current });
      }
      prior.current.clear();
      const pill = pills.current.get(planId);
      if (pill && plate.current && rail.current) {
        runtime.indicator(plate.current, { left: pill.offsetLeft, top: pill.offsetTop, width: pill.offsetWidth, height: pill.offsetHeight }, { keyboard: keyboard.current });
      }
      keyboard.current = false;
    }, [run, planId, overrides]);
    React.useEffect(() => {
      if (!rail.current) return;
      const observer = new ResizeObserver(() => {
        const pill = pills.current.get(latestPlanId.current);
        if (!pill || !plate.current || !rail.current) return;
        getMotion().indicator(plate.current, { left: pill.offsetLeft, top: pill.offsetTop, width: pill.offsetWidth, height: pill.offsetHeight }, { instant: true });
      });
      observer.observe(rail.current);
      return () => observer.disconnect();
    }, [Boolean(run)]);

    async function applyPlan() {
      if (applying.current || !run) return;
      applying.current = true; setPhase('applying'); setError(''); setCopied(false);
      const ticket = epoch.current;
      const ordered = Object.fromEntries(Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b)));
      const key = JSON.stringify({ runId: run.runId, planId, overrides: ordered });
      if (lastSubmit.current?.key !== key) lastSubmit.current = { key, requestId: crypto.randomUUID() };
      const request = { runId: run.runId, requestId: lastSubmit.current.requestId, planId, overrides: ordered };
      const controller = new AbortController(); controllers.current.add(controller); activeApply.current = controller;
      try {
        const version = await call('apply', request, controller.signal);
        if (mounted.current && ticket === epoch.current) {
          setResult(version); setRun(previous => ({ ...previous, versions: [...previous.versions.filter(item => item.versionId !== version.versionId), version] }));
          setPhase('ready'); lastSubmit.current = null;
        }
      } catch (failure) {
        if (mounted.current && ticket === epoch.current) {
          setError(controller.signal.aborted ? '已停止等待。重试会核对同一次操作，不会重复创建版本。' : failure.message);
          setPhase('ready');
        }
      } finally {
        controllers.current.delete(controller);
        if (activeApply.current === controller) activeApply.current = null;
        if (ticket === epoch.current) applying.current = false;
      }
    }
    const pressProps = {
      onPointerDown: event => { if (event.button === 0) getMotion().press(event.currentTarget, true); },
      onPointerUp: event => getMotion().press(event.currentTarget, false),
      onPointerCancel: event => getMotion().press(event.currentTarget, false),
      onPointerLeave: event => getMotion().press(event.currentTarget, false),
      onBlur: event => getMotion().press(event.currentTarget, false, { instant: true }),
    };
    function planKeys(event) {
      const ids = run.plans.map(plan => plan.id), position = ids.indexOf(planId);
      const next = event.key === 'ArrowRight' ? (position + 1) % ids.length : event.key === 'ArrowLeft' ? (position + ids.length - 1) % ids.length : event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : null;
      if (next === null || applying.current) return;
      event.preventDefault(); changePlan(ids[next], true); pills.current.get(ids[next])?.focus();
    }
    const fileList = files => h('div', { className: 'coldx-lab-files' }, files.map(entry => h('div', {
      key: entry.fileId, className: 'coldx-lab-file-wrap', ref: fileRef(entry.fileId),
    }, h('button', {
      type: 'button', className: 'coldx-lab-file', 'aria-pressed': picked === entry.fileId, disabled: busy,
      title: `${entry.group}/${entry.name}`,
      onClick: () => { setPicked(picked === entry.fileId ? null : entry.fileId); setCustom(''); setError(''); },
      ...pressProps,
    },
    h('span', { className: 'coldx-lab-file-icon', 'data-kind': entry.name.split('.').at(-1) }, icon(paths.file)),
    h('span', { className: 'coldx-lab-file-name' }, entry.name),
    h('span', { className: 'coldx-lab-file-size' }, bytesLabel(entry.bytes))))));
    const folderViews = folders.map((folder, index) => h('div', {
      className: 'coldx-lab-folder', key: folder.label, style: { '--coldx-folder-hue': [200, 145, 32, 275][index % 4] },
    },
    h('div', { className: 'coldx-lab-folder-head' },
      h('span', { className: 'coldx-lab-folder-icon' }, icon(paths.folder)),
      h('div', null, h('h2', null, folder.label), h('span', null, `${folder.files.length} 个文件`))),
    folder.groups.map(group => group.label ? h('section', {
      key: group.label, className: 'coldx-lab-subgroup', 'aria-label': `${folder.label}/${group.label}`,
    },
    h('h3', { className: 'coldx-lab-subgroup-label' }, icon(paths.folder), group.label, h('span', null, group.files.length)),
    fileList(group.files)) : h(React.Fragment, { key: 'root' }, fileList(group.files)))));
    const adjustPanel = selectedFile && h('div', { className: 'coldx-lab-adjust', 'aria-label': `调整 ${selectedFile.name} 的分组` },
      h('div', { className: 'coldx-lab-adjust-title' }, icon(paths.file), h('strong', null, selectedFile.name), h('span', null, '放到')),
      h('div', { className: 'coldx-lab-adjust-options' }, [null, '优先处理', '参考资料', '待整理'].map(group => h('button', {
        key: group ?? 'default', type: 'button', className: 'coldx-lab-group', disabled: busy,
        'aria-pressed': group === null ? !Object.hasOwn(overrides, picked) : overrides[picked] === group,
        onClick: event => changeGroup(group, event.detail === 0), ...pressProps,
      }, group ?? '按方案归类')),
      h('form', { className: 'coldx-lab-custom', onSubmit: event => { event.preventDefault(); changeGroup(custom.trim(), true); } },
        h('input', { 'aria-label': '自定义分组名称', placeholder: '自定义分组', maxLength: 48, value: custom, disabled: busy, onChange: event => setCustom(event.target.value) }),
        h('button', { type: 'submit', disabled: busy || !custom.trim(), 'aria-label': '使用自定义分组', ...pressProps }, icon(paths.arrow)))));
    const resultPanel = result && h('div', { className: 'coldx-lab-result', role: 'status' },
      h('span', { className: 'coldx-lab-result-check' }, icon(paths.check)),
      h('div', { className: 'coldx-lab-result-content' }, h('strong', null, `${result.files.length} 个文件已写入，内容核验一致`), h('code', { title: result.outputPath }, result.outputPath)),
      h('button', { type: 'button', className: 'coldx-lab-secondary', onClick: async () => {
        const ticket = epoch.current;
        try { await navigator.clipboard.writeText(result.outputPath); if (mounted.current && ticket === epoch.current) setCopied(true); }
        catch { if (mounted.current && ticket === epoch.current) setError('暂时无法复制，请选择上方路径手动复制。'); }
      }, ...pressProps }, icon(copied ? paths.check : paths.copy), copied ? '已复制' : '复制路径'));
    const footer = h('footer', { className: 'coldx-lab-footer' },
      h('div', { className: 'coldx-lab-footnote' }, h('strong', null, busy ? '正在写入并核验…' : result ? '每一版都单独保存。' : '点文件，可以微调分组。'), h('span', null, '仅使用人工样例文件。')),
      h('div', { className: 'coldx-lab-actions' },
        busy && h('button', { type: 'button', className: 'coldx-lab-secondary', onClick: () => activeApply.current?.abort('用户停止'), ...pressProps }, icon(paths.stop), '停止'),
        h('button', { type: 'button', className: 'coldx-lab-primary', disabled: busy, onClick: () => void applyPlan(), ...pressProps }, busy ? '正在应用' : result ? '再生成一版' : '应用这个方案', icon(paths.arrow))));
    return h('section', { className: 'coldx-lab', 'aria-label': '样例文件交互实验台' },
      h('header', { className: 'coldx-lab-header' },
        h('div', null, h('div', { className: 'coldx-lab-eyebrow' }, h('span', { className: 'coldx-lab-sample-dot' }), '交互实验台 · 样例文件'), h('h1', null, '选一下，看看变化。')),
        onClose && h('button', { className: 'coldx-lab-icon-button', type: 'button', 'aria-label': '关闭样例实验台', onClick: onClose, ...pressProps }, icon(paths.close))),
      !run ? h('div', { className: 'coldx-lab-loading', role: 'status' }, icon(paths.folder, { width: 54, height: 54 }), h('p', null, phase === 'loading' ? '正在准备 12 个样例文件…' : error), phase === 'error' && h('button', { className: 'coldx-lab-secondary', type: 'button', onClick: () => void load(), ...pressProps }, icon(paths.refresh), '重新连接')) :
        h(React.Fragment, null,
          h('div', { className: 'coldx-lab-plan-row' },
            h('div', { className: 'coldx-lab-plans', ref: rail, role: 'tablist', 'aria-label': '整理方式', onKeyDown: planKeys },
              h('span', { ref: plate, className: 'coldx-lab-selection', 'aria-hidden': true }),
              run.plans.map(plan => h('button', { key: plan.id, ref: node => { if (node) pills.current.set(plan.id, node); else pills.current.delete(plan.id); },
                className: 'coldx-lab-plan', role: 'tab', type: 'button', 'aria-selected': planId === plan.id, 'aria-controls': previewId, tabIndex: planId === plan.id ? 0 : -1,
                disabled: busy, onClick: event => changePlan(plan.id, event.detail === 0), ...pressProps,
              }, plan.label, plan.recommended && h('span', { className: 'coldx-lab-recommended' }, '推荐')))),
            h('p', { className: 'coldx-lab-plan-description' }, currentPlan?.description)),
          h('div', { className: 'coldx-lab-preview-bar' },
            h('span', null, icon(paths.folder), result ? '实际整理结果' : '效果预览'),
            h('span', null, `${entries.length} 个样例 · ${folders.length} 个文件夹${subgroupCount ? ` · ${subgroupCount} 个子分组` : ''}`)),
          h('div', { className: 'coldx-lab-preview', id: previewId, role: 'tabpanel', 'aria-label': currentPlan?.label }, folderViews),
          adjustPanel,
          error && h('p', { className: 'coldx-lab-error', role: 'alert' }, error),
          resultPanel,
          footer));
  }
  return { Lab };
}
