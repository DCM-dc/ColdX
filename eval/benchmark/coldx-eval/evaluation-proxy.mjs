#!/usr/bin/env node
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export const EVALUATION_PARAMETERS = Object.freeze({
  model: 'deepseek-flash',
  reasoning_effort: 'max',
  temperature: 1,
  top_p: 0.95,
});

class ProxyFailure extends Error {
  constructor(status, code, message, type = 'proxy_error') {
    super(message);
    this.status = status;
    this.code = code;
    this.type = type;
  }
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive safe integer`);
  return value;
}

function bearerValue(value, field) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]+$/.test(value)) throw new Error(`${field} must be a nonempty ASCII token`);
  return value;
}

function fixedEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('upstreamBaseUrl must be an explicit HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('upstreamBaseUrl must use HTTP(S), without userinfo, query, or fragment');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`;
  return url;
}

function authorized(header, expected) {
  if (typeof header !== 'string') return false;
  const supplied = Buffer.from(header);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function jsonError(res, error) {
  if (res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(error.status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
  res.end(JSON.stringify({ error: { type: error.type, code: error.code, message: error.message } }));
}

function requestBytes(req, signal, maxBytes) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const fail = (error) => { cleanup(); req.resume(); reject(error); };
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        fail(new ProxyFailure(413, 'request_too_large', 'The request exceeds the configured byte limit.'));
      } else chunks.push(chunk);
    };
    const onError = () => fail(new ProxyFailure(400, 'invalid_request_body', 'The request body could not be read.'));
    const onAbort = () => fail(signal.reason);
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks, bytes));
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function requestBody(req, signal, maxBytes) {
  const bytes = await requestBytes(req, signal, maxBytes);
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch { throw new ProxyFailure(400, 'invalid_json', 'A JSON object is required.'); }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') throw new ProxyFailure(400, 'invalid_json', 'A JSON object is required.');
  return parsed;
}

async function boundedResponseJson(response, maxBytes = 256 * 1024) {
  if (!response.body) throw new ProxyFailure(502, 'invalid_file_response', 'The Files API returned no metadata.');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) throw new ProxyFailure(502, 'file_response_too_large', 'The Files API metadata exceeded its byte limit.');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); }
    catch { throw new ProxyFailure(502, 'invalid_file_response', 'The Files API returned invalid metadata.'); }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const FILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
function validateFileObject(value, expected = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !FILE_ID_PATTERN.test(value.id ?? '')
    || value.object !== 'file' || value.purpose !== 'user_data' || tokenNumber(value.bytes) === null
    || tokenNumber(value.created_at) === null || typeof value.filename !== 'string' || !value.filename.length
    || (value.expires_at !== undefined && tokenNumber(value.expires_at) === null)
    || (expected.id !== undefined && value.id !== expected.id)
    || (expected.bytes !== undefined && value.bytes !== expected.bytes)
    || (expected.upload && value.expires_at === undefined)) {
    throw new ProxyFailure(502, 'invalid_file_response', 'The Files API returned inconsistent metadata.');
  }
  return { id: value.id, object: 'file', bytes: value.bytes, created_at: value.created_at,
    filename: expected.filename ?? value.filename, purpose: 'user_data',
    ...(value.expires_at === undefined ? {} : { expires_at: value.expires_at }) };
}

const TOKEN_FIELDS = ['promptTokens', 'completionTokens', 'totalTokens', 'cachedInputTokens', 'uncachedInputTokens', 'reasoningTokens'];
const tokenNumber = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

function validatePricing(value) {
  if (value == null) return null;
  if (!value || !/^[A-Z]{3}$/.test(value.currency ?? '')) throw new Error('pricing requires a three-letter currency');
  const pricing = { currency: value.currency };
  for (const key of ['uncachedInputPerMillion', 'cachedInputPerMillion', 'outputPerMillion']) {
    if (!Number.isFinite(value[key]) || value[key] < 0) throw new Error('pricing rates must be finite nonnegative numbers');
    pricing[key] = value[key];
  }
  return pricing;
}

