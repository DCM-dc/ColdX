# Desktop browser dependency repair

> Execution uses the existing native DSH integration and parallel bounded implementation tasks. The screenshot reports an unavailable browser during `coldx_browser`; visible browser tabs are outside this repair.

**Goal:** A fresh Windows ColdX installation can execute browser tools without Node/pnpm setup, a pre-existing Playwright cache, or a browser download after installation.

**Architecture:** Bundle the headless Chromium version pinned by Playwright MCP. Resolve and validate the same binary used for launch. Carry its path through desktop backend and MCP stdio process boundaries. Verify the packaged driver using a local test website and real screenshot output.

**Tech stack:** DSH 0.1.1-rc.2, Playwright MCP 0.0.80, Playwright 1.63.0-alpha-2026-08-31, Node 24, Electron 44, NSIS.

## Runtime detection

- [x] Add three isolated-cache regression cases in `test/computer-runtime.test.mjs`: shell without full Chrome, full Chrome without shell, and MCP environment forwarding. Observe all three fail before changing implementation.
- [x] Update `plugin/computer-preset.mjs` to use the pinned Playwright registry's `chromium-headless-shell` executable, and explicitly forward `PLAYWRIGHT_BROWSERS_PATH` into MCP stdio.
- [x] Launch that exact executable in `plugin/browser-driver.mjs`; restrict manual installation to the required shell in `scripts/install-browser.mjs`.
- [x] Run the new tests plus `test/computer-native.test.mjs`: 9 pass, including actual click/screenshot/attachment behavior.

## Desktop distribution

- [x] Add browser-bundle staging and verification. Run the staged package's own installer with `install --only-shell chromium`, using an absolute private `runtime/browsers` directory.
- [x] Record the pinned versions and relative executable in the desktop manifest; reject missing binaries and escaping paths before producing an installer.
- [x] Package `browsers/**/*`; pass `browsersPath` from desktop paths through the Node backend, overriding unrelated host cache settings for packaged mode.
- [x] Add and run stage/backend regression tests for absent bundles and process environment propagation.

## Real packaged acceptance

- [x] Add `scripts/desktop/browser-smoke.mjs` using the shipped Node and MCP driver against a disposable local fixture. Assert successful navigation, button click, changed page state, screenshot bytes and closure. No model requests.
- [ ] Build the patch Windows installer and run the browser smoke outside the checkout with the bundled directory, independent of the global cache.
- [x] Run source tests: 526 pass, 0 fail, 1 opt-in titlebar browser test skipped. Desktop package acceptance is recorded separately below.
- [ ] Publish the checked source and versioned patch installer; keep previous released files unchanged and report actual verification boundaries.

## Constraints

Do not read or publish private sessions, credentials, `codex-archive/`, or the canceled import worktree. Do not add a second agent runtime, browser UI or unrelated UI changes. Browser engine availability is separate from real model reasoning ability. All processes and temporary files used in smoke tests must remain owned by those tests.

## Verified package evidence

Windows x64, Node 24.16.0, Playwright MCP 0.0.80, SDK 1.30.0 and Chromium headless shell revision 1243 passed the relocated-runtime browser smoke. The local fixture was navigated, clicked and observed through MCP; its returned PNG was 1280 by 720 pixels and 28,131 bytes. The driver exited and the disposable directory was removed. No build-machine `.links` metadata was present. The separate relocated desktop smoke passed renderer readiness, bundled pnpm and backend shutdown checks. Unix timeout cleanup was reviewed but not executed on this Windows host.
