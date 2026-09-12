# ColdX identity

ColdX uses an original imagegen mark: a compact blue flowing form with a large
negative-space opening. The wordmark remains plain text. Both native themes use
the same transparent full-color artwork.

The unchanged generated master is `plugin/client/assets/coldx-logo-source.png`.
The exact prompt and generation mode are recorded in
[logo-imagegen-prompt-2026-09-12.md](logo-imagegen-prompt-2026-09-12.md).

`plugin/client/brand-source.mjs` renders the self-contained PNG supplied by the
client build. The native sidebar uses a 24px symbol; the home lockup uses a 48px symbol
and a 32–36px wordmark. Decorative images use an empty accessible name when
adjacent text already names the brand.

The normal client build regenerates all delivery assets. To build only the brand:

```sh
node scripts/build-brand-assets.mjs
node --test test/brand.test.mjs
```

Assets:

- `plugin/client/assets/coldx-logo.png`: transparent 128px UI artwork.
- `plugin/client/assets/favicon.png`: transparent 64px browser artwork.
- `plugin/client/assets/coldx-symbol.svg` and `favicon.svg`: self-contained SVG
  wrappers around the corresponding PNG. These are raster artwork, not vectors.
- `desktop/assets/icon.png`: 1024px desktop icon on a neutral rounded tile.
- `desktop/assets/icon.svg`: self-contained wrapper of that desktop PNG.

The build uses the existing PDF toolchain canvas dependency for resizing only.
It introduces no client dependency or new image endpoint; the generated client
contains the small UI and favicon data URLs, not the full-resolution master.
The favicon link remains owned by the ColdX plugin and restores prior links on
disposal. Native DSH branding files are not edited.

Desktop assets feed the existing Electron packaging configuration. This change
does not build or sign platform installers.