function createUsageAccounting(pricing) {
  const counts = Object.fromEntries(TOKEN_FIELDS.map((name) => [name, 0]));
  const sums = Object.fromEntries(TOKEN_FIELDS.map((name) => [name, 0]));
  const modelResponseCounts = Object.create(null);
  let observedRequests = 0, accountedRequests = 0, incompleteResponseRequests = 0;
  let oversizedEvents = 0, malformedEvents = 0, omittedModelIds = 0;
  return {
    record({ usage = {}, models = new Set(), complete = false, oversized = 0, malformed = 0, omittedModels = 0 } = {}) {
      observedRequests++;
      if (usage.promptTokens != null && usage.completionTokens != null) accountedRequests++;
      if (!complete) incompleteResponseRequests++;
      oversizedEvents += oversized;
      malformedEvents += malformed;
      omittedModelIds += omittedModels;
      for (const name of TOKEN_FIELDS) {
        if (usage[name] == null) continue;
        counts[name]++;
        sums[name] = Number.isSafeInteger(sums[name] + usage[name]) ? sums[name] + usage[name] : NaN;
      }
      for (const model of models) {
        if (Object.hasOwn(modelResponseCounts, model)) modelResponseCounts[model]++;
        else if (Object.keys(modelResponseCounts).length < 64) modelResponseCounts[model] = 1;
        else omittedModelIds++;
      }
    },
    snapshot(forwardedRequests) {
      const totals = Object.fromEntries(TOKEN_FIELDS.map((name) => [name, counts[name] && Number.isSafeInteger(sums[name]) ? sums[name] : null]));
      const complete = forwardedRequests > 0 && observedRequests === forwardedRequests && accountedRequests === forwardedRequests
        && incompleteResponseRequests === 0 && oversizedEvents === 0 && malformedEvents === 0;
      const costComplete = complete && ['promptTokens', 'completionTokens', 'cachedInputTokens', 'uncachedInputTokens']
        .every(name => counts[name] === forwardedRequests && totals[name] !== null);
      const amount = pricing && costComplete ? (totals.uncachedInputTokens * pricing.uncachedInputPerMillion
        + totals.cachedInputTokens * pricing.cachedInputPerMillion + totals.completionTokens * pricing.outputPerMillion) / 1e6 : null;
      return {
        source: 'bounded upstream SSE/JSON metadata for every forwarded request, including auxiliary model calls',
        observedRequests, accountedRequests, missingUsageRequests: observedRequests - accountedRequests,
        pendingRequests: forwardedRequests - observedRequests, incompleteResponseRequests,
        complete, totals, knownRequestCounts: { ...counts }, modelResponseCounts: { ...modelResponseCounts },
        oversizedEvents, malformedEvents, omittedModelIds,
        cost: pricing ? { currency: pricing.currency, estimatedAmount: Number.isFinite(amount) ? amount : null,
          complete: costComplete && Number.isFinite(amount), ratesPerMillion: { ...pricing }, providerInvoiceVerified: false } : null,
        note: 'Totals are sums of reported values only; null means unobserved. Unknown or partial responses may still be billed. Model IDs are provider-reported, not attested. Cache/total input derivations use reported arithmetic; no pricing is assumed.',
      };
    },
  };
}

