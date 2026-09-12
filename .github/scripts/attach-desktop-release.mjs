import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, inflateRawSync } from 'node:zlib';

const repository = 'DCM-dc/ColdX';
const apiRoot = `https://api.github.com/repos/${repository}`;
const maximumBytes = 512 * 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const validSha = value => typeof value === 'string' && /^[a-f\d]{40}$/.test(value);
const validId = value => Number.isSafeInteger(value) && value > 0;

function inputs(env) {
  const id = key => {
    assert.match(env[key] ?? '', /^[1-9]\d*$/, `${key} must be a positive integer.`);
    const value = Number(env[key]);
    assert.ok(validId(value), `${key} exceeds the safe integer boundary.`);
    return value;
  };
  const token = env.GITHUB_TOKEN;
  assert.ok(typeof token === 'string' && token.length > 0 && token.length <= 4096 && !/\s/.test(token), 'GITHUB_TOKEN is required.');
  const tag = env.COLDX_RELEASE_TAG ?? '';
  assert.ok(tag.length <= 100, 'Release tag is too long.');
  assert.match(tag, /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[a-zA-Z\d]+(?:[.-][a-zA-Z\d]+)*)?$/, 'Release tag must be vMAJOR.MINOR.PATCH with an optional prerelease.');
  const commit = env.COLDX_RELEASE_COMMIT;
  assert.ok(validSha(commit), 'COLDX_RELEASE_COMMIT must be a full lowercase commit SHA.');
  return { token, tag, commit, runId: id('COLDX_BUILD_RUN_ID'), releaseId: id('COLDX_DRAFT_RELEASE_ID'), expectedName: `ColdX-${tag.slice(1)}-win-x64.exe` };
}

function checkExtraFields(extra) {
  for (let offset = 0; offset < extra.length;) {
    assert.ok(offset + 4 <= extra.length, 'Truncated ZIP extra field.');
    const type = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    assert.notEqual(type, 1, 'ZIP64 is not supported.');
    assert.ok(offset + 4 + size <= extra.length, 'Truncated ZIP extra field.');
    offset += 4 + size;
  }
}

