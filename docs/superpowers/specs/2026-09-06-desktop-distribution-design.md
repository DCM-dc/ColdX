# ColdX desktop distribution

## Intent and authorization

Package the existing ColdX Web product for macOS, Windows, and Linux. The user authorized autonomous implementation without additional questions. This is a new desktop subsystem; existing DSH runtime ownership and ongoing ColdX changes remain intact.

## Architecture

Use Electron for the window and electron-builder for installers. Ship a separate Node 24 executable with the existing DSH server and production dependencies. The backend runs outside ASAR, using Node's native ABI; Electron's renderer has no Node integration, preload bridge, or direct filesystem API.

The shell starts only its own server on an OS-assigned loopback port, waits for confirmed readiness, and then loads it. It does not attach to or stop the existing service on port 3086. IPC requests graceful backend shutdown before bounded termination. Native window menus provide workspace selection, reload, data-folder access, and quit. macOS retains its process after the last window closes until Quit.

## Files and storage

`desktop/` owns shell code, backend supervision, packaging configuration, and a locked production-runtime manifest. `scripts/desktop/` stages an explicit source allowlist and a separate Node binary. Production dependencies are installed into the staged runtime with npm's lockfile and install-links, so pnpm junctions cannot point outside the delivered application. The staged runtime contains no `.runtime`, credentials, `.env`, sessions, test fixtures, or user workspaces.

User data lives below Electron's platform-specific `userData/ColdX` location; DSH state uses its `dsh` subdirectory. New desktop installs configure their own provider in the existing Settings UI. The default working directory is the user's Documents/ColdX folder. Environment overrides are explicit development conveniences, not bundled values.

## Distribution and acceptance

Windows produces NSIS and an unpacked application; macOS produces DMG/ZIP for Intel and Apple Silicon; Linux produces AppImage/DEB for x64. Each build runs on its own OS/architecture because native dependencies must match. CI is manual and uploads private build artifacts without publishing a release. Signing/notarization uses release credentials when supplied; unsigned development packages are labeled as such.

Acceptance requires lifecycle tests, renderer navigation policy tests, production staging checks, the complete existing regression suite, and a Windows packaged smoke run with fresh data. macOS/Linux support remains a configured target until their builders and real machines have run the same smoke checks. Shell/Python/C tools depend on platform executables available to the user's workspace; bundling ColdX does not promise every development toolchain.