// Observes bounded event metadata while passing every byte unchanged. No response text is retained after an event.
function createResponseMeter(contentType, maxBytes) {
  const sse = /^text\/event-stream(?:\s*;|\s*$)/i.test(contentType ?? '');
  const json = /^application\/json(?:\s*;|\s*$)/i.test(contentType ?? '');
  const usage = {}, models = new Set();
  let oversized = 0, malformed = 0, omittedModels = 0, done = false;
  let lineParts = [], lineBytes = 0, lineFirstByte = null, eventParts = [], eventBytes = 0, skipping = false;
  let jsonParts = [], jsonBytes = 0, jsonSkipped = false;
  function inspect(data) {
    let value;
    try { value = JSON.parse(data); } catch { malformed++; return; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { malformed++; return; }
    if (typeof value.model === 'string') {
      if (/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value.model) && (models.has(value.model) || models.size < 8)) models.add(value.model);
      else omittedModels++;
    }
    const raw = value.usage;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const fields = {
      promptTokens: tokenNumber(raw.prompt_tokens), completionTokens: tokenNumber(raw.completion_tokens),
      totalTokens: tokenNumber(raw.total_tokens),
      cachedInputTokens: tokenNumber(raw.prompt_cache_hit_tokens) ?? tokenNumber(raw.prompt_tokens_details?.cached_tokens),
      uncachedInputTokens: tokenNumber(raw.prompt_cache_miss_tokens), reasoningTokens: tokenNumber(raw.completion_tokens_details?.reasoning_tokens),
    };
    // A usage event is a cumulative snapshot, not an additive delta. Never reuse stale totals/cache fields.
    for (const name of TOKEN_FIELDS) delete usage[name];
    for (const name of TOKEN_FIELDS) if (fields[name] !== null) usage[name] = fields[name];
    if (usage.totalTokens == null && usage.promptTokens != null && usage.completionTokens != null) usage.totalTokens = tokenNumber(usage.promptTokens + usage.completionTokens);
    if (usage.promptTokens != null && usage.cachedInputTokens != null) {
      if (usage.cachedInputTokens > usage.promptTokens) { malformed++; delete usage.cachedInputTokens; delete usage.uncachedInputTokens; }
      else usage.uncachedInputTokens = usage.promptTokens - usage.cachedInputTokens;
    } else if (usage.promptTokens != null && usage.uncachedInputTokens != null) {
      if (usage.uncachedInputTokens > usage.promptTokens) { malformed++; delete usage.uncachedInputTokens; }
      else usage.cachedInputTokens = usage.promptTokens - usage.uncachedInputTokens;
    }
  }
  function line(buffer) {
    if (buffer.at(-1) === 13) buffer = buffer.subarray(0, -1);
    if (!buffer.length) {
      if (!skipping && eventParts.length) {
        const data = eventParts.join('\n');
        if (data.trim() === '[DONE]') done = true;
        else inspect(data);
      }
      eventParts = []; eventBytes = 0; skipping = false;
      return;
    }
    if (skipping) return;
    eventBytes += buffer.length;
    if (eventBytes > maxBytes) { oversized++; skipping = true; eventParts = []; return; }
    const text = buffer.toString('utf8');
    if (text === 'data' || text.startsWith('data:')) eventParts.push(text.slice(5).replace(/^ /, ''));
  }
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      if (sse) {
        let offset = 0;
        while (offset < chunk.length) {
          const newline = chunk.indexOf(10, offset);
          const end = newline < 0 ? chunk.length : newline;
          const piece = chunk.subarray(offset, end);
          if (lineBytes === 0 && piece.length) lineFirstByte = piece[0];
          lineBytes += piece.length;
          if (!skipping && lineBytes <= maxBytes) lineParts.push(piece);
          else if (!skipping) { oversized++; skipping = true; lineParts = []; eventParts = []; }
          if (newline >= 0) {
            if (lineBytes === 0 || (lineBytes === 1 && lineFirstByte === 13)) line(Buffer.alloc(0));
            else if (!skipping) line(Buffer.concat(lineParts, lineBytes));
            lineParts = []; lineBytes = 0; lineFirstByte = null;
          }
          offset = end + 1;
        }
      } else if (json && !jsonSkipped) {
        jsonBytes += chunk.length;
        if (jsonBytes > maxBytes) { oversized++; jsonSkipped = true; jsonParts = []; }
        else jsonParts.push(chunk);
      }
      callback(null, chunk);
    },
    flush(callback) {
      if (json && !jsonSkipped) { inspect(Buffer.concat(jsonParts, jsonBytes).toString('utf8')); done = true; }
      jsonParts = []; lineParts = []; eventParts = [];
      callback();
    },
  });
  return { transform, result(completed) { return { usage, models, complete: completed && done, oversized, malformed, omittedModels }; } };
}

