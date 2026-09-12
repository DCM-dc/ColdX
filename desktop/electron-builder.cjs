module.exports = {
  appId: 'app.coldx.desktop',
  productName: 'ColdX',
  directories: { app: 'desktop', output: 'dist/desktop' },
  files: ['package.json', 'main.mjs', 'window-policy.mjs', 'titlebar-host.mjs', 'titlebar-preload.cjs', 'titlebar-smoke.mjs', 'backend.mjs', 'backend-entry.mjs', 'loading.html', 'assets/icon.png', '!node_modules{,/**/*}'],
  icon: 'desktop/assets/icon.png',
  extraResources: [{ from: '.desktop-stage/runtime', to: 'runtime', filter: ['app/**/*', 'tools/**/*', 'browsers/**/*', '!browsers/.links{,/**/*}', 'node', 'node.exe', 'pnpm', 'pnpm.cmd', 'manifest.json', 'NODE-LICENSE', 'PNPM-LICENSE'] }],
  asar: true,
  npmRebuild: false,
  beforePack: async context => {
    const { join } = require('node:path');
    const { pathToFileURL } = require('node:url');
    const { Arch } = require('electron-builder');
    const { verifyStagedRuntime } = await import(pathToFileURL(join(context.packager.projectDir, 'scripts/desktop/stage.mjs')).href);
    await verifyStagedRuntime(context.packager.projectDir, { platform: context.electronPlatformName, arch: Arch[context.arch] });
  },
  artifactName: 'ColdX-${version}-${os}-${arch}.${ext}',
  win: { target: ['nsis'], executableName: 'ColdX' },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false, createDesktopShortcut: true, include: 'desktop/installer.nsh' },
  mac: { target: ['dmg', 'zip'], category: 'public.app-category.productivity', hardenedRuntime: Boolean(process.env.CSC_LINK || process.env.CSC_NAME) },
  linux: { target: ['AppImage', 'deb'], category: 'Development', maintainer: 'ColdX', executableName: 'coldx', desktop: { entry: { Name: 'ColdX', Comment: 'Generative workspace powered by DeepSeek Harness' } } },
};
