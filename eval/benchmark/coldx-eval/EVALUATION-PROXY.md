# ColdX evaluation transport proxy

`evaluation-proxy.mjs` is a dependency-free Node.js HTTP/fetch adapter. It does not run a model loop, select tools, retry generations, alter prompts, or score tasks. The original ColdX/DeepSeek Harness process continues to own all agent behavior.

Use Node.js 24 (the public-copy loopback tests were run with 24.16.0). Import it from the evaluation launcher:

```js
import { createEvaluationProxy } from './evaluation-proxy.mjs';

const proxy = createEvaluationProxy({
  upstreamBaseUrl: process.env.COLDX_EVAL_UPSTREAM_BASE_URL,
  apiKey: process.env.COLDX_EVAL_UPSTREAM_API_KEY,
  // Optional: downstreamToken. Omission creates a random 256-bit token.
  // Optional: host defaults to 127.0.0.1, port defaults to an available port.
  maxRequests: 500,
  timeoutMs: 180_000,
});
await proxy.listen();
try {
  // Give the native ColdX child only proxy.baseUrl and proxy.downstreamToken.
  // Its requests must use Authorization: Bearer <downstreamToken>.
  // Do not pass the parent's upstream API key environment to that child.
  // await runNativeColdX({ baseUrl: proxy.baseUrl, apiKey: proxy.downstreamToken });
} finally {
  await proxy.close();
  const stats = proxy.getStats(); // Safe to persist: counts and fixed parameters only.
}
```

The module does not read environment variables or user configuration itself. Only its explicit arguments select the upstream and key. `downstreamToken` is readable from the return object but non-enumerable to avoid accidental JSON serialization. Never print it. `baseUrl` is set after `listen()` and has no path prefix. `listen()` returns that base URL; `close()` aborts pending requests, closes sockets, and waits for their statistics to settle. Repeated `close()` calls are safe.

## Routing and request parameters

Chat uses exact `POST /chat/completions`. The native image Files API routes below are the only other supported routes. Other paths, invalid query strings/methods/local tokens, non-JSON chat bodies, compressed request bodies, and oversized bodies are rejected before forwarding. The default JSON chat body limit is 32 MiB (`maxBodyBytes`). Every forwarded route uses the single explicit `upstreamBaseUrl` plus the fixed chat or Files API suffix. An explicit upstream `/v1` or other API prefix is preserved; it cannot be selected by downstream input. Upstream URL credentials, fragments and query parameters are rejected, and redirects are never followed. The original downstream Authorization header is replaced with the explicitly supplied upstream key.

At the final JSON transport boundary, exactly these fields are forced:

```json
{"model":"deepseek-flash","reasoning_effort":"max","temperature":1,"top_p":0.95}
```

For streaming requests, `stream_options.include_usage` is also forced to `true`, preserving other valid `stream_options` fields. Its changes are counted separately as `streamUsageRequestOverrides`. Other JSON fields, including messages, tools, stream, and max_tokens, are preserved. Statistics contain each parameter's overwrite count, total attempted forwards, response/failure counts and the fixed wire values. They never contain prompts, tool bodies, authorization values, upstream response/error bodies, or the upstream URL. `forwardedRequests` counts reserved fetch attempts, including attempts that fail before the upstream receives them; it is deliberately conservative for budget protection. A recorded wire setting is not proof that the upstream honored it. In particular, current DeepSeek thinking API documentation says temperature is ignored in thinking mode.

## Usage and cost accounting

`getStats().tokenAccounting` observes metadata in upstream SSE events or JSON responses while the original bytes continue downstream unchanged. It includes **every forwarded model call**, including title, compaction, and other auxiliary requests that the native assistant event ledger can omit. It counts the last reported cumulative usage per response once rather than adding every streaming usage snapshot.

Recorded numeric fields are prompt, completion, total, cache-hit input, cache-miss input, and reasoning tokens when present. DeepSeek's `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` and OpenAI-compatible `prompt_tokens_details.cached_tokens` are supported. If total input and one cache component are reported, the other component is derived by subtraction; if total tokens are absent and both input and output are known, their sum is used. A response model ID is accepted only as a bounded identifier, with at most 8 distinct IDs per response and 64 in aggregate. It is a provider-reported label, not proof of model identity.

SSE event and nonstreaming JSON observation is bounded to `maxMeterEventBytes` (default 1 MiB). Oversized/malformed events are discarded by the **observer only**, never rewritten or dropped from the model response. The observer retains no reasoning or answer text after processing each event and never writes response bodies to disk. An oversized response may therefore lose usage observation; this is explicit in the counters.

Unknown totals are `null`, never invented zeroes. `knownRequestCounts` records coverage for each field; a partially observed sum is not a full invoice. `complete` requires usage for all forwarded requests, successful response termination (including `[DONE]` for SSE), and no metering parse/size failures. Cache fields have separate coverage: complete prompt/output accounting does not imply cache hit counts are available. HTTP failures, interrupted streams and timeouts may still be billed and make completeness false.

