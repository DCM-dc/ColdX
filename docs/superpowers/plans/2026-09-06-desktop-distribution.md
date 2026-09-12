# ColdX Desktop Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for independent backend implementation and review.

**Goal:** Deliver a Windows-testable desktop package and reproducible macOS/Linux build targets.

**Architecture:** Electron owns only windows and native menus. A bundled Node 24 sidecar owns the existing DSH Web runtime, tools, and sessions.

**Tech Stack:** Electron 44.2.0, electron-builder 26.15.3, Node 24.16.0, DSH 0.1.1-rc.2.

**Spec:** `docs/superpowers/specs/2026-09-06-desktop-distribution-design.md`

## Global constraints

- Preserve existing source changes and native DSH behavior; no new agent loop.
- Explicit source allowlist; no runtime data, credentials, or workspace files in distribution.
- No direct Node APIs in the renderer; only the owned loopback origin may navigate in the app window.
- Do not publish installers or claim untested operating systems passed.

## Task 1: Backend lifecycle

- [ ] Add real child-process fixture tests in `test/desktop-backend.test.mjs` for startup, HTTP readiness, timeout, and clean stop.
- [ ] Implement `desktop/backend.mjs` and `desktop/backend-entry.mjs` with `startBackend({nodePath,runtimeRoot,dataHome,workspace,onLog,timeoutMs})` returning `{url,child,stop}`.
- [ ] Run `node --test test/desktop-backend.test.mjs`; verify no orphaned fixture process.

## Task 2: Window shell

- [ ] Test URL classification and development/packaged path resolution in `test/desktop-shell.test.mjs`.
- [ ] Implement `desktop/window-policy.mjs` and `desktop/main.mjs`. Use sandboxed BrowserWindow, a loading page, explicit native menus, single-instance lock, and graceful quit.
- [ ] Run policy tests and a real Electron startup using fresh state.

## Task 3: Installer staging and build

- [ ] Add `desktop/runtime/package.json` with pinned DSH and local `coldx-client` file dependency, then generate its npm lockfile.
- [ ] Implement `scripts/desktop/stage.mjs`: allowlist copy, native npm install, Node binary copy, explicit manifest, reject wrong platform or architecture.
- [ ] Add electron-builder config with extraResources runtime and Windows/macOS/Linux targets; add manual CI OS matrix.
- [ ] Build Windows unpacked and NSIS artifacts. Launch the packaged application and verify backend startup, fresh-data UI, and clean quit.

## Task 4: Integration and handoff

- [ ] Run the full ColdX regression suite and `git diff --check`.
- [ ] Document build commands, data paths, signing requirements, actual artifact paths, and platform verification limits in `docs/desktop.md`.
- [ ] Update verification record and deliver the local Windows installer with the macOS/Linux build workflow.
