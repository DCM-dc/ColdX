import { readFile } from 'node:fs/promises';

export const name = 'coldx-pdf-view';
export const inject = ['webServer'];
export const PDF_RUNTIME_PATH = '/coldx/assets/pdf-runtime.js';

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PDF_RUNTIME_PATH, async handler(req, res) {
    if (new URL(req.url ?? '/', 'http://local').pathname !== PDF_RUNTIME_PATH) { res.writeHead(404); res.end(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    try {
      const code = await readFile(new URL('./client/pdf-runtime.js', import.meta.url));
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': code.length,
        'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' });
      res.end(req.method === 'HEAD' ? undefined : code);
    } catch { res.writeHead(503); res.end('PDF preview bundle is unavailable.'); }
  } }));
}
