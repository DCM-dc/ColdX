# Local PDF preview

ColdX renders complete PDF bytes with the pinned PDF.js 6.3.289 display engine. It does not depend on a browser PDF plugin. The official legacy build supplies compatibility polyfills; the modern build requires byte APIs absent from the validated Node 24 runtime.

`plugin/client/build-pdf.mjs` produces `pdf-runtime.js`, a separate browser bundle loaded only on the first PDF preview. It packages the matching worker, Adobe CMaps, standard fonts, and the JPEG2000/JBIG2/color WASM decoders. `plugin/pdf-view-host.mjs` serves that single allowlisted local asset. No CDN or Python process is required.

`createPdfViewComponents(React)` returns `PdfPreview({base64, name})`. Keep this component inside the file workspace's existing selection-capture element: its PDF.js TextLayer contains ordinary selectable DOM text. The canvas and text layer share viewport scale, page rotation, and PDF UserUnit. Page/zoom changes reuse the loaded document and cancel the previous render. Both layers are prepared off-DOM and replace the completed frame together; loading, cancellation and rendering errors do not clear the previous completed page. The first frame stays hidden behind a neutral placeholder until ready. A different source hides the old frame immediately, and closing destroys the worker and releases its canvas.

Limits: complete input up to 8 MiB; 2,000 pages; one completed visible frame and one pending render, each at most 8 million canvas pixels; at most 20,000 text-layer items / 1 million characters per page. Retired and cancelled buffers are released. Parsing and each page render have 30-second deadlines. Text-limit cancellation does not wait for the worker's acknowledgement before publishing the bounded frame. Oversized, encrypted, malformed, stalled, or scan-only files receive explicit feedback. Scans remain images; no OCR is claimed.

The PDF scroll container reserves its vertical scrollbar gutter even when the fitted page does not overflow (`scrollbar-gutter: stable`, with an `overflow-y: scroll` fallback). This is necessary for a stable fit-width calculation: classic Windows scrollbars otherwise change the measured content width, making the PDF alternate between overflowing and fitting. Browser regression must include real classic scrollbars (`ignoreDefaultArgs: ['--hide-scrollbars']`) and fractional device scale, not only the default headless scrollbar policy.

PDF data is passed as a typed array rather than a URL. No scripting, annotation-action, XFA, form, or attachment UI is constructed. Annotation painting is disabled. The dedicated worker rejects fetch and XMLHttpRequest; its binary resource factory accepts only packaged filenames. QuickJS assets are omitted. Thus a document cannot turn a link/action into a request or execute embedded JavaScript through this viewer.

Validation includes real two-page PDF canvas rendering and text extraction, compiled browser bundle initialization/worker disposal, and component lifecycle tests for page changes, zoom, cancellation, and late load results. In-app acceptance on 2026-09-12 also covered the user's 51-page report: first and second page rendering, 50% zoom, selecting text and returning a quote to the composer, and closing without new console errors. See `usability-acceptance-2026-09-12.md`.

Primary references:

- [PDF.js examples](https://mozilla.github.io/pdf.js/examples/): document/page loading and canvas viewport rendering.
- [PDF.js API source](https://mozilla.github.io/pdf.js/api/draft/api.js.html): typed-array ownership, PDFWorker, document loading/destruction, binary resource factories and bounded rendering options.
- Installed `pdfjs-dist/web/pdf_viewer.css` and `legacy/build/pdf.mjs`: exact TextLayer scale/rotation contract for the pinned release.
