import { join, resolve } from 'node:path';

export function classifyNavigation(value, backendUrl) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return 'blocked';
    return url.origin === new URL(backendUrl).origin ? 'internal' : 'external';
  } catch { return 'blocked'; }
}

export function externalUrlForNavigation(value, backendUrl, source) {
  if (source !== 'new-window' || classifyNavigation(value, backendUrl) !== 'external') return undefined;
  return new URL(value).href;
}

export function desktopElectronEnvironment(source = process.env) {
  const environment = { ...source };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === 'electron_run_as_node') delete environment[key];
  }
  return environment;
}

/** Keep native caption controls and shortcuts without a hidden Alt menu. */
export function configureDesktopWindowChrome(window, { platform = process.platform, openWorkspace, onError = () => {} } = {}) {
  if (platform === 'darwin') return () => {};
  const contents = window.webContents;
  window.removeMenu();
  window.setAutoHideMenuBar(false);
  window.setMenuBarVisibility(false);
  const input = (event, key) => {
    if (key.type !== 'keyDown' || key.isAutoRepeat || key.alt || key.meta || key.shift) return;
    if (key.key === 'F11' && !key.control) {
      event.preventDefault();window.setFullScreen(!window.isFullScreen());
    } else if (key.control && key.key?.toLowerCase() === 'o' && openWorkspace) {
      event.preventDefault();
      try { Promise.resolve(openWorkspace()).catch(onError); } catch (error) { onError(error); }
    }
  };
  contents.on('before-input-event', input);
  return () => contents.off('before-input-event', input);
}

export function isSmokeReady(snapshot, backendUrl) {
  return Boolean(snapshot
    && classifyNavigation(snapshot.url, backendUrl) === 'internal'
    && snapshot.readyState === 'complete'
    && Number.isInteger(snapshot.rootChildren)
    && snapshot.rootChildren > 0
    && Array.isArray(snapshot.bootEntryIds)
    && snapshot.bootEntryIds.includes('coldx-client')
    && snapshot.coldxShell === true);
}

export async function ensureDesktopWindow({ current, create, load }) {
  let target = current;
  const created = !target || target.isDestroyed();
  if (created) {
    target = create();
    if (load) await load(target);
  }
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  return target;
}

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

export function createBackendLifecycle({ start, onUnexpectedExit = () => {} }) {
  if (typeof start !== 'function') throw new TypeError('start must be a function');
  if (typeof onUnexpectedExit !== 'function') throw new TypeError('onUnexpectedExit must be a function');
  let current;
  let currentGeneration = 0;
  let generation = 0;
  let quitting = false;
  let pendingController;
  let transition = Promise.resolve();
  const expectedStops = new WeakSet();

  async function stopExpected(instance) {
    if (!instance) return;
    expectedStops.add(instance);
    if (current === instance) current = undefined;
    await instance.stop();
  }

  function watch(instance, workspace, version) {
    let handled = false;
    const onExit = (code, signal) => {
      if (handled) return;
      handled = true;
      instance.child.off('exit', onExit);
      const expected = expectedStops.has(instance) || quitting || version !== generation;
      if (current === instance) current = undefined;
      if (!expected) onUnexpectedExit({ backend: instance, workspace, code, signal });
    };
    instance.child.once('exit', onExit);
    if (childHasExited(instance.child)) onExit(instance.child.exitCode, instance.child.signalCode);
  }

  function switchTo(workspace) {
    if (quitting) return Promise.resolve(undefined);
    const version = ++generation;
    pendingController?.abort();
    const controller = new AbortController();
    const previous = transition.catch(() => {});
    const operation = previous.then(async () => {
      if (quitting || version !== generation) return undefined;
      await stopExpected(current);
      if (quitting || version !== generation) return undefined;
      pendingController = controller;
      let started;
      try { started = await start({ workspace, signal: controller.signal }); }
      catch (error) {
        if (controller.signal.aborted || quitting || version !== generation) return undefined;
        throw error;
      } finally {
        if (pendingController === controller) pendingController = undefined;
      }
      if (quitting || version !== generation) {
        await stopExpected(started);
        return undefined;
      }
      current = started;
      currentGeneration = version;
      watch(started, workspace, version);
      return started;
    });
    transition = operation;
    return operation;
  }

  async function quit() {
    if (quitting) return transition.catch(() => {});
    quitting = true;
    generation += 1;
    pendingController?.abort();
    const operation = transition.catch(() => {}).then(() => stopExpected(current));
    transition = operation;
    await operation;
  }

  return {
    switchTo,
    quit,
    isCurrent(instance) { return !quitting && current === instance && currentGeneration === generation; },
    get current() { return current; },
    get quitting() { return quitting; },
  };
}

export function desktopPaths({ packaged, resourcesPath, appPath, userData, documents, platform = process.platform, execPath }) {
  const runtimeRoot = packaged ? join(resourcesPath, 'runtime', 'app') : resolve(appPath, '..');
  return {
    runtimeRoot,
    nodePath: packaged ? join(resourcesPath, 'runtime', platform === 'win32' ? 'node.exe' : 'node') : execPath,
    ...(packaged ? { browsersPath: join(resourcesPath, 'runtime', 'browsers') } : {}),
    dataHome: join(userData, 'dsh'),
    workspace: join(documents, 'ColdX'),
  };
}