/** Transport only: one downstream request makes at most one upstream request. No retries or agent loop. */
export function createEvaluationProxy({
  upstreamBaseUrl,
  apiKey,
  downstreamToken = randomBytes(32).toString('hex'),
  host = '127.0.0.1',
  port = 0,
  maxRequests = 500,
  timeoutMs = 180_000,
  maxBodyBytes = 32 * 1024 * 1024,
  maxMeterEventBytes = 1024 * 1024,
  maxFileOperations = 2_000,
  maxFileUploads = 500,
  maxFileUploadBytes = 128 * 1024 * 1024,
  maxTotalFileUploadBytes = 2 * 1024 * 1024 * 1024,
  dispatcher = null,
  pricing = null,
} = {}) {
  const endpoint = fixedEndpoint(upstreamBaseUrl);
  if (dispatcher !== null && typeof dispatcher.dispatch !== 'function') throw new Error('dispatcher must implement Undici dispatch');
  bearerValue(apiKey, 'apiKey');
  bearerValue(downstreamToken, 'downstreamToken');
  const expectedAuthorization = Buffer.from(`Bearer ${downstreamToken}`);
  positiveInteger(maxRequests, 'maxRequests');
  positiveInteger(timeoutMs, 'timeoutMs');
  positiveInteger(maxBodyBytes, 'maxBodyBytes');
  positiveInteger(maxMeterEventBytes, 'maxMeterEventBytes');
  for (const [name, value] of Object.entries({ maxFileOperations, maxFileUploads, maxFileUploadBytes, maxTotalFileUploadBytes })) positiveInteger(value, name);
  const accounting = createUsageAccounting(validatePricing(pricing));
  const filesEndpoint = new URL(endpoint);
  filesEndpoint.pathname = filesEndpoint.pathname.replace(/\/chat\/completions$/, '/files');
  const ownedFiles = new Map();
  const fileStats = { operations: 0, forwardedRequests: 0, uploadAttempts: 0, successfulUploads: 0, uploadedBytes: 0,
    reservedUploadBytes: 0, multipartReceivedBytes: 0, retrieves: 0, deletes: 0, localLists: 0,
    unknownFileReferences: 0, budgetExhaustedRequests: 0, failures: 0 };
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('port must be between 0 and 65535');
  if (typeof host !== 'string' || !host) throw new Error('host must be explicitly specified or omitted for loopback');

  const stats = {
    forwardedRequests: 0,
    completedResponses: 0,
    activeRequests: 0,
    rejectedRequests: 0,
    unauthorizedRequests: 0,
    budgetExhaustedRequests: 0,
    upstreamHttpErrors: 0,
    refusedRedirects: 0,
    timedOutRequests: 0,
    clientCancelledRequests: 0,
    shutdownCancelledRequests: 0,
    transportErrors: 0,
    streamUsageRequestOverrides: 0,
    parameterOverrides: Object.fromEntries(Object.keys(EVALUATION_PARAMETERS).map((key) => [key, 0])),
  };
  const active = new Set();
  const pending = new Set();
  let baseUrl;
  let closing = false;
  let closePromise;

  function sendJson(res, value, status = 200) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  }

  async function filesRequest(method, fileId, body, signal) {
    const url = new URL(filesEndpoint);
    if (fileId) url.pathname += `/${encodeURIComponent(fileId)}`;
    fileStats.forwardedRequests++;
    const response = await fetch(url, { method, redirect: 'manual', signal,
      ...(dispatcher ? { dispatcher } : {}),
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'accept-encoding': 'identity' }, ...(body ? { body } : {}) });
    if (response.status >= 300 && response.status < 400) {
      stats.refusedRedirects++; await response.body?.cancel();
      throw new ProxyFailure(502, 'upstream_redirect_refused', 'The configured upstream returned a redirect; it was not followed.');
    }
    if (!response.ok) {
      stats.upstreamHttpErrors++; await response.body?.cancel().catch(() => {});
      throw new ProxyFailure(response.status, `upstream_http_${response.status}`, `The Files API returned HTTP ${response.status}. Its response body was discarded.`, 'upstream_http_error');
    }
    return boundedResponseJson(response);
  }

  async function handleFiles(req, res, signal) {
    const url = new URL(req.url, 'http://proxy.invalid');
    if (url.hash) throw new ProxyFailure(404, 'route_not_allowed', 'URL fragments are not accepted.');
    const collection = url.pathname === '/files';
    let fileId;
    if (!collection) {
      const match = /^\/files\/([^/]+)$/.exec(url.pathname);
      if (!match || url.search) throw new ProxyFailure(404, 'route_not_allowed', 'This Files API route is unavailable.');
      try { fileId = decodeURIComponent(match[1]); } catch { throw new ProxyFailure(404, 'route_not_allowed', 'Invalid file identifier.'); }
      if (!FILE_ID_PATTERN.test(fileId) || !ownedFiles.has(fileId)) {
        fileStats.unknownFileReferences++;
        throw new ProxyFailure(404, 'file_not_owned', 'Only files uploaded through this evaluation proxy are accessible.');
      }
    }
    if ((collection && !['GET', 'POST'].includes(req.method)) || (!collection && !['GET', 'DELETE'].includes(req.method))) {
      throw new ProxyFailure(405, 'method_not_allowed', 'This Files API method is unavailable.');
    }
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new ProxyFailure(415, 'content_encoding_not_allowed', 'Compressed request bodies are not accepted.');
    if (fileStats.operations >= maxFileOperations) {
      fileStats.budgetExhaustedRequests++;
      throw new ProxyFailure(429, 'file_request_budget_exhausted', 'The independent Files API operation budget is exhausted.', 'budget_exhausted');
    }
    if (collection && req.method === 'GET') {
      const allowed = new Set(['purpose', 'after', 'limit', 'order']);
      for (const key of url.searchParams.keys()) if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) throw new ProxyFailure(400, 'invalid_file_list', 'Invalid Files API list parameters.');
      const after = url.searchParams.get('after');
      const limitRaw = url.searchParams.get('limit') ?? '100';
      const limit = Number(limitRaw);
      const order = url.searchParams.get('order') ?? 'desc';
      if ((url.searchParams.get('purpose') ?? 'user_data') !== 'user_data' || !/^\d+$/.test(limitRaw)
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !['asc', 'desc'].includes(order)
        || (after !== null && !ownedFiles.has(after))) throw new ProxyFailure(400, 'invalid_file_list', 'Invalid or unowned Files API pagination.');
      fileStats.operations++; fileStats.localLists++;
      let files = [...ownedFiles.values()].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
      if (order === 'desc') files.reverse();
      if (after !== null) files = files.slice(files.findIndex(file => file.id === after) + 1);
      const data = files.slice(0, limit);
      sendJson(res, { object: 'list', data, has_more: files.length > limit,
        ...(data.length ? { first_id: data[0].id, last_id: data.at(-1).id } : {}) });
      return;
    }
    if (collection) {
      if (url.search) throw new ProxyFailure(404, 'route_not_allowed', 'Upload query parameters are not accepted.');
      const contentType = req.headers['content-type'] ?? '';
      if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new ProxyFailure(415, 'content_type_not_allowed', 'Files API uploads require multipart/form-data.');
      const bytes = await requestBytes(req, signal, maxFileUploadBytes + 64 * 1024);
      fileStats.multipartReceivedBytes += bytes.length;
      let form;
      try { form = await new Response(bytes, { headers: { 'content-type': contentType } }).formData(); }
      catch { throw new ProxyFailure(400, 'invalid_file_upload', 'Invalid multipart file upload.'); }
      const keys = ['purpose', 'expires_after[anchor]', 'expires_after[seconds]', 'file'];
      if ([...form.keys()].length !== keys.length || keys.some(key => form.getAll(key).length !== 1)
        || form.get('purpose') !== 'user_data' || form.get('expires_after[anchor]') !== 'created_at') throw new ProxyFailure(400, 'invalid_file_upload', 'Only the native image-upload fields are accepted.');
      const expiry = form.get('expires_after[seconds]');
      const seconds = Number(expiry);
      const file = form.get('file');
      if (typeof expiry !== 'string' || !/^\d+$/.test(expiry) || !Number.isSafeInteger(seconds) || seconds < 3600 || seconds > 2592000
        || !(file instanceof Blob) || typeof file.name !== 'string' || file.name.length < 1 || file.name.length > 255
        || /[\x00-\x1f\x7f]/.test(file.name) || !/^image\/[a-z0-9.+-]+$/i.test(file.type)) throw new ProxyFailure(400, 'invalid_file_upload', 'Expected one image with a valid native expiry.');
      if (file.size > maxFileUploadBytes) throw new ProxyFailure(413, 'file_too_large', 'The image exceeds the configured upload byte limit.');
      if (fileStats.operations >= maxFileOperations || fileStats.uploadAttempts >= maxFileUploads || fileStats.reservedUploadBytes + file.size > maxTotalFileUploadBytes) {
        fileStats.budgetExhaustedRequests++;
        throw new ProxyFailure(429, 'file_upload_budget_exhausted', 'The independent Files API upload budget is exhausted.', 'budget_exhausted');
      }
      fileStats.operations++; fileStats.uploadAttempts++; fileStats.reservedUploadBytes += file.size;
      // Rebuild only validated fields. Multipart boundaries are transport framing, not model content.
      const outbound = new FormData();
      for (const key of keys.slice(0, 3)) outbound.set(key, form.get(key));
      outbound.set('file', file, file.name);
      const metadata = validateFileObject(await filesRequest('POST', null, outbound, signal), { upload: true, bytes: file.size, filename: file.name });
      if (ownedFiles.has(metadata.id)) throw new ProxyFailure(502, 'duplicate_file_id', 'The Files API reused an existing upload identifier.');
      ownedFiles.set(metadata.id, metadata);
      fileStats.successfulUploads++; fileStats.uploadedBytes += file.size;
      sendJson(res, metadata);
      return;
    }
    fileStats.operations++;
    if (req.method === 'GET') {
      fileStats.retrieves++;
      const metadata = validateFileObject(await filesRequest('GET', fileId, null, signal), {
        id: fileId, bytes: ownedFiles.get(fileId).bytes, filename: ownedFiles.get(fileId).filename,
      });
      ownedFiles.set(fileId, metadata); sendJson(res, metadata);
    } else {
      fileStats.deletes++;
      const value = await filesRequest('DELETE', fileId, null, signal);
      if (!value || value.id !== fileId || value.object !== 'file' || value.deleted !== true) throw new ProxyFailure(502, 'invalid_file_response', 'The Files API returned inconsistent deletion metadata.');
      ownedFiles.delete(fileId); sendJson(res, { id: fileId, object: 'file', deleted: true });
    }
  }

  async function handle(req, res) {
    const controller = new AbortController();
    let abortKind;
    let forwarded = false;
    let upstreamStreamFailed = false;
    let meter;
    let responseCompleted = false;
    let fileOperation = false;
    const abort = (kind) => {
      if (controller.signal.aborted || upstreamStreamFailed) return;
      abortKind = kind;
      const counter = { timeout: 'timedOutRequests', client: 'clientCancelledRequests', shutdown: 'shutdownCancelledRequests' }[kind];
      if (counter) stats[counter]++;
      controller.abort(new Error('Proxy request cancelled.'));
    };
    const onClientClose = () => { if (!res.writableFinished) abort('client'); };
    const onRequestAborted = () => abort('client');
    const state = { abort };
    active.add(state);
    stats.activeRequests++;
    res.once('close', onClientClose);
    req.once('aborted', onRequestAborted);
    const timeout = setTimeout(() => abort('timeout'), timeoutMs);
    timeout.unref();

    try {
      if (closing) throw new ProxyFailure(503, 'proxy_closing', 'The evaluation proxy is shutting down.');
      if (!authorized(req.headers.authorization, expectedAuthorization)) {
        stats.unauthorizedRequests++;
        throw new ProxyFailure(401, 'invalid_local_token', 'A valid local proxy bearer token is required.');
      }
      if (req.url === '/files' || req.url.startsWith('/files?') || req.url.startsWith('/files/')) {
        fileOperation = true;
        await handleFiles(req, res, controller.signal);
        return;
      }
      if (req.url !== '/chat/completions') throw new ProxyFailure(404, 'route_not_allowed', 'Only the evaluation chat and native Files API routes are available.');
      if (req.method !== 'POST') throw new ProxyFailure(405, 'method_not_allowed', 'Only POST is allowed.');
      if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] ?? '')) {
        throw new ProxyFailure(415, 'content_type_not_allowed', 'Content-Type must be application/json.');
      }
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
        throw new ProxyFailure(415, 'content_encoding_not_allowed', 'Compressed request bodies are not accepted.');
      }
      const payload = await requestBody(req, controller.signal, maxBodyBytes);
      for (const message of Array.isArray(payload.messages) ? payload.messages : []) {
        for (const part of Array.isArray(message?.content) ? message.content : []) {
          if (part?.type !== 'file') continue;
          const fileId = part.file_id ?? part.file?.file_id;
          if (!ownedFiles.has(fileId)) {
            fileStats.unknownFileReferences++;
            throw new ProxyFailure(400, 'file_not_owned', 'Chat may reference only files uploaded through this evaluation proxy.');
          }
        }
      }
      if (stats.forwardedRequests >= maxRequests) {
        stats.budgetExhaustedRequests++;
        throw new ProxyFailure(429, 'proxy_request_budget_exhausted', 'The configured upstream request budget is exhausted. Treat this trial as budget-exhausted, not an ordinary task score.', 'budget_exhausted');
      }
      // Reserve synchronously before fetch: simultaneous requests cannot exceed the cap.
      stats.forwardedRequests++;
      forwarded = true;
      for (const [key, value] of Object.entries(EVALUATION_PARAMETERS)) {
        if (payload[key] !== value) stats.parameterOverrides[key]++;
        payload[key] = value;
      }
      if (payload.stream === true) {
        if (payload.stream_options?.include_usage !== true) stats.streamUsageRequestOverrides++;
        const original = payload.stream_options;
        payload.stream_options = { ...(original && typeof original === 'object' && !Array.isArray(original) ? original : {}), include_usage: true };
      }

      const upstream = await fetch(endpoint, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        ...(dispatcher ? { dispatcher } : {}),
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream, application/json',
          'accept-encoding': 'identity',
        },
        body: JSON.stringify(payload),
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        stats.refusedRedirects++;
        await upstream.body?.cancel();
        throw new ProxyFailure(502, 'upstream_redirect_refused', 'The configured upstream returned a redirect; it was not followed.');
      }
      if (!upstream.ok) {
        stats.upstreamHttpErrors++;
        // Provider failures can echo Authorization values or return HTML. Do not expose or persist that body.
        await upstream.body?.cancel().catch(() => {});
        const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
        const retryAfter = upstream.headers.get('retry-after');
        if (retryAfter && (/^\d+$/.test(retryAfter) || /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retryAfter))) headers['retry-after'] = retryAfter;
        res.writeHead(upstream.status, headers);
        res.end(JSON.stringify({ error: { type: 'upstream_http_error', code: `upstream_http_${upstream.status}`, message: `The upstream returned HTTP ${upstream.status}. Its response body was discarded.` } }));
        stats.completedResponses++;
        return;
      }
      // Fetch can decompress bodies. Never copy content-length/content-encoding or hop-by-hop headers.
      const headers = {};
      for (const name of ['content-type', 'cache-control', 'retry-after', 'x-request-id', 'request-id']) {
        const value = upstream.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      res.writeHead(upstream.status, headers);
      res.flushHeaders();
      if (upstream.body) {
        const source = Readable.fromWeb(upstream.body);
        meter = createResponseMeter(upstream.headers.get('content-type'), maxMeterEventBytes);
        // Pipeline also closes res on a source error; that close is not a client cancellation.
        source.once('error', () => { upstreamStreamFailed = true; });
        await pipeline(source, meter.transform, res, { signal: controller.signal });
      } else res.end();
      responseCompleted = true;
      stats.completedResponses++;
    } catch (error) {
      if (fileOperation) fileStats.failures++;
      if (abortKind === 'timeout') {
        jsonError(res, new ProxyFailure(504, 'upstream_timeout', 'The request exceeded the configured total timeout.'));
      } else if (abortKind === 'client') {
        res.destroy();
      } else if (abortKind === 'shutdown') {
        jsonError(res, new ProxyFailure(503, 'proxy_closing', 'The evaluation proxy is shutting down.'));
      } else if (error instanceof ProxyFailure) {
        if (!forwarded) stats.rejectedRequests++;
        jsonError(res, error);
      } else {
        stats.transportErrors++;
        jsonError(res, new ProxyFailure(502, 'upstream_transport_error', 'The upstream request or response stream failed.'));
      }
    } finally {
      if (forwarded) accounting.record(meter?.result(responseCompleted));
      clearTimeout(timeout);
      res.off('close', onClientClose);
      req.off('aborted', onRequestAborted);
      active.delete(state);
      stats.activeRequests--;
    }
  }

  const server = http.createServer((req, res) => {
    const request = handle(req, res).finally(() => pending.delete(request));
    pending.add(request);
  });
  server.headersTimeout = Math.min(timeoutMs, 60_000);
  server.requestTimeout = timeoutMs;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });

  const api = {
    get baseUrl() { return baseUrl; },
    getStats() {
      return structuredClone({ ...stats, maxRequests, remainingRequests: maxRequests - stats.forwardedRequests, timeoutMs, maxBodyBytes,
        maxMeterEventBytes, wireParameters: EVALUATION_PARAMETERS, streamingWireOptions: { include_usage: true },
        files: { ...fileStats, ownedFileCount: ownedFiles.size, maxFileOperations, maxFileUploads, maxFileUploadBytes, maxTotalFileUploadBytes },
        dispatcher: dispatcher?.evaluationMetadata ?? { implementation: dispatcher ? 'caller-supplied' : 'Node.globalFetch.default',
          nodeVersion: process.version, undiciVersion: process.versions.undici ?? null, explicitConfiguration: false,
          note: 'Underlying dispatcher defaults are not overridden. This default path is for loopback tests; formal Pier runs require an explicit configured dispatcher.' },
        tokenAccounting: accounting.snapshot(stats.forwardedRequests) });
    },
    async listen() {
      if (closing) throw new Error('The proxy is closed.');
      if (server.listening) return baseUrl;
      await new Promise((resolve, reject) => {
        const fail = (error) => { server.off('listening', ready); reject(error); };
        const ready = () => { server.off('error', fail); resolve(); };
        server.once('error', fail);
        server.once('listening', ready);
        server.listen(port, host);
      });
      const address = server.address();
      const formattedHost = address.address.includes(':') ? `[${address.address}]` : address.address;
      baseUrl = `http://${formattedHost}:${address.port}`;
      return baseUrl;
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      for (const entry of active) entry.abort('shutdown');
      const serverClosed = new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      closePromise = Promise.all([serverClosed, ...pending]).then(async () => { await dispatcher?.close?.(); });
      return closePromise;
    },
  };
  Object.defineProperty(api, 'downstreamToken', { value: downstreamToken, enumerable: false });
  return api;
}

