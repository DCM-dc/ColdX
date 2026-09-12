import { getDocument, PDFWorker, TextLayer, AnnotationMode, version } from 'pdfjs-dist/legacy/build/pdf.mjs';

// esbuild replaces these with the pinned package's local worker and resources.
const resources = __COLDX_PDF_RESOURCES__;
const workerSource = __COLDX_PDF_WORKER__;

class LocalBinaryDataFactory {
  async fetch({ kind, filename }) {
    const encoded = resources[kind]?.[filename];
    if (typeof encoded !== 'string') throw new Error(`PDF resource is unavailable: ${kind}/${filename}`);
    return Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
  }
}

export function open(data) {
  if (!(data instanceof Uint8Array) || data.length > 8 * 1024 * 1024) throw new Error('PDF 预览支持最大 8 MB 的完整文件。');
  const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
  let port, worker, task, disposed = false, rejectLifecycle;
  const lifecycle = new Promise((_resolve, reject) => { rejectLifecycle = reject; });
  lifecycle.catch(() => {});
  const destroy = () => {
    if (disposed) return;
    disposed = true;
    // Release the actual Worker even when malformed input stalls parser teardown.
    rejectLifecycle(new DOMException('PDF preview closed.', 'AbortError'));
    task?.destroy().catch(() => {});
    port?.terminate(); worker?.destroy(); URL.revokeObjectURL(url);
  };
  try {
    port = new Worker(url, { name: 'coldx-pdf-preview' });
    port.addEventListener('error', () => rejectLifecycle(new Error('PDF 渲染进程未能启动。')));
    worker = new PDFWorker({ port });
    task = getDocument({
      data, worker, BinaryDataFactory: LocalBinaryDataFactory, useWorkerFetch: false,
      cMapPacked: true, useSystemFonts: true, useWasm: true,
      enableXfa: false, isEvalSupported: false, disableAutoFetch: true, disableRange: true, disableStream: true,
      maxImageSize: 16_000_000, canvasMaxAreaInBytes: 32_000_000,
      stopAtErrors: true, verbosity: 0,
    });
    const promise = Promise.race([task.promise, lifecycle]);
    promise.catch(() => {});
    return { promise, destroy };
  } catch (reason) { void destroy(); throw reason; }
}

export { TextLayer, AnnotationMode, version };
