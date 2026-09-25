import { cp, lstat, mkdir, readFile, readlink, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function writeNew(path, content) {
  try { await writeFile(path, content, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

function samePath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function ensureManagedDirectoryLink(linkPath, targetPath) {
  const target = await lstat(targetPath).catch(error => {
    throw new Error(`ColdX managed link target "${targetPath}" is unavailable: ${error.message}`, { cause: error });
  });
  if (!target.isDirectory()) throw new Error(`ColdX managed link target "${targetPath}" is not a directory.`);
  let entry;
  try { entry = await lstat(linkPath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await symlink(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return;
  }
  if (!entry.isSymbolicLink()) {
    throw new Error(`ColdX managed path "${linkPath}" exists but is not a symbolic link; refusing to replace the user-owned path.`);
  }
  const currentTarget = resolve(dirname(linkPath), await readlink(linkPath));
  if (samePath(currentTarget, targetPath)) return;
  // unlink removes only the junction/symlink itself. Its old target remains intact.
  await unlink(linkPath);
  await symlink(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

const LEGACY_SUBAGENT_MODEL = 'deepseek-v4-flash';
const IN_PROCESS_SUBAGENT_TOOLS = ['tool-subagent', 'tool-subagent-fork'];
const DEEPSEEK_NATIVE_MODELS = [
  {
    id: 'deepseek-flash',
    name: 'DeepSeek-V4.1-Flash',
    description: '原生图片输入 · 1M 上下文',
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    inputModalities: ['text', 'image'],
    imageDetail: 'auto',
  },
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek-V4-Flash',
    description: '历史会话兼容入口 · 文本输入',
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    inputModalities: ['text'],
  },
  {
    id: 'deepseek-v4-flash-vision-exp',
    name: 'DeepSeek-V4-Flash-Vision-Exp',
    description: '历史 Vision 入口 · 需提供方支持',
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    inputModalities: ['text', 'image'],
    imageDetail: 'auto',
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    description: '高质量文本推理 · 不支持图片输入',
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    inputModalities: ['text'],
  },
];

function splitYamlLines(source) {
  const lines = source.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? [];
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function yamlLineText(line) {
  return line.replace(/\r\n$|\n$|\r$/, '');
}

function yamlLineEnding(line, fallback) {
  return line.match(/\r\n$|\n$|\r$/)?.[0] ?? fallback;
}

function yamlScalarAndSuffix(source) {
  let quote;
  let escaped = false;
  let commentIndex = source.length;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quote = undefined;
    } else if (quote === "'") {
      if (character === "'" && source[index + 1] === "'") index += 1;
      else if (character === "'") quote = undefined;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '#' && (index === 0 || /\s/.test(source[index - 1]))) {
      commentIndex = index;
      break;
    }
  }
  const beforeComment = source.slice(0, commentIndex);
  const token = beforeComment.trim();
  if (!token) return undefined;
  let value;
  try {
    if (token.startsWith('"') && token.endsWith('"')) value = JSON.parse(token);
    else if (token.startsWith("'") && token.endsWith("'")) value = token.slice(1, -1).replaceAll("''", "'");
    else value = token;
  } catch { return undefined; }
  const tokenEnd = beforeComment.lastIndexOf(token) + token.length;
  return { value, suffix: beforeComment.slice(tokenEnd) + source.slice(commentIndex) };
}

// Refresh only the row ColdX originally generated and only while it still
// points at a packaged plugin/host.mjs. Other plugin rows and user replacements
// remain untouched byte-for-byte.
function refreshManagedPolicyUrl(source, hostEntry) {
  const lines = splitYamlLines(source);
  for (let rowIndex = 0; rowIndex < lines.length; rowIndex += 1) {
    const rowText = yamlLineText(lines[rowIndex]);
    const row = rowText.match(/^(\s*)- id:\s*(?:coldx-policy|"coldx-policy"|'coldx-policy')\s*(?:#.*)?$/);
    if (!row) continue;
    const rowIndent = row[1];
    let rowEnd = lines.length;
    for (let index = rowIndex + 1; index < lines.length; index += 1) {
      const text = yamlLineText(lines[index]);
      if (!text.trim() || text.trimStart().startsWith('#')) continue;
      const indent = text.match(/^\s*/)?.[0] ?? '';
      if (indent.length < rowIndent.length || (indent === rowIndent && text.slice(indent.length).startsWith('- '))) {
        rowEnd = index;
        break;
      }
    }
    for (let index = rowIndex + 1; index < rowEnd; index += 1) {
      const text = yamlLineText(lines[index]);
      const name = text.match(/^(\s*name:\s*)(.*)$/);
      if (!name || (name[1].match(/^\s*/)?.[0] ?? '') !== `${rowIndent}  `) continue;
      const scalar = yamlScalarAndSuffix(name[2]);
      if (typeof scalar?.value !== 'string' || !scalar.value.endsWith('/plugin/host.mjs')) break;
      const ending = yamlLineEnding(lines[index], source.includes('\r\n') ? '\r\n' : '\n');
      lines[index] = `${name[1]}${JSON.stringify(hostEntry)}${scalar.suffix}${ending}`;
      break;
    }
  }
  return lines.join('');
}

// Patch only the two product-owned rows. Parsing and re-stringifying the full
// Cordis file would rewrite user comments and its executable `!!js` scalars.
function removeLegacySubagentModel(source, toolId) {
  const lines = splitYamlLines(source);
  const fallbackEol = source.includes('\r\n') ? '\r\n' : '\n';
  const rowMatch = lines.map(yamlLineText)
    .map(line => line.match(/^(\s*)- id:\s*(\S+)\s*(?:#.*)?$/))
    .find(match => match?.[2] === toolId);
  if (!rowMatch) return source;
  const rowIndex = lines.findIndex(line => yamlLineText(line).match(/^(\s*)- id:\s*(\S+)\s*(?:#.*)?$/)?.[2] === toolId);
  const rowIndent = rowMatch[1];
  let rowEnd = lines.length;
  for (let index = rowIndex + 1; index < lines.length; index += 1) {
    const text = yamlLineText(lines[index]);
    if (!text.trim() || text.trimStart().startsWith('#')) continue;
    const indent = text.match(/^\s*/)?.[0] ?? '';
    if (indent.length < rowIndent.length || (indent === rowIndent && text.slice(indent.length).startsWith('- '))) {
      rowEnd = index;
      break;
    }
  }

  const configIndent = `${rowIndent}  `;
  const configIndex = lines.findIndex((line, index) => index > rowIndex && index < rowEnd
    && new RegExp(`^${configIndent}config:\\s*(?:#.*)?$`).test(yamlLineText(line)));
  if (configIndex < 0) return source;

  const optionsIndent = `${configIndent}  `;
  const optionsIndex = lines.findIndex((line, index) => index > configIndex && index < rowEnd
    && new RegExp(`^${optionsIndent}agentOptions:`).test(yamlLineText(line)));
  if (optionsIndex < 0) return source;

  const optionsText = yamlLineText(lines[optionsIndex]);
  const flowOptions = optionsText.match(new RegExp(`^${optionsIndent}agentOptions:\\s*\\{(.*)\\}\\s*(#.*)?$`));
  if (flowOptions) {
    // Only the exact model-only map generated by older ColdX versions is
    // unambiguously ours. Custom flow maps stay byte-for-byte unchanged.
    const legacy = flowOptions[1].match(/^\s*model\s*:\s*(.*?)\s*$/);
    if (yamlScalarAndSuffix(legacy?.[1] ?? '')?.value !== LEGACY_SUBAGENT_MODEL) return source;
    const ending = yamlLineEnding(lines[optionsIndex], fallbackEol);
    if (flowOptions[2]) lines[optionsIndex] = `${optionsIndent}${flowOptions[2]}${ending}`;
    else lines.splice(optionsIndex, 1);
    return lines.join('');
  }

  if (!new RegExp(`^${optionsIndent}agentOptions:\\s*(?:#.*)?$`).test(optionsText)) return source;
  let optionsEnd = rowEnd;
  for (let index = optionsIndex + 1; index < rowEnd; index += 1) {
    const text = yamlLineText(lines[index]);
    if (!text.trim() || text.trimStart().startsWith('#')) continue;
    const indent = text.match(/^\s*/)?.[0] ?? '';
    if (indent.length <= optionsIndent.length) {
      optionsEnd = index;
      break;
    }
  }
  const modelIndent = `${optionsIndent}  `;
  const modelIndex = lines.findIndex((line, index) => index > optionsIndex && index < optionsEnd
    && new RegExp(`^${modelIndent}model:`).test(yamlLineText(line)));
  if (modelIndex < 0) return source;
  const optionRows = lines.slice(optionsIndex + 1, optionsEnd).map(yamlLineText)
    .filter(line => line.trim() && !line.trimStart().startsWith('#'));
  if (optionRows.length !== 1) return source;
  const modelText = yamlLineText(lines[modelIndex]);
  const scalar = yamlScalarAndSuffix(modelText.slice(`${modelIndent}model:`.length));
  if (scalar?.value !== LEGACY_SUBAGENT_MODEL) return source;
  const ending = yamlLineEnding(lines[modelIndex], fallbackEol);
  const comment = scalar.suffix.trim();
  if (comment) lines[modelIndex] = `${optionsIndent}${comment}${ending}`;
  else lines.splice(modelIndex, 1);
  const optionsComment = optionsText.match(/\s+(#.*)$/)?.[1];
  if (optionsComment) lines[optionsIndex] = `${optionsIndent}${optionsComment}${ending}`;
  else lines.splice(optionsIndex, 1);
  return lines.join('');
}

function configureInProcessSubagents(source) {
  return IN_PROCESS_SUBAGENT_TOOLS.reduce(removeLegacySubagentModel, source);
}

/** Compose native DSH layers; preserve the profile and home user overrides. */
export async function ensureProfile({ home, dshRoot, projectRoot, persona }) {
  home = resolve(home);
  const profileDir = join(home, 'profiles', 'web');
  const presetDir = join(home, '.agent-presets', 'coldx');
  const generatedDir = join(home, 'coldx-distribution');
  await Promise.all([profileDir, presetDir, generatedDir].map(path => mkdir(path, { recursive: true })));
  // Product defaults are a bundle layer, before both native user patch layers.
  // A CLI --patch would run after those layers and silently override the user.
  const bundleName = 'coldx-distribution';
  await writeFile(join(generatedDir, 'package.json'), JSON.stringify({
    name: bundleName, private: true, dsh: { bundle: { patch: './web.patch.json' } },
  }, null, 2) + '\n');
  const manifestPath = join(profileDir, 'package.json');
  await writeNew(manifestPath, JSON.stringify({
    name: 'coldx-profile-web', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', bundleName] } },
  }, null, 2) + '\n');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const bundles = manifest.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) throw new Error('ColdX profile must declare dsh.profile.bundles.');
  if (!bundles.includes(bundleName)) {
    // Upgrade the old two-bundle profile without dropping user manifest fields
    // or changing the relative order of any user-added bundles.
    const webIndex = bundles.indexOf('@deepseek-ai/dsh-web-app');
    bundles.splice(webIndex < 0 ? bundles.length : webIndex + 1, 0, bundleName);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
  const userPatchPath = join(profileDir, 'cordis.patch.yml');
  const emptyTemplate = '# Your DSH profile overrides.\n';
  await writeNew(userPatchPath, emptyTemplate + '[]\n');
  // Only the untouched old template is migrated. Comment-only YAML is not a
  // patch array, and DSH rejects it before a fresh profile can start.
  if ((await readFile(userPatchPath, 'utf8')).replaceAll('\r\n', '\n') === emptyTemplate) {
    await writeFile(userPatchPath, emptyTemplate + '[]\n');
  }
  // The native client module scanner resolves package metadata from the profile,
  // including when --home points outside this application's directory tree.
  await mkdir(join(profileDir, 'node_modules'), { recursive: true });
  await ensureManagedDirectoryLink(join(profileDir, 'node_modules', 'coldx-client'), join(projectRoot, 'plugin', 'client'));
  // One owner declares the sidebar's children. Replace just this presentation
  // package at the managed profile boundary; native workspace/settings plug-ins
  // continue using the same public seats and lifecycle.
  await mkdir(join(profileDir, 'node_modules', '@deepseek-ai'), {recursive:true});
  await ensureManagedDirectoryLink(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-client-ui-sidebar'), join(projectRoot, 'plugin', 'sidebar'));
  await ensureManagedDirectoryLink(join(profileDir, 'node_modules', bundleName), generatedDir);
  const shippedPresets = join(dshRoot, 'config', 'agent-presets');
  const shippedCordis = join(shippedPresets, 'cordis');
  const composition = await readFile(join(shippedCordis, 'agent.cordis.yml'), 'utf8');
  const managedPersonaMarker = '# coldx-managed-persona';
  const personaRow = `- id: persona\n  ${managedPersonaMarker}\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    text: ${JSON.stringify(persona)}\n\n`;
  const marker = /^- id: persona\r?\n[\s\S]*?(?=^- id: agent-instructions\r?$)/m;
  if (!marker.test(composition)) throw new Error('Pinned DSH Cordis preset changed: persona boundary was not found.');
  const hostEntry = pathToFileURL(join(projectRoot, 'plugin', 'host.mjs')).href;
  const presetPath = join(presetDir, 'agent.cordis.yml');
  await writeNew(presetPath, configureInProcessSubagents(composition.replace(marker, personaRow)
    + `\n- id: coldx-policy\n  name: ${JSON.stringify(hostEntry)}\n`));
  // ColdX v1 wrote model and cwd placeholders into the persisted persona. Migrate
  // that exact product-owned row (and later marked rows) without touching a
  // persona the user replaced themselves.
  const legacyPersona = 'You are ColdX, a capable AI collaborator working with the user in a generative Web workspace powered by DeepSeek Harness. Your current model is {{model}} and your working directory is {{cwd}}.';
  const persistedPreset = await readFile(presetPath, 'utf8');
  const persistedPersona = persistedPreset.match(marker)?.[0];
  let migratedPreset = persistedPreset;
  if (persistedPersona && (persistedPersona.includes(managedPersonaMarker) || persistedPersona.includes(legacyPersona))) {
    migratedPreset = migratedPreset.replace(marker, personaRow);
  }
  migratedPreset = configureInProcessSubagents(migratedPreset);
  migratedPreset = refreshManagedPolicyUrl(migratedPreset, hostEntry);
  if (migratedPreset !== persistedPreset) await writeFile(presetPath, migratedPreset);
  await writeNew(join(presetDir, 'preset.yml'), 'name: ColdX 创造工作台\ndescription: 自主补足能力、生成交互界面、组织任务循环。\norder: 0\n');
  await cp(join(shippedCordis, 'skills'), join(presetDir, 'skills'), { recursive: true, force: false, errorOnExist: false });
  const patchPath = join(generatedDir, 'web.patch.json');
  const settingsEntry = pathToFileURL(join(projectRoot, 'plugin', 'settings-host.mjs')).href;
  const filesEntry = pathToFileURL(join(projectRoot, 'plugin', 'file-import-host.mjs')).href;
  const terminalEntry = pathToFileURL(join(projectRoot, 'plugin', 'terminal-host.mjs')).href;
  const computerEntry = pathToFileURL(join(projectRoot, 'plugin', 'computer-host.mjs')).href;
  const pdfViewEntry = pathToFileURL(join(projectRoot, 'plugin', 'pdf-view-host.mjs')).href;
  const codingModePersistenceEntry = pathToFileURL(join(projectRoot, 'plugin', 'coding-mode-persistence-host.mjs')).href;
  const marketplaceEntry = pathToFileURL(join(projectRoot, 'plugin', 'marketplace-host.mjs')).href;
  const superpowersEntry = pathToFileURL(join(projectRoot, 'plugin', 'superpowers-host.mjs')).href;
  const usageEntry = pathToFileURL(join(projectRoot, 'plugin', 'usage-host.mjs')).href;
  const updatesEntry = pathToFileURL(join(projectRoot, 'plugin', 'updates-host.mjs')).href;
  const kernelEntry = pathToFileURL(join(projectRoot, 'plugin', 'kernel-host.mjs')).href;
  const workbenchEntry = pathToFileURL(join(projectRoot, 'plugin', 'workbench-host.mjs')).href;
  const companionEntry = pathToFileURL(join(projectRoot, 'plugin', 'companion-host.mjs')).href;
  const patch = [
    {insert:[{id:'coldx-workbench',name:workbenchEntry}]},
    {id:'session-query-sqlite',config:{openAt:'first-search',path:join(generatedDir,'session-search.sqlite')}},
    {
      id: 'llm-deepseek',
      config: {
        models: DEEPSEEK_NATIVE_MODELS,
        maxTokens: 384_000,
        defaultContextWindow: 1_000_000,
        thinking: 'enabled',
        reasoningEffort: 'high',
      },
    },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } },
    { id: 'agent-presets', config: { default: 'coldx', roots: [{ path: shippedPresets, trust: 'system' }], includeUserRoot: true } },
    { id: 'ui-brand-official', disabled: true },
    { insert: [{ id: 'coldx-coding-mode-persistence', name: codingModePersistenceEntry }, { id: 'coldx-client', name: 'coldx-client' }, { id: 'coldx-settings', name: settingsEntry }, { id: 'coldx-files', name: filesEntry }, { id:'coldx-terminal-stream', name:terminalEntry }, { id: 'coldx-computer', name: computerEntry }, {id:'coldx-pdf-view',name:pdfViewEntry}, {id:'coldx-marketplace',name:marketplaceEntry,config:{home,profile:'web',profileDir}}] },
    { insert: [{id:'coldx-kernel',name:kernelEntry}, {id:'coldx-companion',name:companionEntry,config:{profileDir}}, {id:'coldx-superpowers',name:superpowersEntry,config:{home,profileDir}}, {id:'coldx-usage',name:usageEntry,config:{profileDir}}, {id:'coldx-updates',name:updatesEntry,config:{profileDir}}] },
  ];
  await writeFile(patchPath, JSON.stringify(patch, null, 2) + '\n');
  return { home, profileDir, presetPath, patchPath };
}
