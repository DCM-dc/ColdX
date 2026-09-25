import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { nativeImport } from './native-helpers.mjs';

const require = createRequire(import.meta.url);
const dshRoot = resolve(require.resolve('@deepseek-ai/dsh/package.json'), '..');

async function readPreset(path) {
  const { parse } = await nativeImport('yaml');
  return parse(await readFile(path, 'utf8'), { logLevel: 'silent' });
}

function delegationTool(preset, id) {
  const delegation = preset.find(row => row.id === 'delegation');
  return delegation?.config?.find(row => row.id === id);
}

function fixtureLinkType() {
  return process.platform === 'win32' ? 'junction' : 'dir';
}

async function resolvedLinkTarget(path) {
  return resolve(dirname(path), await readlink(path));
}

async function createFixtureApp(root) {
  await mkdir(join(root, 'plugin', 'client'), { recursive: true });
  await mkdir(join(root, 'plugin', 'sidebar'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'plugin', 'client', 'package.json'), '{"name":"coldx-client","type":"module"}\n'),
    writeFile(join(root, 'plugin', 'host.mjs'), 'export function apply() {}\n'),
    writeFile(join(root, 'plugin', 'settings-host.mjs'), 'export function apply() {}\n'),
  ]);
}

test('native effective default preserves profile and home overrides across startup', async () => {
  const { ensureProfile } = await import('../lib/profile.mjs');
  const { buildDshArguments } = await import('../lib/launcher.mjs');
  const { loadProfile, loadOptionalPatches, loadOverlayPatches, composeEntries } = await nativeImport('@deepseek-ai/dsh-app-boot');
  const home = await mkdtemp(join(tmpdir(), 'coldx defaults '));
  try {
    const options = { home, dshRoot, projectRoot: resolve('.'), persona: 'You are ColdX.' };
    let profile = await ensureProfile(options);
    function effectiveRows() {
      const loaded = loadProfile('coldx-test', 'web', join(dshRoot, 'package.json'), home);
      const args = buildDshArguments({ ...profile, dshRoot, dump: true });
      const overlays = args.flatMap((arg, index) => arg === '--patch' ? [loadOverlayPatches('coldx-test', args[index + 1])] : []);
      return composeEntries([
        ...loaded.layers.map(layer => layer.patches), loaded.patches,
        loadOptionalPatches('coldx-test', join(home, 'cordis.patch.yml')) ?? [],
        ...overlays,
      ]);
    }
    function effectiveConfig(id) {
      return effectiveRows().find(row => row.id === id)?.config;
    }
    assert.equal(effectiveConfig('agent-presets').default, 'coldx', 'a fresh profile starts in ColdX');
    assert.deepEqual(effectiveConfig('agent-default-model'), {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    }, 'ColdX roots default to the canonical multimodal V4.1 Flash route');
    const deepseek = effectiveConfig('llm-deepseek');
    assert.equal(deepseek.defaultContextWindow, 1_000_000);
    assert.equal(deepseek.maxTokens, 384_000);
    assert.equal(deepseek.thinking, 'enabled');
    assert.equal(deepseek.reasoningEffort, 'high');
    assert.deepEqual(deepseek.models.find(model => model.id === 'deepseek-flash'), {
      id: 'deepseek-flash',
      name: 'DeepSeek-V4.1-Flash',
      description: '原生图片输入 · 1M 上下文',
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      inputModalities: ['text', 'image'],
      imageDetail: 'auto',
    });
    assert.deepEqual(deepseek.models.find(model => model.id === 'deepseek-v4-pro')?.inputModalities, ['text'],
      'V4 Pro stays text-only so Host admission rejects unsupported images');
    assert.deepEqual(deepseek.models.find(model => model.id === 'deepseek-v4-flash')?.inputModalities, ['text'],
      'legacy Flash does not inherit canonical image capabilities without provider evidence');
    const manifestPath = join(profile.profileDir, 'package.json');
    const legacy = JSON.parse(await readFile(manifestPath, 'utf8'));
    legacy.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
    legacy.description = 'User-authored profile metadata';
    await writeFile(manifestPath, JSON.stringify(legacy));
    await writeFile(join(profile.profileDir, 'cordis.patch.yml'), '# Your DSH profile overrides.\n');
    profile = await ensureProfile(options);
    assert.equal(effectiveConfig('agent-presets').default, 'coldx', 'an untouched old profile upgrades to valid native layers');
    assert.deepEqual(effectiveConfig('agent-default-model'), {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    }, 'the product route survives an old profile upgrade');
    const upgradedManifest = await readFile(manifestPath, 'utf8');
    const upgraded = JSON.parse(upgradedManifest);
    assert.equal(upgraded.description, 'User-authored profile metadata');
    assert.equal(upgraded.dsh.profile.bundles.filter(name => name === 'coldx-distribution').length, 1);
    const userPatch = [
      '- id: agent-presets',
      '  config:',
      '    default: profile-choice',
      '- id: agent-default-model',
      '  config:',
      '    provider: profile-provider',
      '    model: profile-model',
      '',
    ].join('\n');
    await writeFile(join(profile.profileDir, 'cordis.patch.yml'), userPatch);
    profile = await ensureProfile(options);
    assert.equal(effectiveConfig('agent-presets').default, 'profile-choice', 'the profile user layer outranks product defaults');
    assert.deepEqual(effectiveConfig('agent-default-model'), {
      provider: 'profile-provider',
      model: 'profile-model',
    }, 'the profile user layer can replace the product route');
    await writeFile(join(home, 'cordis.patch.yml'), [
      '- id: agent-presets',
      '  config:',
      '    default: home-choice',
      '- id: agent-default-model',
      '  config:',
      '    provider: home-provider',
      '    model: home-model',
      '',
    ].join('\n'));
    profile = await ensureProfile(options);
    assert.equal(effectiveConfig('agent-presets').default, 'home-choice', 'the home user layer remains highest priority');
    assert.deepEqual(effectiveConfig('agent-default-model'), {
      provider: 'home-provider',
      model: 'home-model',
    }, 'the home user layer remains the final model-route authority');
    assert.equal(await readFile(join(profile.profileDir, 'cordis.patch.yml'), 'utf8'), userPatch);
    assert.equal(await readFile(manifestPath, 'utf8'), upgradedManifest, 'repeat startup does not rewrite the migrated manifest');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('profile starts native web with the full Cordis preset and preserves user changes', async () => {
  const api = await import('../lib/profile.mjs').catch(() => ({}));
  assert.equal(typeof api.ensureProfile, 'function', 'profile initializer is available');
  const home = await mkdtemp(join(tmpdir(), 'coldx profile spaces '));
  try {
    const options = { home, dshRoot, projectRoot: resolve('.'), persona: 'You are ColdX.\nWorking directory {{cwd}}.' };
    const result = await api.ensureProfile(options);
    const manifest = JSON.parse(await readFile(join(home, 'profiles/web/package.json'), 'utf8'));
    assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'coldx-distribution']);
    const composition = await readFile(result.presetPath, 'utf8');
    const preset = await readPreset(result.presetPath);
    assert.match(composition, /You are ColdX/);
    assert.match(composition, /@deepseek-ai\/dsh-tool-cordis/);
    assert.match(composition, /@deepseek-ai\/dsh-tool-goal/);
    assert.match(composition, /@deepseek-ai\/dsh-tool-workflow/);
    assert.match(composition, /@deepseek-ai\/dsh-tool-pwsh/);
    assert.ok(!composition.includes('powered by the {{model}}'));
    assert.equal(delegationTool(preset, 'tool-subagent')?.config?.agentOptions, undefined,
      'fresh spawn subagents inherit the parent selected model');
    assert.equal(delegationTool(preset, 'tool-subagent-fork')?.config?.agentOptions, undefined,
      'fresh forked subagents inherit the parent selected model');
    assert.equal(delegationTool(preset, 'tool-subagent-codex')?.config?.agentOptions, undefined,
      'external subagent providers keep their own model routing');
    assert.equal(delegationTool(preset, 'tool-subagent-claude-code')?.config?.agentOptions, undefined,
      'external subagent providers keep their own model routing');
    const hostUrl = JSON.parse(composition.match(/- id: coldx-policy\s+name: (.+)/)[1]);
    assert.equal(new URL(hostUrl).protocol, 'file:', 'host plugin is importable on Windows');
    assert.equal(typeof (await import(hostUrl)).apply, 'function');
    const patch = JSON.parse(await readFile(result.patchPath, 'utf8'));
    assert.equal(patch.find(row=>row.id==='session-query-sqlite').config.openAt,'first-search','full-text search activates lazily without delaying startup');
    assert.equal(patch.find(row => row.id === 'agent-presets').config.default, 'coldx');
    assert.equal(patch.find(row => row.id === 'ui-brand-official').disabled, true);
    const inserted = patch.flatMap(row => row.insert ?? []);
    const computerHostUrl = inserted.find(row => row.id === 'coldx-computer')?.name;
    assert.equal(new URL(computerHostUrl).protocol, 'file:', 'computer capability is mounted globally before the first model tool list');
    assert.equal((await import(computerHostUrl)).name, 'coldx-computer');
    const codingModeHostUrl = inserted.find(row => row.id === 'coldx-coding-mode-persistence')?.name;
    assert.equal(new URL(codingModeHostUrl).protocol, 'file:', 'coding mode compatibility is installed in the global Host before history reads');
    const codingModeHost = await import(codingModeHostUrl);
    assert.equal(codingModeHost.name, 'coldx-coding-mode-persistence');
    const clientName = inserted.find(row => row.id === 'coldx-client')?.name;
    assert.equal(clientName, 'coldx-client', 'client graph requires a resolvable package name');
    assert.equal(typeof (await import(clientName)).apply, 'function');
    const settingsUrl = inserted.find(row => row.id === 'coldx-settings')?.name;
    assert.equal(new URL(settingsUrl).protocol, 'file:', 'global ColdX settings owner is an importable Host plugin');
    const marketplace=inserted.find(row=>row.id==='coldx-marketplace');
    assert.ok(marketplace,'marketplace is a Host-owned native contribution');
    assert.equal(new URL(marketplace.name).protocol,'file:');
    assert.equal(marketplace.config.profile,'web');
    const settingsPlugin = await import(settingsUrl);
    assert.equal(settingsPlugin.name, 'coldx-settings');
    assert.deepEqual(settingsPlugin.inject, ['settings']);
    const clientManifest = JSON.parse(await readFile(require.resolve(`${clientName}/package.json`), 'utf8'));
    assert.equal(clientManifest.dsh.client.platform, 'web');
    const profileRequire = createRequire(join(result.profileDir, 'package.json'));
    assert.ok(profileRequire.resolve('coldx-client/package.json'), 'custom homes can discover the client package');
    await writeFile(result.presetPath, `${composition}\n# user extension\n`);
    await writeFile(join(home, 'profiles/web/cordis.patch.yml'), '# user profile patch\n');
    await api.ensureProfile(options);
    assert.match(await readFile(result.presetPath, 'utf8'), /# user extension/);
    assert.equal(await readFile(join(home, 'profiles/web/cordis.patch.yml'), 'utf8'), '# user profile patch\n');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('profile migrates persisted in-process subagent tools without dropping user configuration', async () => {
  const { ensureProfile } = await import('../lib/profile.mjs');
  const { stringify } = await nativeImport('yaml');
  const home = await mkdtemp(join(tmpdir(), 'coldx subagent migration '));
  try {
    const options = { home, dshRoot, projectRoot: resolve('.'), persona: 'You are ColdX.' };
    const result = await ensureProfile(options);
    const legacy = await readPreset(result.presetPath);
    const spawn = delegationTool(legacy, 'tool-subagent');
    const fork = delegationTool(legacy, 'tool-subagent-fork');
    spawn.config.agentOptions = { model: 'deepseek-v4-flash' };
    spawn.userLabel = 'keep spawn row metadata';
    spawn.config.userSetting = { concurrency: 3 };
    fork.agentLabel = 'keep fork row metadata';
    fork.config.agentOptions = { provider: 'custom-provider', model: 'custom-model', maxTokens: 1000 };
    fork.config.userFlag = true;
    await writeFile(result.presetPath, stringify(legacy));

    await ensureProfile(options);
    const migratedText = await readFile(result.presetPath, 'utf8');
    const migrated = await readPreset(result.presetPath);
    const migratedSpawn = delegationTool(migrated, 'tool-subagent');
    const migratedFork = delegationTool(migrated, 'tool-subagent-fork');
    assert.equal(migratedSpawn.config.agentOptions, undefined, 'remove the obsolete product model override');
    assert.equal(migratedSpawn.config.provider, 'spawn');
    assert.equal(migratedSpawn.userLabel, 'keep spawn row metadata');
    assert.deepEqual(migratedSpawn.config.userSetting, { concurrency: 3 });
    assert.deepEqual(migratedFork.config.agentOptions, {
      provider: 'custom-provider', model: 'custom-model', maxTokens: 1000,
    });
    assert.equal(migratedFork.config.provider, 'fork');
    assert.equal(migratedFork.agentLabel, 'keep fork row metadata');
    assert.equal(migratedFork.config.userFlag, true);
    assert.equal(migratedFork.config.agentOptions.provider, 'custom-provider', 'an explicit user route remains untouched');

    await ensureProfile(options);
    assert.equal(await readFile(result.presetPath, 'utf8'), migratedText, 'repeat startup is byte-for-byte idempotent');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('profile refreshes only ColdX-managed links and policy URL after the packaged app moves', async () => {
  const { ensureProfile } = await import('../lib/profile.mjs');
  const temp = await mkdtemp(join(tmpdir(), 'coldx packaged relocation '));
  const home = join(temp, 'user data');
  const firstRoot = join(temp, 'ColdX v1');
  const secondRoot = join(temp, 'ColdX v2 moved');
  try {
    await Promise.all([createFixtureApp(firstRoot), createFixtureApp(secondRoot)]);
    const options = { home, dshRoot, projectRoot: firstRoot, persona: 'You are ColdX.' };
    const first = await ensureProfile(options);
    const nodeModules = join(first.profileDir, 'node_modules');
    const clientLink = join(nodeModules, 'coldx-client');
    const distributionLink = join(nodeModules, 'coldx-distribution');
    const oldHostUrl = pathToFileURL(join(firstRoot, 'plugin', 'host.mjs')).href;
    const staleDistribution = join(temp, 'stale distribution target');
    await mkdir(staleDistribution);
    await unlink(distributionLink);
    await symlink(staleDistribution, distributionLink, fixtureLinkType());
    await writeFile(first.presetPath, `${await readFile(first.presetPath, 'utf8')}\n- id: user-policy-copy\n  name: ${JSON.stringify(oldHostUrl)}\n  config: { keep: true }\n`);

    const moved = await ensureProfile({ ...options, projectRoot: secondRoot });
    assert.equal(await resolvedLinkTarget(clientLink), resolve(secondRoot, 'plugin', 'client'));
    assert.equal(await resolvedLinkTarget(join(nodeModules,'@deepseek-ai','dsh-client-ui-sidebar')), resolve(secondRoot,'plugin','sidebar'));
    assert.equal(await resolvedLinkTarget(distributionLink), resolve(home, 'coldx-distribution'));
    const migrated = await readPreset(moved.presetPath);
    const newHostUrl = pathToFileURL(join(secondRoot, 'plugin', 'host.mjs')).href;
    assert.equal(migrated.find(row => row.id === 'coldx-policy')?.name, newHostUrl,
      'the product-owned policy follows the packaged runtime');
    assert.equal(migrated.find(row => row.id === 'user-policy-copy')?.name, oldHostUrl,
      'a different row that references the old module remains user-owned');

    const customPolicy = 'file:///user/custom-policy.mjs';
    const migratedText = await readFile(moved.presetPath, 'utf8');
    await writeFile(moved.presetPath, migratedText.replace(JSON.stringify(newHostUrl), JSON.stringify(customPolicy)));
    await ensureProfile({ ...options, projectRoot: firstRoot });
    assert.equal((await readPreset(moved.presetPath)).find(row => row.id === 'coldx-policy')?.name, customPolicy,
      'a user-replaced policy module is not taken back over');
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('profile refuses to replace a user-owned directory at a managed link path', async () => {
  const { ensureProfile } = await import('../lib/profile.mjs');
  const temp = await mkdtemp(join(tmpdir(), 'coldx managed path conflict '));
  const home = join(temp, 'user data');
  const projectRoot = join(temp, 'ColdX app');
  try {
    await createFixtureApp(projectRoot);
    const options = { home, dshRoot, projectRoot, persona: 'You are ColdX.' };
    const result = await ensureProfile(options);
    const clientPath = join(result.profileDir, 'node_modules', 'coldx-client');
    await unlink(clientPath);
    await mkdir(clientPath);
    await writeFile(join(clientPath, 'keep.txt'), 'user-owned');

    await assert.rejects(ensureProfile(options), error => {
      assert.match(error.message, /coldx-client/);
      assert.match(error.message, /not a symbolic link/i);
      return true;
    });
    assert.equal((await lstat(clientPath)).isDirectory(), true);
    assert.equal(await readFile(join(clientPath, 'keep.txt'), 'utf8'), 'user-owned');
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('command arguments preserve paths and loopback binding without a shell', async () => {
  const api = await import('../lib/launcher.mjs').catch(() => ({}));
  assert.equal(typeof api.parseArguments, 'function', 'launcher argument parser is available');
  const parsed = api.parseArguments(['--home', 'C:/a b/home', '--cwd', 'C:/my workspace', '--port', '0', '--no-open']);
  assert.equal(parsed.home, 'C:/a b/home');
  assert.equal(parsed.cwd, 'C:/my workspace');
  assert.equal(parsed.port, 0);
  assert.equal(parsed.open, false);
  const command = api.buildDshArguments({ dshRoot: 'C:/a b/dsh', ...parsed });
  assert.equal(command[0], join('C:/a b/dsh', 'lib', 'bin.js'));
  assert.deepEqual(command.slice(-5), ['--host', '127.0.0.1', '--port', '0', '--no-open']);
  assert.throws(() => api.parseArguments(['--port', '65536']), /port/i);
  assert.throws(() => api.parseArguments(['--port']), /port/i);
  assert.throws(() => api.parseArguments(['--oops']), /Unknown/);
});

test('profile migrates the legacy ColdX persona once and preserves a user-owned replacement', async () => {
  const { ensureProfile } = await import('../lib/profile.mjs');
  const home = await mkdtemp(join(tmpdir(), 'coldx persona migration '));
  try {
    const options = { home, dshRoot, projectRoot: resolve('.'), persona: 'You are ColdX v2.' };
    const result = await ensureProfile(options);
    let preset = await readFile(result.presetPath, 'utf8');
    const personaBlock = /^- id: persona\r?\n[\s\S]*?(?=^- id: agent-instructions\r?$)/m;
    const legacy = `- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    text: "You are ColdX, a capable AI collaborator working with the user in a generative Web workspace powered by DeepSeek Harness. Your current model is {{model}} and your working directory is {{cwd}}."\n\n`;
    await writeFile(result.presetPath, preset.replace(personaBlock, legacy) + '# keep extension\n');
    await ensureProfile(options);
    preset = await readFile(result.presetPath, 'utf8');
    const migratedPersona = preset.match(personaBlock)?.[0] ?? '';
    assert.match(migratedPersona, /coldx-managed-persona/);
    assert.match(migratedPersona, /You are ColdX v2/);
    assert.doesNotMatch(migratedPersona, /\{\{model\}\}|\{\{cwd\}\}/);
    assert.match(preset, /# keep extension/);

    const custom = `- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    text: "My private custom persona."\n\n`;
    await writeFile(result.presetPath, preset.replace(personaBlock, custom));
    await ensureProfile({ ...options, persona: 'You are ColdX v3.' });
    preset = await readFile(result.presetPath, 'utf8');
    assert.match(preset, /My private custom persona/);
    assert.doesNotMatch(preset, /You are ColdX v3/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