async function main() {
  const { values } = parseArgs({ options: {
    'upstream-base-url': { type: 'string' }, host: { type: 'string' }, port: { type: 'string' },
    'max-requests': { type: 'string' }, 'timeout-ms': { type: 'string' }, 'max-body-bytes': { type: 'string' },
    help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: node evaluation-proxy.mjs --upstream-base-url URL [--host 127.0.0.1] [--port 0] [--max-requests 500] [--timeout-ms 180000] [--max-body-bytes 33554432]\nExplicit environment inputs: COLDX_EVAL_UPSTREAM_API_KEY and COLDX_EVAL_DOWNSTREAM_TOKEN. Tokens, bodies and upstream error text are never printed.');
    return;
  }
  // CLI uses explicit caller-supplied tokens; module callers can receive the random token in memory.
  if (!process.env.COLDX_EVAL_DOWNSTREAM_TOKEN) throw new Error('CLI requires an explicitly supplied downstream token.');
  const options = {
    upstreamBaseUrl: values['upstream-base-url'],
    apiKey: process.env.COLDX_EVAL_UPSTREAM_API_KEY,
    downstreamToken: process.env.COLDX_EVAL_DOWNSTREAM_TOKEN,
  };
  for (const [flag, name] of [['host', 'host'], ['port', 'port'], ['max-requests', 'maxRequests'], ['timeout-ms', 'timeoutMs'], ['max-body-bytes', 'maxBodyBytes']]) {
    if (values[flag] !== undefined) options[name] = flag === 'host' ? values[flag] : Number(values[flag]);
  }
  const proxy = createEvaluationProxy(options);
  await proxy.listen();
  console.log(JSON.stringify({ event: 'evaluation_proxy_ready', baseUrl: proxy.baseUrl, stats: proxy.getStats() }));
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await proxy.close();
    console.log(JSON.stringify({ event: 'evaluation_proxy_stopped', stats: proxy.getStats() }));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Error messages from dependencies may embed an input URL or token. Keep CLI diagnostics static.
    console.error(JSON.stringify({ event: 'evaluation_proxy_error', code: 'configuration_or_listen_error', message: 'Check the explicit URL, token environment inputs, numeric limits and listen address.' }));
    process.exitCode = 1;
  });
}