// The artifact must contain exactly one root-level installer. No path-based
// extraction takes place; directory/local headers, CRC, and PE are checked here.
export function extractSingleInstaller(archive, expectedName) {
  assert.ok(Buffer.isBuffer(archive) && archive.length >= 22 && archive.length <= maximumBytes, 'Invalid ZIP size.');
  assert.match(expectedName, /^ColdX-[a-zA-Z\d.-]+-win-x64\.exe$/, 'Invalid expected installer name.');
  let eocd = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65557); offset--) {
    if (archive.readUInt32LE(offset) === 0x06054b50 && offset + 22 + archive.readUInt16LE(offset + 20) === archive.length) { eocd = offset; break; }
  }
  assert.ok(eocd >= 0, 'ZIP directory is missing.');
  assert.equal(archive.readUInt16LE(eocd + 4), 0, 'Multipart ZIP is not supported.');
  assert.equal(archive.readUInt16LE(eocd + 6), 0, 'Multipart ZIP is not supported.');
  assert.equal(archive.readUInt16LE(eocd + 8), 1, 'Expected exactly one ZIP entry.');
  assert.equal(archive.readUInt16LE(eocd + 10), 1, 'Expected exactly one ZIP entry.');
  const centralSize = archive.readUInt32LE(eocd + 12);
  const central = archive.readUInt32LE(eocd + 16);
  assert.ok(central >= 30 && centralSize >= 46 && central + centralSize === eocd, 'Invalid ZIP directory extent.');
  assert.equal(archive.readUInt32LE(central), 0x02014b50, 'Invalid ZIP directory.');
  assert.ok(archive.readUInt16LE(central + 6) <= 20, 'Unsupported ZIP version.');
  const flags = archive.readUInt16LE(central + 8);
  const method = archive.readUInt16LE(central + 10);
  const checksum = archive.readUInt32LE(central + 16);
  const compressedSize = archive.readUInt32LE(central + 20);
  const size = archive.readUInt32LE(central + 24);
  const nameLength = archive.readUInt16LE(central + 28);
  const extraLength = archive.readUInt16LE(central + 30);
  const commentLength = archive.readUInt16LE(central + 32);
  const attributes = archive.readUInt32LE(central + 38);
  assert.equal(flags & ~0x080e, 0, 'Encrypted or unsupported ZIP flags.');
  assert.ok(method === 0 || method === 8, 'Unsupported ZIP compression.');
  assert.ok(method === 8 || (flags & 6) === 0, 'Invalid stored ZIP flags.');
  assert.equal(archive.readUInt16LE(central + 34), 0, 'Multipart ZIP is not supported.');
  assert.equal(archive.readUInt32LE(central + 42), 0, 'Unexpected ZIP prefix/local offset.');
  assert.ok(((attributes >>> 16) & 0xf000) === 0 || ((attributes >>> 16) & 0xf000) === 0x8000, 'ZIP entry must be a regular file.');
  assert.equal(attributes & 0x10, 0, 'ZIP directory entry is not allowed.');
  assert.equal(centralSize, 46 + nameLength + extraLength + commentLength, 'Unexpected ZIP directory data.');
  const name = archive.subarray(central + 46, central + 46 + nameLength);
  assert.ok(name.equals(Buffer.from(expectedName)), 'Unexpected file name or path in ZIP.');
  assert.ok(size >= 64 && size <= maximumBytes, 'Installer exceeds extraction boundary or is too small.');
  assert.ok(compressedSize > 0 && compressedSize <= maximumBytes, 'Invalid compressed installer size.');
  checkExtraFields(archive.subarray(central + 46 + nameLength, central + 46 + nameLength + extraLength));
  assert.equal(archive.readUInt32LE(0), 0x04034b50, 'Invalid ZIP local header.');
  assert.equal(archive.readUInt16LE(4), archive.readUInt16LE(central + 6), 'ZIP version mismatch.');
  assert.equal(archive.readUInt16LE(6), flags, 'ZIP flags mismatch.');
  assert.equal(archive.readUInt16LE(8), method, 'ZIP compression mismatch.');
  const localNameLength = archive.readUInt16LE(26);
  const localExtraLength = archive.readUInt16LE(28);
  const payloadStart = 30 + localNameLength + localExtraLength;
  const payloadEnd = payloadStart + compressedSize;
  assert.ok(payloadEnd <= central, 'ZIP payload overlaps directory.');
  assert.ok(archive.subarray(30, 30 + localNameLength).equals(name), 'ZIP local path mismatch.');
  checkExtraFields(archive.subarray(30 + localNameLength, payloadStart));
  if (flags & 8) {
    const descriptorSize = central - payloadEnd;
    assert.ok(descriptorSize === 12 || descriptorSize === 16, 'Invalid ZIP data descriptor size.');
    if (descriptorSize === 16) assert.equal(archive.readUInt32LE(payloadEnd), 0x08074b50, 'Invalid ZIP data descriptor signature.');
    const descriptor = central - 12;
    assert.equal(archive.readUInt32LE(descriptor), checksum, 'ZIP descriptor CRC mismatch.');
    assert.equal(archive.readUInt32LE(descriptor + 4), compressedSize, 'ZIP descriptor size mismatch.');
    assert.equal(archive.readUInt32LE(descriptor + 8), size, 'ZIP descriptor size mismatch.');
    for (const [offset, value] of [[14, checksum], [18, compressedSize], [22, size]]) {
      assert.ok(archive.readUInt32LE(offset) === 0 || archive.readUInt32LE(offset) === value, 'ZIP local descriptor metadata mismatch.');
    }
  } else {
    assert.equal(payloadEnd, central, 'Unexpected bytes after ZIP payload.');
    assert.equal(archive.readUInt32LE(14), checksum, 'ZIP local CRC mismatch.');
    assert.equal(archive.readUInt32LE(18), compressedSize, 'ZIP local compressed size mismatch.');
    assert.equal(archive.readUInt32LE(22), size, 'ZIP local size mismatch.');
  }
  const compressed = archive.subarray(payloadStart, payloadEnd);
  const result = method === 8 ? inflateRawSync(compressed, { maxOutputLength: size, info: true }) : null;
  if (result) assert.equal(result.engine.bytesWritten, compressedSize, 'Unexpected trailing compressed ZIP data.');
  const executable = result ? result.buffer : compressed;
  assert.equal(executable.length, size, 'Installer byte count mismatch.');
  assert.equal(crc32(executable), checksum, 'Installer CRC32 mismatch.');
  assert.equal(executable.toString('ascii', 0, 2), 'MZ', 'Installer is not a Windows executable.');
  const peOffset = executable.readUInt32LE(0x3c);
  assert.ok(peOffset >= 64 && peOffset <= executable.length - 4 && executable.readUInt32LE(peOffset) === 0x4550, 'Installer PE signature is invalid.');
  return executable;
}

