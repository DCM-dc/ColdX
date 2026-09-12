import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const json = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const project = await json('package.json');
assert.match(project.version, /^\d+\.\d+\.\d+$/u, 'ColdX release version must be a stable semver.');

for (const path of ['plugin/client/package.json', 'desktop/package.json', 'desktop/runtime/package.json', 'scripts/desktop/tools/package.json']) {
  const manifest = await json(path);
  assert.equal(manifest.version, project.version, `${path} must use the ColdX release version.`);
}
for (const path of ['desktop/runtime/package-lock.json', 'scripts/desktop/tools/package-lock.json']) {
  const lock = await json(path);
  assert.equal(lock.version, project.version, `${path} has a stale package version.`);
  for (const [entry, item] of Object.entries(lock.packages)) {
    if (item.name?.startsWith('coldx-')) assert.equal(item.version, project.version, `${path}: ${entry} has a stale local version.`);
  }
}

// These are original inputs, not outputs cached from a developer's checkout.
// The build recreates client.js, the PDF bundle, icons and license copies.
for (const path of ['plugin/client/assets/coldx-logo-source.png', 'scripts/build-brand-assets.mjs', 'plugin/client/build-pdf.mjs', 'desktop/installer.nsh', 'scripts/desktop/native-patches.mjs', 'scripts/desktop/package-manager.mjs']) {
  await access(new URL(path, root));
}
const ref = process.env.GITHUB_REF ?? '';
if (ref.startsWith('refs/tags/')) assert.equal(ref, `refs/tags/v${project.version}`, 'Release tag must match every ColdX package version.');
console.log(`ColdX ${project.version}: release metadata and source inputs verified.`);
