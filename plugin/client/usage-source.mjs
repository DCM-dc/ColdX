// Self-contained factory serialized into the existing native DSH React client.
export function createUsageComponents(React, rpc) {
  const h = React.createElement, listeners = new Set();
  let balanceSnapshot = null, balancePending = null, balanceTimer = null, balanceController = null, balanceEpoch = 0;
  const formatCount = value => typeof value !== 'number' || !Number.isFinite(value) ? '—' : value >= 1e8 ? `${+(value / 1e8).toFixed(2)}亿` : value >= 1e4 ? `${+(value / 1e4).toFixed(2)}万` : new Intl.NumberFormat('zh-CN').format(value);
  const formatDuration = value => typeof value !== 'number' || !Number.isFinite(value) ? '—' : value < 60000 ? `${Math.floor(value / 1000)} 秒` : value < 3600000 ? `${Math.floor(value / 60000)} 分` : `${Math.floor(value / 3600000)} 小时 ${Math.floor(value / 60000) % 60} 分`;
  const shift = (date, offset) => new Date(Date.parse(date + 'T12:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
  const monday = date => shift(date, -((new Date(date + 'T12:00:00Z').getUTCDay() + 6) % 7));
  const localDate = (time, timeZone) => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(time);
    return ['year', 'month', 'day'].map(type => parts.find(row => row.type === type).value).join('-');
  };
  function buildHeatmap(days, today, mode = 'day') {
    const start = monday(shift(today, -364)), byDay = new Map(days.map(day => [day.date, day]));
    let cumulative = days.filter(day => day.date < start).reduce((sum, day) => sum + day.totalTokens, 0), weekly = null;
    const rows = [];
    for (let date = start; date <= today; date = shift(date, 1)) {
      const day = byDay.get(date), value = day?.totalTokens ?? 0, missing = day?.missingSteps ?? 0;
      cumulative += value;
      if (mode === 'week') {
        const week = monday(date);
        if (!weekly || weekly.date !== week) { weekly = { date: week, end: date, value: 0, missing: 0 }; rows.push(weekly); }
        weekly.end = date; weekly.value += value; weekly.missing += missing;
      } else rows.push({ date, value: mode === 'cumulative' ? cumulative : value, missing });
    }
    return rows;
  }
  const publishBalance = value => { balanceSnapshot = value; for (const listener of listeners) listener(value); };
  async function loadBalance(refresh = false) {
    if (balancePending) return balancePending;
    const controller = new AbortController(), epoch = balanceEpoch; balanceController = controller;
    const pending = rpc('balance', { refresh }, controller.signal).then(value => { if (epoch === balanceEpoch && !controller.signal.aborted) publishBalance(value); return value; }, error => {
      if (!controller.signal.aborted && epoch === balanceEpoch) publishBalance({ status: 'error', balances: balanceSnapshot?.balances ?? [], stale: Boolean(balanceSnapshot?.checkedAt), checkedAt: balanceSnapshot?.checkedAt ?? null, alert: null, message: '余额暂时无法查询，请稍后重试。' });
    }).finally(() => { if (balancePending === pending) { balancePending = null; balanceController = null; } });
    balancePending = pending; return pending;
  }
  function useBalance() {
    const [value, setValue] = React.useState(balanceSnapshot);
    React.useEffect(() => {
      listeners.add(setValue); setValue(balanceSnapshot);
      if (!balanceTimer) { loadBalance(); balanceTimer = setInterval(() => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') loadBalance(); }, 300000); }
      return () => { listeners.delete(setValue); if (!listeners.size) { clearInterval(balanceTimer); balanceTimer = null; balanceEpoch++; balanceController?.abort(); balancePending = null; } };
    }, []);
    return value;
  }
  function Icon({ kind = 'chart', size = 18 }) {
    const path = { chart: 'M4 19V5m0 14h16M8 15v-4m4 4V7m4 8v-6', close: 'm6 6 12 12M18 6 6 18', refresh: 'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 11.5-1L20 9M4 15l2.5 3A7 7 0 0 0 18 17', wallet: 'M4 7h16v12H4V5l12-2v4m0 5h4v4h-4Z' };
    return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: path[kind] }));
  }
  function BalanceCard() {
    const value = useBalance(), [busy, setBusy] = React.useState(false), alive = React.useRef(false);
    React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    async function refresh() { setBusy(true); try { await loadBalance(true); } finally { if (alive.current) setBusy(false); } }
    return h('section', { className: 'cx-usage-balance', 'aria-labelledby': 'cx-usage-balance-title' },
      h('div', { className: 'cx-usage-section-heading' }, h('h3', { id: 'cx-usage-balance-title' }, h(Icon, { kind: 'wallet' }), 'DeepSeek 上游余额'), h('button', { type: 'button', className: 'cx-usage-text-button', onClick: refresh, disabled: busy || value?.status === 'disabled', 'aria-label': '刷新上游余额' }, h(Icon, { kind: 'refresh', size: 15 }), busy ? '查询中' : '刷新')),
      !value ? h('p', { className: 'cx-usage-muted', role: 'status' }, '正在查询…') : h(React.Fragment, null,
        value.balances?.length > 0 && h('div', { className: 'cx-usage-balances' }, value.balances.map(row => h('div', { key: row.currency, className: 'cx-usage-money', 'data-low': !value.stale && row.low }, h('span', null, row.currency), h('strong', null, row.total), h('small', null, `赠金 ${row.granted} · 充值 ${row.toppedUp}`)))),
        value.alert && h('p', { className: 'cx-usage-warning', role: 'status' }, value.alert === 'empty' ? '上游余额不足，后续模型请求可能无法继续。' : '余额低于提醒阈值，请及时补充。'),
        value.message && h('p', { className: 'cx-usage-muted' }, value.message),
        h('p', { className: 'cx-usage-footnote' }, value.stale ? '以下为上次结果，当前余额待确认。 ' : '', value.checkedAt ? `更新于 ${new Date(value.checkedAt).toLocaleString()}` : '暂无可确认的余额', value.origin ? ` · ${value.origin}` : ''),
      ));
  }
  function Heatmap({ data }) {
    const [mode, setMode] = React.useState('day'), [selected, setSelected] = React.useState(null), grid = React.useRef(null);
    const today = localDate(data.generatedAt, data.timeZone), cells = buildHeatmap(data.days, today, mode), peak = Math.max(1, ...cells.map(row => row.value));
    const active = cells.find(row => row.date === selected) ?? cells.at(-1);
    // Keep the selected date visible on narrow screens without scrolling the dialog vertically.
    (React.useLayoutEffect ?? React.useEffect)(() => {
      const rail = grid.current?.parentElement; if (!rail) return;
      const reveal = () => {
        const target = grid.current?.querySelector('[aria-pressed="true"]'); if (!target) return;
        const cell = target.getBoundingClientRect(), frame = rail.getBoundingClientRect();
        if (cell.right > frame.right) rail.scrollLeft += cell.right - frame.right + 4;
        else if (cell.left < frame.left) rail.scrollLeft -= frame.left - cell.left + 4;
      };
      reveal(); const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(reveal) : null; observer?.observe(rail);
      return () => observer?.disconnect();
    }, [mode]);
    const label = row => `${row.date}${row.end ? ' 至 ' + row.end : ''}：${row.value.toLocaleString('zh-CN')} Token${row.missing ? `，${row.missing} 次调用未返回用量` : ''}${mode === 'cumulative' ? '，截至当日累计' : ''}`;
    function move(event, index) {
      const step = mode === 'week' ? 1 : 7, delta = { ArrowRight: step, ArrowLeft: -step, ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (delta === undefined && !['Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? cells.length - 1 : Math.max(0, Math.min(cells.length - 1, index + delta));
      setSelected(cells[next].date); grid.current?.querySelector(`[data-cell="${next}"]`)?.focus();
    }
    return h('section', { className: 'cx-usage-activity', 'aria-label': 'Token 活动' },
      h('div', { className: 'cx-usage-section-heading' }, h('h3', null, 'Token 活动'), h('div', { className: 'cx-usage-segment', role: 'group', 'aria-label': '统计方式' }, [['day', '每日'], ['week', '每周'], ['cumulative', '累计']].map(([key, label]) => h('button', { type: 'button', key, 'aria-pressed': mode === key, onClick: () => { setMode(key); setSelected(null); } }, label)))),
      h('div', { className: 'cx-usage-heatmap-scroll' }, h('div', { ref: grid, className: 'cx-usage-heatmap', 'data-mode': mode, style: { '--cx-heat-columns': mode === 'week' ? 13 : Math.ceil(cells.length / 7) }, role: 'group', 'aria-label': '最近一年活动；方向键浏览日期' }, cells.map((row, index) => h('button', { type: 'button', key: row.date, 'data-cell': index, 'data-level': row.value === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(row.value / peak * 4))), 'data-missing': row.missing > 0, tabIndex: active.date === row.date ? 0 : -1, 'aria-label': label(row), title: label(row), 'aria-pressed': active.date === row.date, onClick: () => setSelected(row.date), onFocus: () => setSelected(row.date), onKeyDown: event => move(event, index) })))),
      h('div', { className: 'cx-usage-heatmap-footer' }, h('span', null, `${cells[0]?.date ?? ''} — ${today}`), h('span', { 'aria-hidden': true, className: 'cx-usage-legend' }, '少', [0, 1, 2, 3, 4].map(level => h('i', { key: level, 'data-level': level })), '多')),
      h('output', { className: 'cx-usage-selected', 'aria-live': 'polite' }, active ? label(active) : '暂无记录'));
  }
  function Ranking({ title, rows, empty }) {
    return h('section', { className: 'cx-usage-ranking' }, h('h3', null, title), rows.length ? h('ol', null, rows.slice(0, 6).map(row => h('li', { key: row.name }, h('span', { title: row.name }, row.name), h('span', null, `${row.count.toLocaleString('zh-CN')} 次`)))) : h('p', { className: 'cx-usage-muted' }, empty));
  }
  function Preferences() {
    const [settings, setSettings] = React.useState(null), [busy, setBusy] = React.useState(false), [error, setError] = React.useState(''), controller = React.useRef(null), mounted = React.useRef(false);
    React.useEffect(() => { mounted.current = true; controller.current = new AbortController(); rpc('settings', {}, controller.current.signal).then(value => { if (mounted.current) setSettings(value); }, () => { if (mounted.current) setError('提醒设置暂时无法读取。'); }); return () => { mounted.current = false; controller.current?.abort(); }; }, []);
    async function save(event) {
      event.preventDefault(); if (!settings || busy) return; setBusy(true); setError('');
      try {
        const accepted = await rpc('settings', settings, controller.current.signal); if (!mounted.current) return;
        setSettings(accepted); balanceEpoch++; balanceController?.abort(); balancePending = null; publishBalance(null); await loadBalance(true);
      } catch { if (mounted.current) setError('设置未保存，请输入有效的非负金额并重试。'); }
      finally { if (mounted.current) setBusy(false); }
    }
    return h('details', { className: 'cx-usage-preferences' }, h('summary', null, '余额提醒设置'), error && h('p', { role: 'alert', className: 'cx-usage-warning' }, error), settings && h('form', { onSubmit: save },
      h('label', { className: 'cx-usage-checkbox' }, h('input', { type: 'checkbox', checked: settings.balanceEnabled, onChange: event => setSettings({ ...settings, balanceEnabled: event.target.checked }) }), '自动查询并提醒'),
      ['CNY', 'USD'].map(currency => h('label', { key: currency }, `${currency} 低余额阈值`, h('input', { inputMode: 'decimal', value: settings.thresholds[currency], onChange: event => setSettings({ ...settings, thresholds: { ...settings.thresholds, [currency]: event.target.value } }), maxLength: 37, 'aria-label': `${currency} 低余额阈值` }))),
      h('button', { type: 'submit', className: 'cx-usage-button', disabled: busy }, busy ? '保存中…' : '保存设置')));
  }
  function UsageDialog({ onClose, returnFocus }) {
    const dialog = React.useRef(null), controller = React.useRef(null), alive = React.useRef(false), pending = React.useRef(false);
    const [data, setData] = React.useState(null), [error, setError] = React.useState(''), [busy, setBusy] = React.useState(true);
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    async function load() {
      if (pending.current) return; pending.current = true; controller.current = new AbortController(); setBusy(true);
      try { const value = await rpc('read', { timeZone }, controller.current.signal); if (alive.current) { setData(value); setError(''); } }
      catch { if (alive.current && !controller.current.signal.aborted) setError('用量记录暂时无法加载，请重试。'); }
      finally { pending.current = false; if (alive.current) setBusy(false); }
    }
    (React.useLayoutEffect ?? React.useEffect)(() => { alive.current = true; dialog.current?.showModal(); return () => { alive.current = false; controller.current?.abort(); if (dialog.current?.open) dialog.current.close(); returnFocus?.current?.focus?.({ preventScroll: true }); }; }, []);
    React.useEffect(() => { load(); const timer = setInterval(() => { if (document.visibilityState !== 'hidden') load(); }, 30000); return () => clearInterval(timer); }, []);
    const cards = data ? [[formatCount(data.summary.totalTokens), '累计 Token', '包括已记录的缓存输入与输出'], [formatCount(data.summary.peakDailyTokens), '单日峰值 Token', '按当前时区的自然日统计'], [formatDuration(data.summary.longestSessionMs), '最长活跃会话', '已结束回合的执行时长，排除会话空置时间'], [`${data.summary.currentStreak} 天`, '当前连续天数', '今天或昨天开始的连续使用天数'], [`${data.summary.longestStreak} 天`, '最长连续天数', '本地已记录的最长连续使用天数']] : [];
    const knownEfforts = data?.efforts.reduce((sum, row) => sum + row.count, 0) ?? 0, topEffort = data?.efforts[0], effortLabel = { off: '关闭', low: '低', high: '高', max: '最高' };
    return h('dialog', { ref: dialog, className: 'cx-usage-dialog', 'aria-labelledby': 'cx-usage-title', onCancel: event => { event.preventDefault(); onClose(); }, onClick: event => { if (event.target === dialog.current) { const box = dialog.current.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose(); } } },
      h('header', { className: 'cx-usage-header' }, h('div', null, h('h2', { id: 'cx-usage-title' }, '用量与活动'), h('p', null, '看清每一次工作积累')), h('div', { className: 'cx-usage-header-actions' }, h('button', { type: 'button', className: 'cx-usage-icon-button', onClick: load, disabled: busy, 'aria-label': '刷新用量统计' }, h(Icon, { kind: 'refresh' })), h('button', { type: 'button', className: 'cx-usage-icon-button', onClick: onClose, 'aria-label': '关闭用量与活动', autoFocus: true }, h(Icon, { kind: 'close' })))),
      h('div', { className: 'cx-usage-body', 'aria-busy': busy }, error && h('p', { role: 'alert', className: 'cx-usage-warning' }, error),
        !data ? h('p', { className: 'cx-usage-empty', role: 'status' }, busy ? '正在整理本地会话记录…' : '暂无可读取的用量记录。') : h(React.Fragment, null,
          h('div', { className: 'cx-usage-stats' }, cards.map(([value, label, title]) => h('div', { key: label, title }, h('strong', null, value), h('span', null, label)))),
          !data.coverage.complete && h('p', { className: 'cx-usage-warning', role: 'status' }, `部分记录缺少用量信息：${data.coverage.missingSteps} 次调用${data.coverage.unavailableSessions ? `，${data.coverage.unavailableSessions} 个会话未能读取` : ''}${data.coverage.truncated ? '，历史数量超过本轮扫描上限' : ''}。已知数据仍计入统计。`),
          data.coverage.reportedSteps === 0 && h('p', { className: 'cx-usage-muted' }, '还没有模型返回的 Token 用量，开始一次对话后会在这里显示。'),
          h(Heatmap, { data }),
          h('div', { className: 'cx-usage-columns' }, h('section', { className: 'cx-usage-insights' }, h('h3', null, '活动洞察'), h('dl', null,
            h('div', null, h('dt', null, '输入缓存命中率'), h('dd', null, data.cacheHitRatio == null ? '暂无完整数据' : `${(data.cacheHitRatio * 100).toFixed(1)}%`)),
            h('div', null, h('dt', null, '最常用的推理强度'), h('dd', null, topEffort ? `${effortLabel[topEffort.name] ?? topEffort.name} · ${Math.round(topEffort.count / knownEfforts * 100)}%` : '暂无记录')),
            h('div', null, h('dt', null, '已调用技能'), h('dd', null, data.skills.length)),
            h('div', null, h('dt', null, '技能调用次数'), h('dd', null, data.skills.reduce((sum, row) => sum + row.count, 0))),
            h('div', null, h('dt', null, '聊天总数'), h('dd', null, data.summary.chatCount)),
            h('div', null, h('dt', null, '已记录模型调用'), h('dd', null, data.coverage.reportedSteps)))),
            h(Ranking, { title: '最常用的工具', rows: data.tools, empty: '还没有工具调用记录。' })),
          data.skills.length > 0 && h(Ranking, { title: '最常用的技能', rows: data.skills, empty: '' }),
          h('p', { className: 'cx-usage-footnote' }, `${data.limitations} 时区：${data.timeZone}。工具和技能次数包含失败尝试；推理强度只按已记录配置的调用统计。`),
          data.notice && h('p', { className: 'cx-usage-warning' }, data.notice)),
        h(BalanceCard), h(Preferences)));
  }
  function UsageEntry({ wide = true } = {}) {
    const [open, setOpen] = React.useState(false), trigger = React.useRef(null);
    return h('div', { className: 'cx-usage-entry', 'data-wide': wide }, h('button', { ref: trigger, type: 'button', className: 'cx-usage-trigger', 'aria-label': '用量与活动', 'aria-haspopup': 'dialog', 'aria-expanded': open, title: '用量与活动', onClick: () => setOpen(true) }, h(Icon), wide && h('span', null, '用量与活动')), open && h(UsageDialog, { onClose: () => setOpen(false), returnFocus: trigger }));
  }
  function UsageSettingsRow() { return h('div', { className: 'cx-usage-settings-row' }, h('div', null, h('strong', null, '用量与余额'), h('p', null, 'Token 活动、上游余额和低余额提醒')), h(UsageEntry)); }
  function BalanceNotice() {
    const value = useBalance(), [dismissed, setDismissed] = React.useState(null), [open, setOpen] = React.useState(false), trigger = React.useRef(null);
    const key = value?.status === 'ok' && value.alert ? `${value.origin}:${value.alert}:${value.balances.filter(row => row.low).map(row => row.currency).join(',')}` : null;
    React.useEffect(() => { if (value?.status === 'ok' && !value.alert) setDismissed(null); }, [value?.status, value?.alert]);
    if ((!key || key === dismissed) && !open) return null;
    return h(React.Fragment, null, key && key !== dismissed && h('div', { className: 'cx-balance-notice', role: 'status' }, h(Icon, { kind: 'wallet', size: 15 }), h('span', null, value.alert === 'empty' ? '上游余额不足' : '上游余额较低'), h('button', { type: 'button', ref: trigger, onClick: () => setOpen(true) }, '查看'), h('button', { type: 'button', 'aria-label': '暂时收起余额提醒', onClick: () => setDismissed(key) }, h(Icon, { kind: 'close', size: 13 }))), open && h(UsageDialog, { onClose: () => setOpen(false), returnFocus: trigger }));
  }
  return { UsageEntry, UsageSettingsRow, BalanceNotice, UsageDialog, Heatmap, buildHeatmap, formatCount, formatDuration };
}
