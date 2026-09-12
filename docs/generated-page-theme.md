# Generated page theme contract

The native DSH theme service remains the preference owner. ColdX reads `ctx.theme.getTheme().active.colorScheme` initially and subscribes to `theme/change`. Inline pages, visited interaction previews (including retained hidden previews), and the HTML file preview receive live updates. Theme changes do not change `srcDoc`, recreate the iframe, rerun its page script, clear form input, or cancel a pending `ColdX.submit`.

The sandbox receives only `light` or `dark`, with no host configuration. The bridge checks the parent window and its unique page channel before accepting an update. Initial markup has `data-theme` on `<html>` before generated scripts execute. Live updates change that attribute, the browser color scheme, and the color-scheme meta tag; duplicate values do not fire another event.

Use the host-owned semantic colors in generated CSS:

```css
body { background: var(--page-bg); color: var(--page-text); }
.surface { background: var(--page-surface); border: 1px solid var(--page-line); }
.muted { color: var(--page-muted); }
input { background: var(--page-field); color: var(--page-text); }
.primary { background: var(--page-accent); color: var(--page-on-accent); }
```

Do not redefine `--page-*` tokens. For a necessary custom palette, define your own variables with both `:root[data-theme="light"]` and `:root[data-theme="dark"]` variants. The app's explicit preference can differ from the operating system, so `prefers-color-scheme` alone is insufficient. Use paired foreground/background colors and check contrast in both schemes.

Scripts can read `ColdX.theme` before their first render. Canvas, chart, and SVG code that resolves colors once must update its drawing when the host scheme changes:

```js
function paint() {
  const colors = getComputedStyle(document.documentElement);
  // Repaint existing visual content using colors.getPropertyValue('--page-text'), etc.
  // Preserve the user's input, selection and task state.
}
paint();
window.addEventListener('coldx:themechange', event => {
  // event.detail.theme and ColdX.theme are already the new light/dark value.
  paint();
});
```

Existing pages using the original `--page-*` tokens gain live theming through this renderer. For older pages that already supply separate palettes, the bridge also maps exact, standalone CSS media conditions `(prefers-color-scheme: light)` and `(prefers-color-scheme: dark)` to the host preference through CSSOM. It changes only the condition to `all` or `not all`, retaining its original scheme for the next update. Styles added to the DOM are synchronized as well. Compound queries, viewport/print/reduced-motion conditions, JavaScript `matchMedia`, and inaccessible stylesheets retain their authored behavior.

Existing pages with hardcoded colors or an unrelated theme system still require a source update or regeneration; ColdX does not invert their images or rewrite arbitrary declarations. HTML opened in the file preview receives the same bridge inside its opaque-origin sandbox, with original inline scripts and layout preserved; its `ColdX.submit` is explicitly rejected because a file preview cannot submit a task. Exported HTML opened outside ColdX remains outside this bridge and must provide its own theme handling.

Deterministic coverage: `test/page-document.test.mjs`, `test/page-stage-ready.test.mjs`, `test/interaction-components.test.mjs`, and `test/html-preview.test.mjs` verify initial availability, authenticated updates, preserved state and pending submissions, exact legacy CSS query compatibility, raw inline script execution, stable frame identity, load-race resync, hidden previews, and subscription cleanup. Browser acceptance should switch the app theme while a page form contains an unsent draft and verify both CSS colors and draft preservation.