No price is assumed. Optional explicit `pricing` supplies `currency`, `uncachedInputPerMillion`, `cachedInputPerMillion`, and `outputPerMillion`. A cost estimate is produced only when input, cache and output counts cover every completed request. Otherwise the estimated amount is `null`. Rates remain caller-supplied, and `providerInvoiceVerified` is always false. In a two-proxy deployment, each hop observes the same usage; **do not add the two hop totals together**. The external proxy is the authoritative final-wire ledger; the session proxy provides per-session attribution.

## Native image Files API

The pinned `@deepseek-ai/dsh-llm-deepseek` client uploads image bytes through `/files`, then sends `{type:"file",file_id:"..."}` in chat. Blocking `/files` would break the actual ColdX screenshot workflow. This proxy preserves that transport rather than changing native images to inline data URLs.

Supported operations are:

- `POST /files`: one multipart `file` with image media type, `purpose=user_data`, `expires_after[anchor]=created_at`, and `expires_after[seconds]` between 3600 and 2592000. Exactly these four fields are accepted once. The image bytes and native expiry are preserved; multipart framing is rebuilt after validation. The pinned native default expiry is 604800 seconds (7 days); the proxy does not choose a different lifetime.
- `GET /files/<id>` and `DELETE /files/<id>`: only IDs returned by successful uploads through this proxy instance. IDs must have bounded URL-safe alphanumeric/dot/dash/underscore format. No file-content/download route or arbitrary path is available.
- `GET /files?purpose=user_data&after=<owned-id>&limit=<1..1000>&order=<asc|desc>`: a local paginated list of this proxy's uploaded metadata. Missing optional parameters use native-compatible defaults. **The provider account-wide list is never queried**, so an agent cannot inspect/delete unrelated user files during quota cleanup. This scoped view is a deliberate credential-isolation boundary and must be recorded in the environment manifest.

Chat file references must also belong to this proxy instance. Every hop in the two-proxy path registers the upload before allowing its ID in subsequent chat. Use a fresh native `DSH_HOME` per trial; files indexed under an old token are not silently trusted in a new session.

Successful provider metadata is validated and limited to the native file object fields. Upload response bytes must equal the uploaded image size; upload responses require `expires_at`. Unknown fields are dropped; filenames returned downstream come from the original validated upload. Metadata JSON is bounded to 256 KiB. HTTP failure bodies and redirect targets are discarded; errors have static sanitized messages. Images, filenames and file IDs are never written into proxy statistics or logs. Owned metadata exists only in the proxy's bounded in-memory table; image bytes are released after the upload completes.

Independent file limits are `maxFileUploadBytes=134217728` (128 MiB per image, matching the pinned client), `maxTotalFileUploadBytes=2147483648`, `maxFileUploads=500`, and `maxFileOperations=2000`. The multipart request additionally permits 64 KiB framing overhead. Upload reservations are atomic across simultaneous requests. `stats.files` reports operations, attempted/successful uploads, actual image bytes, framing bytes, unknown-ID rejections and budget exhaustion. These are **not** model requests, native steps, or token counts; no file-operation/storage price is assumed. An exhausted file budget must invalidate/interrupt the trial explicitly. Failed uploads can still create remote files or incur charges if a connection breaks; a success count does not replace the provider invoice. The relay does not erase uploads on shutdown; native expiry/deletion remains in effect.

## Streams, cancellation and failures

Successful responses are forwarded incrementally with Node stream backpressure. Successful SSE bytes and the upstream completion marker are not rewritten. Upstream HTTP failures retain their status and a syntactically valid Retry-After value, but their bodies are cancelled and discarded: provider errors can echo credentials or contain HTML. The client receives a generic JSON `upstream_http_error` and `upstream_http_<status>` code. Failed-response bodies and headers containing arbitrary provider details never reach the native driver's logs. Only a small safe response-header allowlist is copied for successful responses; content-length, content-encoding, redirect targets and hop-by-hop headers are not forwarded.

Client disconnects, explicit proxy shutdown and total request deadlines abort the upstream fetch. Aborting a connection cannot guarantee that a remote provider immediately stops already-started generation or billing. The timeout includes body reception, upstream headers and the entire response stream. Before response headers, a timeout produces HTTP 504; after headers, the connection is terminated and no successful completion marker is fabricated. Upstream connection/stream failures produce HTTP 502 before headers or terminate an already-started stream. An upstream redirect produces HTTP 502 `upstream_redirect_refused` without contacting its target. The proxy never retries automatically.

`maxRequests` defaults to **500 as a probe safeguard**, not as an assertion that 500 API requests equal the paper's 500 native agent steps. Title, compaction, subagent or other model calls may consume requests too. The caller can explicitly choose a different positive limit; no unbounded setting is accepted. Once the reserved forward count reaches the cap, later valid requests receive HTTP 429 with:

```json
{"error":{"type":"budget_exhausted","code":"proxy_request_budget_exhausted"}}
```

The full response also includes an explanatory message. A launcher must classify this as `budget-exhausted` and retain the proxy statistics; it must not silently turn the incomplete trial into an ordinary task score. This cap limits request count, not currency or tokens.

### Explicit dispatchers for actual Pier runs

`evaluation-dispatcher.mjs` loads the explicit, absolute `index.js` path of the already locked Undici 7.x package; it never downloads dependencies. The mounted adapter supplies `/opt/coldx-app/node_modules/.pnpm/undici@7.29.1/node_modules/undici/index.js` by default. Host and container paths differ and are passed separately. `run-session.mjs` accepts `--undici-module` or `COLDX_EVAL_UNDICI_MODULE`, and requires it when environment-proxy routing is enabled. The external CLI requires `--undici-module` as well.

For a 10800000 ms request timeout, headers and body dispatch limits are also 10800000 ms. Connection establishment is independently limited to 30000 ms. `run-session` defaults request timeout to its configured task timeout, with no additional 3-minute generation cutoff. Module-only loopback tests may omit a dispatcher and are explicitly labeled as using Node global defaults; those defaults are not suitable evidence of formal Pier routing/timeout parity.

The `EnvHttpProxyAgent` uses `proxyTunnel:false`: HTTP goes through Squid as an ordinary absolute-form proxy request, while HTTPS retains CONNECT. This matters because pinned Pier permits destination ports 80/443 but CONNECT only on 443. Default Undici's CONNECT-to-HTTP-port-80 behavior is incompatible. The unchanged Squid policy and correct forwarding behavior were checked in an actual Docker/Pier mock run. `stats.dispatcher` records the implementation, Node/Undici versions and configured timeouts without proxy URLs or credentials. A supplied dispatcher is owned and closed by the evaluation proxy.

## Standalone CLI

Supply keys/tokens through the explicitly named environment variables **before** invoking the CLI; the command line never accepts secrets:

```text
COLDX_EVAL_UPSTREAM_API_KEY
COLDX_EVAL_DOWNSTREAM_TOKEN
```

The standalone CLI requires an explicit downstream token because it will never print a generated token. In-process launchers can omit it and read the generated token in memory.

```bash
node evaluation-proxy.mjs --upstream-base-url https://api.deepseek.com --port 8097 --max-requests 500 --timeout-ms 180000
```

Optional flags: `--host`, `--port`, `--max-requests`, `--timeout-ms`, `--max-body-bytes`. Binding beyond loopback requires an explicit `--host`; default binding is `127.0.0.1`. The CLI prints only the listen URL and safe statistics at startup and graceful shutdown. Configuration errors are static messages; provider messages and bodies are never logged. `--help` does not require credentials.

For Pier's restricted task network, use the external credential boundary described in [EXTERNAL-PROXY.md](EXTERNAL-PROXY.md). Run the **in-container session proxy/launcher process** with Node 24's `--use-env-proxy` or `NODE_USE_ENV_PROXY=1` and Pier's explicitly injected `HTTP_PROXY`/`HTTPS_PROXY` environment. The session launcher explicitly loads the locked Undici module and supplies its environment-aware dispatcher to this module. Module-only loopback calls may use the global defaults; they do not validate the production Pier route. The native ColdX child can independently use its cleaned environment and the local proxy token. Keep loopback in an explicit `NO_PROXY` where the deployment requires it. The loopback test suite does not validate a production Pier egress gateway.

## Local verification

No real model, external network API, paid service or private credential is used by the tests:

```bash
node --test --test-timeout=10000 evaluation-proxy.test.mjs start-external-proxy.test.mjs evaluation-dispatcher.test.mjs
```

Tests start HTTP fake upstreams on loopback and cover parameter forcing, credential separation, routing, JSON/body limits, concurrent budget reservation, incremental SSE, HTTP errors, redirect refusal, pre-header/stream timeouts, cancellation, slow-reader backpressure, upstream truncation, shutdown statistics, bounded usage accounting, explicit pricing, owned-file isolation, upload limits, and two-hop multimodal upload → file reference → chat completion. Linux process and network isolation require a separate container acceptance check.

Set `COLDX_EVAL_UNDICI_MODULE` to the existing locked module for the dispatcher-specific proxy protocol test; without that explicit module the one dependency-requiring test is skipped. Linux verification used the prepared app's locked Undici 7.29.1 module: 27 tests passed with no skips. Configure your own absolute module path; dependency binaries are not distributed here. The separate actual Docker acceptance is documented in `README-docker-egress-smoke.md` (operator-generated report, excluded from this code package); no paid inference occurred.

The experiment manifest must identify this transport parameter override and its counters. It does not add native `topP` support to an older ColdX adapter, reproduce DeepSeek's private environment preparation, or establish equivalence to unpublished scaffold configurations.
