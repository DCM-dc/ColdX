// Self-contained: the native lazy client serializes this factory with Function#toString.
export function createAttachmentComponents(React, createFrostComponents) {
  const h = React.createElement;
  const { Surface, Action } = createFrostComponents;
  const emptyBridge = Object.freeze({ canAddImages: false, onAddImages: null });
  let bridgeSnapshot = emptyBridge;
  const bridgeListeners = new Set();

  function publishBridge(next) {
    if (bridgeSnapshot.canAddImages === next.canAddImages && bridgeSnapshot.onAddImages === next.onAddImages) return;
    bridgeSnapshot = next;
    for (const listener of bridgeListeners) listener();
  }

  function subscribeBridge(listener) {
    bridgeListeners.add(listener);
    return () => bridgeListeners.delete(listener);
  }

  function formatFileMention(candidate) {
    if (!candidate || (candidate.kind !== 'file' && candidate.kind !== 'directory') || typeof candidate.path !== 'string') return undefined;
    const path = candidate.kind === 'directory' ? `${candidate.path.replace(/\/$/, '')}/` : candidate.path;
    if (!path || /[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined;
    if (!/\s/u.test(path)) return `@${path}`;
    return candidate.kind === 'directory' ? `@"${path}` : `@"${path}"`;
  }

  function appendFileMention(draft, mention) {
    const current = typeof draft === 'string' ? draft : '';
    if (!current) return mention;
    return /\s$/u.test(current) ? `${current}${mention}` : `${current} ${mention}`;
  }

  function Glyph({ kind }) {
    const common = { viewBox: '0 0 20 20', width: 18, height: 18, fill: 'none', stroke: 'currentColor', strokeWidth: 1.55, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
    if (kind === 'image') return h('svg', common,
      h('rect', { x: 2.75, y: 3.25, width: 14.5, height: 13.5, rx: 3 }),
      h('circle', { cx: 7, cy: 7.3, r: 1.2 }),
      h('path', { d: 'm4.4 14 3.7-3.6 2.5 2.2 2.1-1.8 2.9 3.2' }));
    if (kind === 'folder') return h('svg', common,
      h('path', { d: 'M2.8 6.2h5l1.5-1.8h2.1c1.1 0 1.7.5 2.1 1.8h3.7v8.7c0 1-.7 1.7-1.7 1.7h-11c-1 0-1.7-.7-1.7-1.7Z' }),
      h('path', { d: 'M2.8 8h14.4' }));
    if (kind === 'back') return h('svg', common, h('path', { d: 'm12.5 4.5-5.5 5.5 5.5 5.5' }));
    if (kind === 'close') return h('svg', common, h('path', { d: 'm5 5 10 10M15 5 5 15' }));
    if (kind === 'plus') return h('svg', common, h('path', { d: 'M10 3v14M3 10h14' }));
    if (kind === 'commands') return h('svg', common, h('rect', { x: 2.5, y: 3, width: 15, height: 14, rx: 3 }), h('path', { d: 'm6 7 3 3-3 3m5 0h3' }));
    return h('svg', common,
      h('path', { d: 'm7.1 10.8 5.1-5.1a3 3 0 0 1 4.2 4.2l-6.8 6.8a4.5 4.5 0 0 1-6.3-6.4l6.5-6.5' }),
      h('path', { d: 'm6.2 13.8 6.4-6.4' }));
  }

  function pluginLabel(name) {
    return name.split('-').map(word => /^(pdf|ui|ux|ai|api|html|css|svg)$/i.test(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  }
  function PluginGlyph({name}) {
    const file = /document|pdf|spreadsheet|presentation/.test(name);
    const color = /pdf/.test(name) ? '#db737f' : /spreadsheet/.test(name) ? '#76a474' : /presentation/.test(name) ? '#ddb361' : /document/.test(name) ? '#6999dc' : '#a187de';
    return h('svg',{viewBox:'0 0 18 18',width:18,height:18,fill:'none','aria-hidden':true,style:{color}},
      file ? h(React.Fragment,null,h('path',{d:'M4 1h7l4 4v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1Z',fill:'currentColor'}),h('path',{d:'M11 1v4h4M6 9h6M6 12h6',stroke:'white',strokeWidth:1,opacity:.85}))
        : h(React.Fragment,null,h('path',{d:'m9 1 7 4v8l-7 4-7-4V5Z',fill:'currentColor',opacity:.5}),h('path',{d:'m9 1 7 4-7 4-7-4Z',fill:'#ebbf67'}),h('path',{d:'M9 9v8l7-4V5Z',fill:'currentColor'})));
  }

  function ComposerAttachments({ attachments = [], canAcceptDrop = false, onAddImages, onRemoveImage, dropLimits }) {
    const [preview, setPreview] = React.useState(null);
    const [dragActive, setDragActive] = React.useState(false);
    const dragDepth = React.useRef(0);
    const previewDialog = React.useRef(null);

    function closePreview() {
      if (previewDialog.current?.open) previewDialog.current.close();
      setPreview(null);
    }

    React.useEffect(() => {
      const owner = { canAddImages: Boolean(canAcceptDrop && onAddImages), onAddImages: canAcceptDrop ? onAddImages : null };
      publishBridge(owner);
      return () => { if (bridgeSnapshot === owner) publishBridge(emptyBridge); };
    }, [canAcceptDrop, onAddImages]);

    React.useEffect(() => {
      if (preview && !attachments.some(attachment => attachment.id === preview.id)) closePreview();
    }, [attachments, preview]);

    React.useEffect(() => {
      if (typeof document === 'undefined' || typeof window === 'undefined') return undefined;
      const transfer = event => event.dataTransfer?.types?.includes?.('Files') ? event.dataTransfer : null;
      const reset = () => { dragDepth.current = 0; setDragActive(false); };
      const enter = event => {
        if (!transfer(event)) return;
        event.preventDefault(); dragDepth.current += 1; setDragActive(true);
      };
      const over = event => {
        const data = transfer(event); if (!data) return;
        event.preventDefault(); data.dropEffect = canAcceptDrop ? 'copy' : 'none';
      };
      const leave = event => {
        if (!transfer(event)) return;
        const leftViewport = event.clientX <= 0 || event.clientY <= 0
          || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight;
        if ((event.target === document.documentElement || event.target === document.body) && leftViewport) {
          reset(); return;
        }
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragActive(false);
      };
      const drop = event => {
        const data = transfer(event); if (!data) return;
        event.preventDefault(); reset();
        if (canAcceptDrop) onAddImages?.([...data.files]);
      };
      document.addEventListener('dragenter', enter); document.addEventListener('dragover', over);
      document.addEventListener('dragleave', leave); document.addEventListener('drop', drop);
      window.addEventListener('dragend', reset);
      return () => {
        document.removeEventListener('dragenter', enter); document.removeEventListener('dragover', over);
        document.removeEventListener('dragleave', leave); document.removeEventListener('drop', drop);
        window.removeEventListener('dragend', reset);
      };
    }, [canAcceptDrop, onAddImages]);

    React.useEffect(() => {
      if (!preview || typeof document === 'undefined') return undefined;
      const dialog = previewDialog.current;
      if (!dialog) return undefined;
      const opener = document.activeElement;
      // The top layer escapes the composer's backdrop-filter containing block
      // and gives the preview native focus containment and Escape handling.
      dialog.showModal();
      return () => {
        if (dialog.open) dialog.close();
        if (opener?.isConnected) opener.focus?.({ preventScroll: true });
      };
    }, [preview]);

    return h(React.Fragment, null,
      h('span', { className: 'cx-attachment-bridge', 'data-cx-attachment-bridge': 'true', 'data-can-add': canAcceptDrop ? 'true' : 'false', 'aria-hidden': true }),
      dragActive && h('div', { className: 'cx-attachment-drop', 'data-disabled': canAcceptDrop ? undefined : 'true', role: 'status' },
        h('span', { className: 'cx-attachment-drop-icon' }, h(Glyph, { kind: 'image' })),
        h('strong', null, canAcceptDrop ? '松开以添加图片' : '当前暂不能添加图片'),
        dropLimits && h('span', null, `最多 ${dropLimits.count} 张 · 单张 ${dropLimits.size}`)),
      attachments.length > 0 && h('div', { className: 'cx-attachment-rail', 'aria-label': '待发送图片' },
        attachments.map(attachment => h('figure', { className: 'cx-attachment-tile', key: attachment.id },
          h('button', { type: 'button', className: 'cx-attachment-preview', onClick: () => setPreview(attachment), 'aria-label': `预览 ${attachment.file?.name || '图片'}` },
            h('img', { src: attachment.previewUrl, alt: attachment.file?.name || '待发送图片' })),
          h('button', { type: 'button', className: 'cx-attachment-remove', onClick: () => onRemoveImage?.(attachment.id), 'aria-label': `移除 ${attachment.file?.name || '图片'}` }, h(Glyph, { kind: 'close' }))))),
      preview && h('dialog', { ref: previewDialog, className: 'cx-attachment-lightbox', 'aria-label': '图片预览', onCancel: event => { event.preventDefault(); closePreview(); }, onMouseDown: event => { if (event.target === event.currentTarget) closePreview(); } },
        h('button', { type: 'button', className: 'cx-attachment-lightbox-close', onClick: closePreview, 'aria-label': '关闭预览' }, h(Glyph, { kind: 'close' })),
        h('img', { src: preview.previewUrl, alt: preview.file?.name || '图片原图' })));
  }

  function AttachmentControl({ sessionId, draft = '', setDraft, listFiles, uploadFile, unified = false, modeItems, locked = false, commandsAvailable = false, openCommands, loadPlugins, onPickPlugin, getInputSelection }) {
    const imageBridge = React.useSyncExternalStore(subscribeBridge, () => bridgeSnapshot, () => emptyBridge);
    const [open, setOpen] = React.useState(false);
    const [keyboardMotion, setKeyboardMotion] = React.useState(false);
    const [present, setPresent] = React.useState(false);
    const [screen, setScreen] = React.useState('home');
    const [query, setQuery] = React.useState('');
    const [files, setFiles] = React.useState([]);
    const [status, setStatus] = React.useState('idle');
    const [error, setError] = React.useState('');
    const [uploadStatus, setUploadStatus] = React.useState('');
    const [uploading, setUploading] = React.useState(false);
    const inputRef = React.useRef(null);
    const fileInputRef = React.useRef(null);
    const uploadRef = React.useRef(null);
    const latest = React.useRef({ sessionId, draft, setDraft });
    latest.current = { sessionId, draft, setDraft };
    const rootRef = React.useRef(null);
    const triggerRef = React.useRef(null);
    const menuRef = React.useRef(null);
    const [placement, setPlacement] = React.useState({ side: 'above', height: 400, origin: 24 });
    const [plugins, setPlugins] = React.useState([]);
    const [pluginStatus, setPluginStatus] = React.useState('idle');
    const [pluginError, setPluginError] = React.useState('');
    const [catalogRevision, setCatalogRevision] = React.useState(0);
    const [pickingPlugin, setPickingPlugin] = React.useState(null);
    const selectionRef = React.useRef(null);
    const pluginPickRef = React.useRef(null);
    const searchRef = React.useRef(null);
    const requestRef = React.useRef(0);

    function show(event) { if (locked) return; setKeyboardMotion(event?.detail === 0); selectionRef.current = getInputSelection?.(); setPresent(true); setOpen(true); setScreen('home'); setError(''); }
    function close(restoreFocus = false) { if (restoreFocus) setKeyboardMotion(true); setOpen(false); if (restoreFocus) triggerRef.current?.focus?.(); }
    function focusInput() { rootRef.current?.closest?.('[data-composer-card]')?.querySelector?.('textarea')?.focus?.({preventScroll:true}); }

    React.useEffect(() => {
      setUploading(false); setUploadStatus(''); setError(''); setOpen(false); setPresent(false);
      return () => { uploadRef.current?.abort(); uploadRef.current = null; };
    }, [sessionId]);

    // Keyboard dismissal is immediate. Pointer exits retain only the inert
    // visual; a bounded fallback also handles interrupted/missing transitions.
    React.useEffect(() => {
      if(open || !present) return;
      if(keyboardMotion) {setPresent(false);return;}
      const timer=setTimeout(()=>setPresent(false),200);
      return ()=>clearTimeout(timer);
    }, [open,present,keyboardMotion]);

    async function addFiles(event) {
      const chosen = [...(event.currentTarget.files ?? [])];
      event.currentTarget.value = '';
      if (!chosen.length || uploadRef.current) return;
      if (chosen.length > 8) { setError('一次最多上传 8 个文件。'); return; }
      if (chosen.some(file => file.size > 8 * 1024 * 1024)) { setError('单个文件不能超过 8 MB。'); return; }
      const controller = new AbortController(); uploadRef.current = controller;
      const owner = sessionId;
      setError(''); setUploading(true);
      let completed = 0;
      try {
        for (const file of chosen) {
          setUploadStatus(`正在上传 ${completed + 1}/${chosen.length} · ${file.name}`);
          const result = await uploadFile(file, controller.signal);
          if (controller.signal.aborted || latest.current.sessionId !== owner) return;
          const mention = formatFileMention({ path: result.path, kind: 'file' });
          if (!mention) throw new Error('上传成功，但返回的文件路径无法引用。');
          const nextDraft = appendFileMention(latest.current.draft, mention);
          latest.current.draft = nextDraft; latest.current.setDraft?.(nextDraft);
          completed++;
        }
        setUploadStatus(`已上传 ${completed} 个文件，已添加到输入框`);
      } catch (reason) {
        if (!controller.signal.aborted && latest.current.sessionId === owner) {
          setUploadStatus(completed ? `已添加 ${completed} 个文件` : '');
          setError(reason?.message || '文件上传失败，请重试。');
        }
      } finally {
        if (uploadRef.current === controller) { uploadRef.current = null; setUploading(false); }
      }
    }

    React.useEffect(() => {
      if (!open || typeof document === 'undefined') return undefined;
      const escape = event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault?.(); close(true); } };
      const outside = event => { if (!rootRef.current?.contains?.(event.target)) close(); };
      document.addEventListener('keydown', escape); document.addEventListener('pointerdown', outside);
      return () => { document.removeEventListener('keydown', escape); document.removeEventListener('pointerdown', outside); };
    }, [open]);

    React.useEffect(() => {
      if (!open || !unified || screen !== 'home') return;
      const controller = new AbortController();
      setPluginError(''); setPluginStatus('loading');
      Promise.resolve().then(() => typeof loadPlugins === 'function' ? loadPlugins(sessionId, controller.signal) : []).then(items => {
        if (controller.signal.aborted) return;
        setPlugins(Array.isArray(items) ? items : []); setPluginStatus('ready');
      }, reason => {
        if (controller.signal.aborted) return;
        setPlugins([]); setPluginStatus('error'); setPluginError(reason?.message || '插件列表加载失败。');
      });
      return () => controller.abort();
    }, [open, unified, screen, sessionId, loadPlugins, catalogRevision]);

    async function pickPlugin(name) {
      if (locked || pluginPickRef.current || typeof onPickPlugin !== 'function') return;
      const owner = sessionId, ticket = {};
      pluginPickRef.current = ticket; setPickingPlugin(name); setError('');
      try {
        await onPickPlugin(name, selectionRef.current);
        if (latest.current.sessionId !== owner || pluginPickRef.current !== ticket) return;
        close(); focusInput();
      } catch (reason) {
        if (latest.current.sessionId === owner && pluginPickRef.current === ticket) setError(reason?.message || '插件选择失败。');
      } finally {
        if (pluginPickRef.current === ticket) { pluginPickRef.current = null; setPickingPlugin(null); }
      }
    }

    React.useEffect(() => {
      if (!open || !unified || typeof window === 'undefined') return;
      const card = rootRef.current?.closest?.('[data-composer-card]');
      const measure = () => {
        if (!card) return;
        const rect = card.getBoundingClientRect();
        const viewport = window.visualViewport;
        const top = viewport?.offsetTop ?? 0;
        const bottom = top + (viewport?.height ?? window.innerHeight);
        const above = Math.max(0, rect.top - top - 16), below = Math.max(0, bottom - rect.bottom - 16);
        const side = above >= 220 || above >= below ? 'above' : 'below';
        const height = Math.floor(Math.min(400, side === 'above' ? above : below));
        const trigger = triggerRef.current?.getBoundingClientRect();
        const origin = trigger ? Math.max(0, Math.min(rect.width, trigger.left + trigger.width / 2 - rect.left)) : 24;
        setPlacement(previous => previous.side === side && previous.height === height && previous.origin === origin ? previous : {side,height,origin});
      };
      measure();
      const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
      if (card) observer?.observe(card);
      window.addEventListener('resize', measure); window.addEventListener('scroll', measure, true);
      window.visualViewport?.addEventListener('resize', measure);
      return () => { observer?.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); window.visualViewport?.removeEventListener('resize', measure); };
    }, [open, unified]);

    React.useEffect(() => {
      if (!open || !unified) return;
      if (screen === 'files') searchRef.current?.focus?.();
      else menuRef.current?.querySelector?.('[role="menuitem"]:not(:disabled)')?.focus?.();
    }, [open, screen, unified]);

    function menuKeyDown(event) {
      if (!unified) return;
      setKeyboardMotion(true);
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
      if (event.key === 'Tab') { close(); return; }
      if (event.target?.matches?.('input,textarea') || !['ArrowUp','ArrowDown','Home','End'].includes(event.key)) return;
      const items = [...(menuRef.current?.querySelectorAll?.('[role="menuitem"], [role="menuitemcheckbox"], [role="option"]') ?? [])].filter(item => !item.disabled && item.getAttribute('aria-disabled') !== 'true');
      if (!items.length) return;
      event.preventDefault(); event.stopPropagation();
      const at = items.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
      items[next].focus();
    }

    React.useEffect(() => {
      if (!open || screen !== 'files') return undefined;
      const request = ++requestRef.current;
      const controller = new AbortController();
      setStatus('loading'); setError('');
      const timer = setTimeout(() => {
        Promise.resolve(listFiles?.(query, controller.signal)).then(result => {
          if (request !== requestRef.current || controller.signal.aborted) return;
          setFiles(Array.isArray(result) ? result : []); setStatus('ready');
        }, reason => {
          if (request !== requestRef.current || controller.signal.aborted) return;
          setFiles([]); setStatus('error'); setError(reason?.message || '文件列表加载失败。');
        });
      }, 100);
      return () => { clearTimeout(timer); controller.abort(); };
    }, [open, screen, query, listFiles]);

    function addImages(event) {
      const files = [...(event.currentTarget.files ?? [])];
      event.currentTarget.value = '';
      if (files.length === 0 || !imageBridge.onAddImages) return;
      Promise.resolve(imageBridge.onAddImages(files)).catch(reason => setError(reason?.message || '图片添加失败。'));
      close();
    }

    function chooseFile(candidate) {
      if (candidate.kind === 'directory') {
        setQuery(`${candidate.path.replace(/\/$/, '')}/`); searchRef.current?.focus?.(); return;
      }
      const mention = formatFileMention(candidate);
      if (!mention) { setError('这个路径无法安全引用。'); return; }
      setDraft?.(appendFileMention(draft, mention)); close(); focusInput();
    }

    const fileName = candidate => candidate.path.slice(candidate.path.lastIndexOf('/') + 1) || candidate.path;
    return h('div', { className: `cx-attachment-root${unified ? ' cx-composer-add' : ''}`, ref: rootRef },
      h('input', { ref: inputRef, className: 'cx-attachment-file-input', type: 'file', multiple: true, accept: 'image/png,image/jpeg,image/webp,image/gif', tabIndex: -1, 'aria-hidden': true, onChange: addImages }),
      h('input', { ref: fileInputRef, className: 'cx-attachment-file-input', 'data-cx-file-upload': true, type: 'file', multiple: true, tabIndex: -1, 'aria-hidden': true, onChange: addFiles }),
      h(Action, { elementRef: triggerRef, className: 'cx-attachment-trigger', label: unified ? '添加' : '添加图片或上传文件', disabled: locked, 'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-busy': uploading, onClick: event => open ? close(event.detail === 0) : show(event) }, h(Glyph, { kind: unified ? 'plus' : 'clip' })),
      present && h(Surface, { elementRef: menuRef, className: `cx-attachment-menu${unified ? ' cx-composer-menu' : ''}`, material: 'regular', floating: true, role: 'menu', 'aria-label': '添加到对话', 'data-side': placement.side, 'data-motion':keyboardMotion ? 'instant' : 'pointer', style: unified ? {'--cx-add-menu-max-height': `${placement.height}px`, '--cx-add-menu-origin':`${placement.origin}px`} : undefined, 'data-presence': open ? 'open' : 'closed', 'aria-hidden': open ? undefined : true, inert: open ? undefined : '', onKeyDown: menuKeyDown, onTransitionEnd: event => { if (event.target === event.currentTarget && !open) setPresent(false); } },
        unified && screen === 'home' ? h(React.Fragment, null,
          h('p', {className:'cx-composer-menu-heading'}, '添加'),
          h(Action, {className:'cx-composer-menu-item', role:'menuitem', onClick:()=>setScreen('attachments')}, h(Glyph, {kind:'clip'}), h('span', null, '文件和文件夹')),
          modeItems,
          h('p', {className:'cx-composer-menu-heading'}, '插件'),
          pluginStatus === 'loading' && h('p', {className:'cx-composer-catalog-state',role:'status'}, '正在加载…'),
          pluginStatus === 'ready' && plugins.length === 0 && h('p', {className:'cx-composer-catalog-state',role:'status'}, '暂无可选的插件技能'),
          pluginStatus === 'error' && h('p', {className:'cx-composer-catalog-state',role:'alert'}, pluginError, h('button',{type:'button',role:'menuitem',onClick:()=>setCatalogRevision(value=>value+1)},'重试')),
          plugins.map(plugin => h(Action, {key:plugin.name,className:'cx-composer-menu-item cx-composer-plugin',role:'menuitem', disabled:locked || pickingPlugin !== null, title:plugin.description, onClick:()=>pickPlugin(plugin.name)},
            h('span',{className:'cx-composer-plugin-icon'},h(PluginGlyph,{name:plugin.name})),
            h('span',{className:'cx-composer-plugin-copy'},h('span',{className:'cx-composer-plugin-name'},pluginLabel(plugin.name)),h('span',{className:'cx-composer-plugin-description'},plugin.description)))))
        : screen === 'home' || screen === 'attachments' ? h(React.Fragment, null,
          h('div', { className: 'cx-attachment-menu-heading' }, unified && h(Action, {className:'cx-composer-menu-back',label:'返回添加菜单',onClick:()=>setScreen('home')},h(Glyph,{kind:'back'})), h('strong', null, unified ? '文件和文件夹' : '添加到对话'), h('span', null, '从电脑上传，或引用工作区中的文件')),
          h(Action, { className: 'cx-attachment-choice', role: 'menuitem', disabled: uploading || !sessionId || !uploadFile, onClick: () => fileInputRef.current?.click?.() },
            h('span', { className: 'cx-attachment-choice-icon' }, h(Glyph, { kind: 'clip' })),
            h('span', { className: 'cx-attachment-choice-copy' }, h('strong', null, '上传本机文件'), h('span', null, '文档、代码或其他文件 · 单个最大 8 MB')),
            h('span', { className: 'cx-attachment-choice-key' }, '上传')),
          h(Action, { className: 'cx-attachment-choice', role: 'menuitem', disabled: !imageBridge.canAddImages, onClick: () => inputRef.current?.click?.() },
            h('span', { className: 'cx-attachment-choice-icon', 'data-kind': 'image' }, h(Glyph, { kind: 'image' })),
            h('span', { className: 'cx-attachment-choice-copy' }, h('strong', null, '本机图片'), h('span', null, imageBridge.canAddImages ? 'PNG、JPEG、WebP 或 GIF' : '当前会话暂不可添加')),
            h('span', { className: 'cx-attachment-choice-key' }, '原生')),
          h(Action, { className: 'cx-attachment-choice', role: 'menuitem', disabled: typeof sessionId !== 'string' || !sessionId.trim(), onClick: () => { setScreen('files'); setQuery(''); setTimeout(() => searchRef.current?.focus?.(), 0); } },
            h('span', { className: 'cx-attachment-choice-icon', 'data-kind': 'folder' }, h(Glyph, { kind: 'folder' })),
            h('span', { className: 'cx-attachment-choice-copy' }, h('strong', null, '工作区文件'), h('span', null, '插入 @ 引用，需要时再读取')),
            h('span', { className: 'cx-attachment-choice-key' }, '引用')))
          : h(React.Fragment, null,
            h('div', { className: 'cx-attachment-file-head' },
              h(Action, { className: 'cx-attachment-back', label: '返回', onClick: () => setScreen(unified ? 'attachments' : 'home') }, h(Glyph, { kind: 'back' })),
              h('label', { className: 'cx-attachment-search' }, h('span', { className: 'sr-only' }, '搜索工作区文件'), h('input', { ref: searchRef, value: query, placeholder: '搜索文件或输入路径', onChange: event => setQuery(event.currentTarget.value) }))),
            h('div', { className: 'cx-attachment-results', role: 'listbox', 'aria-label': '工作区文件' },
              status === 'loading' && h('p', { className: 'cx-attachment-state', role: 'status' }, '正在查找…'),
              status === 'ready' && files.length === 0 && h('p', { className: 'cx-attachment-state' }, '没有匹配的文件'),
              files.map(candidate => h(Action, { className: 'cx-attachment-file-row', role: 'option', key: `${candidate.kind}:${candidate.path}`, onClick: () => chooseFile(candidate) },
                h('span', { className: 'cx-attachment-file-glyph' }, h(Glyph, { kind: candidate.kind === 'directory' ? 'folder' : 'clip' })),
                h('span', { className: 'cx-attachment-file-copy' }, h('strong', null, `${fileName(candidate)}${candidate.kind === 'directory' ? '/' : ''}`), h('span', null, candidate.path)),
                h('span', { className: 'cx-attachment-file-kind' }, candidate.kind === 'directory' ? '打开' : '引用'))))),
        uploadStatus && h('p', { className: 'cx-attachment-upload-status', role: 'status', 'aria-live': 'polite' }, uploadStatus),
        error && h('p', { className: 'cx-attachment-error', role: 'alert' }, error)));
  }

  return { AttachmentControl, ComposerAttachments, formatFileMention, appendFileMention };
}
