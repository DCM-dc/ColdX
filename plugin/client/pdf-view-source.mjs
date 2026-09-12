// Serialized into the DSH client factory; PDF.js itself is loaded only on demand.
export function createPdfViewComponents(React, suppliedRuntimeLoader) {
  const h = React.createElement;
  let runtimePromise;
  function loadRuntime() {
    if (suppliedRuntimeLoader) return suppliedRuntimeLoader();
    if (globalThis.__ColdXPdfRuntime) return Promise.resolve(globalThis.__ColdXPdfRuntime);
    if (!runtimePromise) runtimePromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      let settled = false;
      const finish = reason => {
        if (settled) return;
        settled = true; clearTimeout(deadline); script.onload = null; script.onerror = null; script.remove();
        if (reason) { runtimePromise = undefined; reject(reason); }
        else resolve(globalThis.__ColdXPdfRuntime);
      };
      const deadline = setTimeout(() => finish(new Error('PDF 渲染器加载超时，请重试。')), 20_000);
      script.src = '/coldx/assets/pdf-runtime.js'; script.async = true;
      script.onload = () => {
        finish(globalThis.__ColdXPdfRuntime?.open ? null : new Error('PDF 渲染器未加载。'));
      };
      script.onerror = () => finish(new Error('PDF 渲染器加载失败，请重试。'));
      document.head.append(script);
    });
    return runtimePromise;
  }

  function decodePdf(base64) {
    const maximum = 8 * 1024 * 1024;
    if (typeof base64 !== 'string' || !base64 || base64.length > 4 * Math.ceil(maximum / 3)) throw new Error('PDF 预览支持最大 8 MB 的完整文件。');
    let raw;
    try { raw = atob(base64); } catch { throw new Error('PDF 文件数据无效。'); }
    if (!raw.length || raw.length > maximum) throw new Error('PDF 文件大小超出预览范围。');
    return Uint8Array.from(raw, character => character.charCodeAt(0));
  }

  function canvasSize(viewport, pixelRatio = 1) {
    const width = viewport.width, height = viewport.height;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 32_768 || height > 32_768) throw new Error('此 PDF 页面尺寸超出预览范围。');
    const ratio = Math.min(Math.max(1, pixelRatio || 1), 2, Math.sqrt(8_000_000 / (width * height)), 16_384 / width, 16_384 / height);
    return { width: Math.max(1, Math.floor(width * ratio)), height: Math.max(1, Math.floor(height * ratio)), ratio };
  }

  function PdfPreview({ base64, name = 'PDF 文件' }) {
    const [documentState, setDocumentState] = React.useState(null);
    const current = documentState?.source === base64 ? documentState : null;
    const [failure, setFailure] = React.useState(null);
    const [page, setPage] = React.useState(1), [zoom, setZoom] = React.useState('fit');
    const [width, setWidth] = React.useState(700), [rendering, setRendering] = React.useState(false), [notice, setNotice] = React.useState('');
    const surface = React.useRef(null), scroll = React.useRef(null), committed = React.useRef(null);
    const [frame, setFrame] = React.useState(null);
    const hasFrame = frame?.source === base64;
    const error = failure?.source === base64 ? failure.message : '';
    const [attempt, setAttempt] = React.useState(0);
    React.useEffect(() => {
      let alive = true, job;
      const timeout = setTimeout(() => { if (alive) { alive = false; setFailure({ source: base64, message: 'PDF 读取超时，可重试或在本机打开。' }); job?.destroy(); } }, 30_000);
      setDocumentState(null); setFailure(null); setPage(1); setZoom('fit'); setNotice('');
      (async () => {
        try {
          const data = decodePdf(base64);
          const runtime = await loadRuntime();
          if (!alive) return;
          job = runtime.open(data);
          const pdf = await job.promise;
          if (!alive) return;
          if (!Number.isInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > 2000) throw new Error('PDF 页数超出预览范围（最多 2000 页）。');
          setDocumentState({ source: base64, pdf, runtime });
        } catch (reason) {
          if (alive) setFailure({ source: base64, message: reason?.name === 'PasswordException' ? '此 PDF 已加密，请在本机打开。' : reason?.message || 'PDF 无法读取，请在本机打开。' });
          job?.destroy();
        } finally { clearTimeout(timeout); }
      })();
      return () => { alive = false; clearTimeout(timeout); job?.destroy(); };
    }, [base64, attempt]);

    React.useEffect(() => {
      const element = scroll.current;
      if (!element) return;
      const update = () => setWidth(Math.max(180, Math.floor(element.clientWidth - 32)));
      update();
      if (typeof ResizeObserver !== 'function') return;
      const observer = new ResizeObserver(update); observer.observe(element);
      return () => observer.disconnect();
    }, []);

    React.useEffect(() => {
      const element = surface.current;
      return () => {
        const previous = committed.current; committed.current = null;
        element?.replaceChildren();
        if (previous) { previous.canvas.width = 0; previous.canvas.height = 0; }
      };
    }, []);

    React.useEffect(() => {
      if (!current) return;
      let alive = true, renderTask, textLayer, textReader, pdfPage, stagingCanvas, stagingText;
      const cancelText = message => {
        const reader = textReader; textReader = undefined;
        // PDF.js marks its protocol stream closed only after validating an Error
        // reason. Cancelling without one closes the browser stream but leaves
        // queued worker chunks targeting an apparently open protocol stream.
        return reader ? reader.cancel(Object.assign(new Error(message), { name: 'AbortException' })).catch(() => {}) : Promise.resolve();
      };
      const ownSurface = surface.current;
      if (!ownSurface) return;
      setRendering(true); setNotice(''); setFailure(null);
      const timeout = setTimeout(() => {
        if (!alive) return;
        alive = false; renderTask?.cancel(); textLayer?.cancel(); void cancelText('PDF page rendering timed out.');
        setRendering(false); setFailure({ source: base64, message: '这一页渲染超时，请尝试其他页或在本机打开。' });
      }, 30_000);
      (async () => {
        try {
          pdfPage = await current.pdf.getPage(page);
          if (!alive) return;
          const natural = pdfPage.getViewport({ scale: 1 });
          const scale = zoom === 'fit' ? Math.min(3, width / natural.width) : Number(zoom);
          const viewport = pdfPage.getViewport({ scale });
          const pixels = canvasSize(viewport, globalThis.devicePixelRatio);
          // Never resize or clear the displayed frame. Both layers are prepared
          // off-DOM and published together after their current owner finishes.
          stagingCanvas = ownSurface.ownerDocument.createElement('canvas');
          stagingText = ownSurface.ownerDocument.createElement('div');
          stagingText.className = 'cx-pdf-text-layer';
          stagingCanvas.width = pixels.width; stagingCanvas.height = pixels.height;
          stagingCanvas.style.width = `${viewport.width}px`; stagingCanvas.style.height = `${viewport.height}px`;
          stagingCanvas.setAttribute('aria-label', `${name} 第 ${page} 页`);
          const context = stagingCanvas.getContext('2d', { alpha: false });
          if (!context) throw new Error('无法创建 PDF 画布，请重试。');
          context.save(); context.fillStyle = 'rgb(255,255,255)';
          context.fillRect(0, 0, pixels.width, pixels.height); context.restore();
          renderTask = pdfPage.render({ canvas: stagingCanvas, canvasContext: context, viewport,
            transform: pixels.ratio === 1 ? undefined : [pixels.ratio, 0, 0, pixels.ratio, 0, 0],
            annotationMode: current.runtime.AnnotationMode.DISABLE, background: 'rgb(255,255,255)' });
          renderTask.promise.catch(() => {});
          const content = { items: [], styles: Object.create(null) };
          const reader = pdfPage.streamTextContent({ includeMarkedContent: true }).getReader();
          textReader = reader;
          let textLength = 0;
          while (alive) {
            const { value, done } = await reader.read();
            if (done) { if (textReader === reader) textReader = undefined; reader.releaseLock(); break; }
            Object.assign(content.styles, value.styles); content.lang ??= value.lang;
            for (const item of value.items) {
              if (content.items.length >= 20_000 || textLength >= 1_000_000) break;
              if ((item.str?.length ?? 0) > 1_000_000 - textLength) { textLength = 1_000_000; break; }
              content.items.push(item); textLength += item.str?.length ?? 0;
            }
            if (content.items.length >= 20_000 || textLength >= 1_000_000) {
              // Cancellation closes our reader immediately; a stalled worker's
              // acknowledgement must not retain this frame or delay publishing.
              void cancelText('PDF text selection limit reached.');
              if (alive) setNotice('这一页文字较多，文字选择层已限制为前 20,000 项 / 1,000,000 字符。');
              break;
            }
          }
          if (!alive) return;
          textLayer = new current.runtime.TextLayer({ textContentSource: content, container: stagingText, viewport });
          await Promise.all([renderTask.promise, textLayer.render()]);
          if (alive) {
            const previous = committed.current;
            ownSurface.style.width = `${viewport.width}px`; ownSurface.style.height = `${viewport.height}px`;
            ownSurface.style.setProperty('--total-scale-factor', String(scale * (viewport.userUnit ?? 1)));
            ownSurface.style.setProperty('--scale-round-x', '1px'); ownSurface.style.setProperty('--scale-round-y', '1px');
            ownSurface.replaceChildren(stagingCanvas, stagingText);
            committed.current = { canvas: stagingCanvas, source: base64, page };
            stagingCanvas = undefined; stagingText = undefined;
            if (previous) { previous.canvas.width = 0; previous.canvas.height = 0; }
            setFrame({ source: base64, page }); setRendering(false);
            if (!content.items.some(item => item.str?.trim())) setNotice('这一页没有可选择的文字，可能是扫描图片。');
          }
        } catch (reason) {
          renderTask?.cancel(); textLayer?.cancel(); void cancelText('PDF page rendering failed.');
          if (alive) {
            const cancelled = reason?.name === 'RenderingCancelledException' || reason?.name === 'AbortException';
            setRendering(false); setFailure({ source: base64, message: cancelled ? '这一页渲染已中断，请重试。' : reason?.message || '这一页无法渲染。' });
          }
        } finally {
          clearTimeout(timeout);
          // A cancelled PDF.js task can reject before its deferred cleanup.
          // Release only this offscreen buffer after rendering has settled.
          Promise.resolve(renderTask?.promise).catch(() => {}).finally(() => {
            if (stagingCanvas) { stagingCanvas.width = 0; stagingCanvas.height = 0; }
            stagingText?.replaceChildren(); pdfPage?.cleanup();
          });
        }
      })();
      return () => {
        alive = false; clearTimeout(timeout); renderTask?.cancel(); textLayer?.cancel(); void cancelText('PDF page preview changed or closed.');
      };
    }, [current, page, zoom, width]);

    const count = current?.pdf.numPages ?? 0;
    return h('section', { className: 'cx-pdf-preview', 'aria-label': `${name} PDF 预览` },
      h('div', { className: 'cx-pdf-toolbar' },
        h('button', { type: 'button', disabled: !count || page <= 1, 'aria-label': 'PDF 上一页', onClick: () => setPage(value => Math.max(1, value - 1)) }, '‹'),
        h('label', null, h('span', { className: 'cx-pdf-page-label' }, '页码'), h('input', { type: 'number', min: 1, max: count || 1,
          'aria-label': 'PDF 页码', value: page, disabled: !count, onChange: event => {
            const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= count) setPage(value);
          } }), h('span', null, `/ ${count || '—'}`)),
        h('button', { type: 'button', disabled: !count || page >= count, 'aria-label': 'PDF 下一页', onClick: () => setPage(value => Math.min(count, value + 1)) }, '›'),
        h('select', { value: zoom, 'aria-label': 'PDF 缩放', disabled: !count, onChange: event => setZoom(event.target.value) },
          ...[['fit', '适合宽度'], ['0.5', '50%'], ['0.75', '75%'], ['1', '100%'], ['1.25', '125%'], ['1.5', '150%'], ['2', '200%'], ['3', '300%']].map(([value, label]) => h('option', { key: value, value }, label))),
        h('span', { className: 'cx-pdf-status', role: 'status' }, !current && !error ? '正在读取 PDF…' : rendering && !error ? '正在渲染…' : '')),
      error && h('div', { className: 'cx-pdf-error', role: 'alert' }, error, h('button', { type: 'button', onClick: () => setAttempt(value => value + 1) }, '重试')),
      notice && h('p', { className: 'cx-pdf-notice' }, notice),
      h('div', { className: 'cx-pdf-scroll', ref: scroll },
        !hasFrame && !error && h('div', { className: 'cx-pdf-placeholder', 'aria-hidden': true }, '正在准备页面…'),
        // This empty host is React-owned; its complete frame children belong
        // exclusively to the renderer, so a state update cannot erase pixels.
        h('div', { className: 'cx-pdf-page', ref: surface, 'data-page': hasFrame ? frame.page : undefined,
          'aria-busy': rendering, 'aria-hidden': !hasFrame, style: { visibility: hasFrame ? 'visible' : 'hidden' } })),
    );
  }
  return { PdfPreview, decodePdf, canvasSize };
}