export async function attachDesktopRelease({ env = process.env, fetchImpl = fetch } = {}) {
  const { token, tag, commit, runId, releaseId, expectedName } = inputs(env);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ColdX-draft-release-attacher' };
  const request = async (url, options = {}) => {
    try { return await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(300000), ...options }); }
    catch { throw new Error('GitHub or artifact transport failed; no automatic mutation retry was attempted.'); }
  };
  const api = async path => {
    const response = await request(`${apiRoot}${path}`, { headers, signal: AbortSignal.timeout(60000) });
    assert.ok(response.ok, `GitHub metadata request failed (${response.status}).`);
    return response.json();
  };
  const checkDraft = async () => {
    const release = await api(`/releases/${releaseId}`);
    assert.equal(release.id, releaseId, 'Release ID mismatch.');
    assert.equal(release.tag_name, tag, 'Release tag mismatch.');
    assert.equal(release.target_commitish, commit, 'Release target commit mismatch.');
    assert.equal(release.draft, true, 'Release is no longer a draft.');
    return release;
  };
  const listAssets = async () => {
    const assets = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await api(`/releases/${releaseId}/assets?per_page=100&page=${page}`);
      assert.ok(Array.isArray(batch) && batch.length <= 100, 'Invalid release asset listing.');
      assets.push(...batch);
      if (batch.length < 100) return assets;
    }
    throw new Error('Release asset listing exceeds pagination boundary.');
  };
  const checkAsset = (asset, planned) => {
    assert.ok(validId(asset?.id), 'Invalid release asset ID.');
    assert.equal(asset.name, planned.name, 'Release asset name mismatch.');
    assert.equal(asset.state, 'uploaded', 'Release asset is not completely uploaded.');
    assert.equal(asset.size, planned.bytes.length, 'Release asset byte count mismatch.');
    assert.equal(asset.digest?.toLowerCase(), `sha256:${planned.sha256}`, 'Release asset SHA256 mismatch or missing digest; refusing replacement.');
    return asset;
  };
  const findExisting = (assets, planned) => {
    const matches = assets.filter(asset => asset.name === planned.name);
    assert.ok(matches.length <= 1, 'Duplicate release asset names; refusing replacement.');
    return matches.length ? checkAsset(matches[0], planned) : null;
  };

  const ref = await api(`/git/ref/tags/${encodeURIComponent(tag)}`);
  assert.equal(ref.ref, `refs/tags/${tag}`, 'Tag reference mismatch.');
  let object = ref.object;
  const visitedTags = new Set();
  while (object?.type === 'tag') {
    assert.ok(validSha(object.sha) && !visitedTags.has(object.sha) && visitedTags.size < 5, 'Invalid or excessive annotated tag chain.');
    visitedTags.add(object.sha);
    const annotated = await api(`/git/tags/${object.sha}`);
    assert.equal(annotated.sha, object.sha, 'Annotated tag SHA mismatch.');
    object = annotated.object;
  }
  assert.equal(object?.type, 'commit', 'Tag does not resolve to a commit.');
  assert.equal(object.sha, commit, 'Tag commit mismatch.');
  const run = await api(`/actions/runs/${runId}`);
  assert.equal(run.id, runId, 'Build run ID mismatch.');
  assert.equal(run.head_repository?.full_name, repository, 'Build head repository mismatch.');
  assert.equal(run.head_sha, commit, 'Build commit mismatch.');
  assert.equal(run.path, '.github/workflows/desktop.yml', 'Build workflow path mismatch.');
  assert.equal(run.status, 'completed', 'Build has not completed.');
  assert.equal(run.conclusion, 'success', 'Build was not successful.');
  await checkDraft();
  const listing = await api(`/actions/runs/${runId}/artifacts?per_page=100`);
  assert.ok(Number.isInteger(listing.total_count) && listing.total_count >= 1 && listing.total_count <= 100 && Array.isArray(listing.artifacts) && listing.artifacts.length === listing.total_count, 'Unexpected artifact pagination.');
  const matches = listing.artifacts.filter(item => item.name === 'ColdX-Windows-x64');
  assert.equal(matches.length, 1, 'Expected exactly one Windows x64 artifact.');
  assert.ok(validId(matches[0].id), 'Invalid artifact ID.');
  const artifact = await api(`/actions/artifacts/${matches[0].id}`);
  assert.equal(artifact.id, matches[0].id, 'Artifact ID mismatch.');
  assert.equal(artifact.name, 'ColdX-Windows-x64', 'Artifact name mismatch.');
  assert.equal(artifact.workflow_run?.id, runId, 'Artifact build run mismatch.');
  assert.equal(artifact.workflow_run?.head_sha, commit, 'Artifact commit mismatch.');
  assert.equal(artifact.expired, false, 'Artifact expired.');
  assert.ok(Date.parse(artifact.expires_at) > Date.now(), 'Artifact expiry is past.');
  assert.ok(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= maximumBytes, 'Artifact exceeds download boundary.');
  assert.match(artifact.digest ?? '', /^sha256:[a-f\d]{64}$/i, 'GitHub artifact SHA256 is required.');
  const redirect = await request(`${apiRoot}/actions/artifacts/${artifact.id}/zip`, { headers, redirect: 'manual', signal: AbortSignal.timeout(60000) });
  assert.equal(redirect.status, 302, 'GitHub artifact download did not redirect.');
  let location;
  try { location = new URL(redirect.headers.get('location')); }
  catch { throw new Error('Invalid signed artifact storage URL.'); }
  assert.ok(location.protocol === 'https:' && !location.username && !location.password && !location.port && !location.hash, 'Unexpected archive transport.');
  assert.ok(location.hostname.endsWith('.blob.core.windows.net') || location.hostname.endsWith('.actions.githubusercontent.com'), 'Unexpected GitHub artifact storage host.');
  // Deliberately omit all GitHub headers on this signed storage request.
  const download = await request(location);
  assert.ok(download.ok && download.body, `Archive download failed (${download.status}).`);
  const chunks = [];
  let received = 0;
  for await (const chunk of download.body) {
    received += chunk.length;
    assert.ok(received <= maximumBytes && received <= artifact.size_in_bytes, 'Archive exceeds download boundary.');
    chunks.push(chunk);
  }
  assert.equal(received, artifact.size_in_bytes, 'Archive byte count mismatch.');
  const archive = Buffer.concat(chunks);
  const archiveSha256 = sha256(archive);
  assert.equal(`sha256:${archiveSha256}`, artifact.digest.toLowerCase(), 'GitHub archive SHA256 mismatch.');
  const executable = extractSingleInstaller(archive, expectedName);
  const executableSha256 = sha256(executable);
  const checksum = Buffer.from(`${executableSha256}  ${expectedName}\n`);
  const plannedAssets = [
    { name: expectedName, bytes: executable, sha256: executableSha256, type: 'application/octet-stream' },
    { name: `${expectedName}.sha256`, bytes: checksum, sha256: sha256(checksum), type: 'text/plain' },
  ];
  await checkDraft();
  const preflightAssets = await listAssets();
  // Detect a known conflict in either asset before making the first mutation.
  for (const planned of plannedAssets) findExisting(preflightAssets, planned);
  const results = [];
  for (const planned of plannedAssets) {
    const existing = findExisting(await listAssets(), planned);
    // This is the final request before every POST. GitHub has no transactional
    // draft-only upload primitive, so another actor can still change it in flight.
    await checkDraft();
    let asset = existing;
    if (!asset) {
      const url = `https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(planned.name)}`;
      const response = await request(url, { method: 'POST', headers: { ...headers, 'Content-Type': planned.type, 'Content-Length': String(planned.bytes.length) }, body: planned.bytes });
      assert.equal(response.status, 201, `Release asset upload failed (${response.status}); no replacement attempted.`);
      asset = checkAsset(await response.json(), planned);
    }
    checkAsset(await api(`/releases/assets/${asset.id}`), planned);
    await checkDraft();
    results.push({ id: asset.id, name: planned.name, bytes: planned.bytes.length, sha256: planned.sha256, reused: Boolean(existing) });
  }
  return { repository, tag, commit, runId, releaseId, draft: true, artifactId: artifact.id, archiveSha256, assets: results };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await attachDesktopRelease())); }
  catch (error) {
    // Do not print response bodies, request headers, or signed storage URLs.
    console.error(error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'Release attachment failed (transport, response, or archive decoding error).');
    process.exitCode = 1;
  }
}
