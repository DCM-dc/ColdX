# External inference credentials for a ColdX/Pier trial

Run `start-external-proxy.mjs` in the **WSL Docker host**, outside all task containers, their PID namespaces, and their bind mounts. The real API key remains in that host process. The task sees two short-lived proxy tokens, never the provider key:

```text
Native ColdX child
  -> session loopback proxy (random local token)
  -> Pier authenticated Squid egress (exact host allowlist)
  -> WSL host external proxy (random relay token; fixed provider endpoint)
  -> explicit real inference API
```

Each forwarded request makes at most one upstream attempt; the proxies add no retries or model loop and can serve concurrent native calls. Native ColdX retains the full agent loop, tools, system policy and context management. The final hop enforces the documented evaluation wire parameters. This is credential and transport isolation, not a replacement agent.

Native screenshot images use multipart `/files` uploads before chat file references. Both relay hops support this route and restrict subsequent access to IDs uploaded through that same hop. Account-wide listing is replaced with a list of owned uploads; no unrelated provider-account file can be retrieved, referenced or deleted. Independent file budgets and uploaded byte counts are reported under `stats.files`; these are never added to token totals or native model-step counts. See [EVALUATION-PROXY.md](EVALUATION-PROXY.md#native-image-files-api) for the precise accepted operations and documented isolation difference.

## Start on the WSL host

Read the actual Docker default-bridge IPv4 address from `docker network inspect bridge`; do not assume it is `172.17.0.1`. Bind **only that address**, not `0.0.0.0` or a LAN interface. Pier's pinned Squid configuration permits destination ports 80 and 443 only, so this HTTP relay uses port **80** on the isolated bridge. A root/appropriately authorized host process is needed to bind that port. No changes to Pier's allowed port policy are necessary.

Pass `COLDX_EVAL_REAL_BASE_URL` and `COLDX_EVAL_REAL_API_KEY` as explicit environment inputs to the host proxy. Do not put the key in command arguments, logs, task config, or shell history. The launcher never discovers ColdX's credentials automatically. Then, using a **new** output directory outside all agent mounts:

```bash
node start-external-proxy.mjs \
  --host <verified-docker-bridge-ip> --port 80 \
  --advertise-url http://<verified-docker-bridge-ip> \
  --output <NEW_PRIVATE_OUTPUT_OUTSIDE_TASK_MOUNTS> \
  --max-requests 5000 --timeout-ms 10800000 \
  --undici-module <COLDX_APP>/node_modules/.pnpm/undici@7.29.1/node_modules/undici/index.js
```

The launcher creates the directory with mode 0700 and files with mode 0600 on Linux. It refuses to reuse an existing directory. It outputs:

- `downstream.private.json`: a newly generated 256-bit relay token, the bridge endpoint, and `COLDX_EVAL_UPSTREAM_CREDENTIAL_KIND=relay-token`. This contains no real API key, but still grants access to the bounded relay; do not print or publish it.
- `transport-report.json`: model IDs, numerical usage and final wire parameter counters only, updated every 2 seconds and on graceful shutdown. It contains neither credentials nor prompt/response text.

The advertised address must be an HTTP(S) origin, with no credentials, path, query or fragment. It is not automatically tested for reachability. Startup opens a listener only; **it makes no API request**.

The CLI requires an explicit locked Undici module path. It records Undici/Node versions and actual dispatcher settings. Headers/body limits are set to the configured request timeout (the DeepSWE pilot uses its existing 10800-second task limit), avoiding Node's otherwise tighter 300-second dispatcher defaults. Connection establishment has a separately recorded 30-second timeout. This is a network establishment bound, not a generation/time budget. For host inference through a host proxy, explicitly enable `NODE_USE_ENV_PROXY=1` or `--use-env-proxy`; otherwise the external dispatcher connects directly to the fixed inference endpoint.

Supply optional `--pricing-json /outside-task-mounts/pricing.json` only after checking the actual provider prices. Its format is:

```json
{"currency":"USD","uncachedInputPerMillion":1,"cachedInputPerMillion":0.1,"outputPerMillion":2}
```

Those numbers are **schema examples, not DeepSeek or gateway prices**. Omit pricing rather than guessing. Token counts still work without price inputs.

## Connect the task session

The orchestrator reads `downstream.private.json` without printing it and injects its environment keys into the **session launcher**, not into the native ColdX child:

```text
COLDX_EVAL_UPSTREAM_BASE_URL=http://<verified-docker-bridge-ip>
COLDX_EVAL_UPSTREAM_API_KEY=<random relay token>
COLDX_EVAL_UPSTREAM_CREDENTIAL_KIND=relay-token
```

The existing session proxy API is unchanged. The `API_KEY` value here is a proxy token, not a provider key. Native ColdX receives another freshly generated loopback token. Keep the external credential directory, Docker socket, host `/proc`, host runtime environment files, and all user workspaces out of task mounts. Do not grant host PID namespace, privileged mode or host networking to tasks.

The pinned Pier adapter's inference allowlist must contain the exact advertised bridge IP. Pier passes its own authenticated `HTTP_PROXY`/`HTTPS_PROXY` variables to the session launcher. Node must opt into these variables with `--use-env-proxy` or `NODE_USE_ENV_PROXY=1`; `NO_PROXY` must still include `localhost,127.0.0.1` for the native-to-session leg. The adapter automatically passes its locked source's Undici 7.29.1 module via `--undici-module` (overridable with its explicit `undici_module` option). Standalone session calls can instead set `COLDX_EVAL_UNDICI_MODULE`. The configured `EnvHttpProxyAgent` uses `proxyTunnel:false`, which makes HTTP requests ordinary forward-proxy requests. Default Undici would tunnel even HTTP port 80 through CONNECT, which Pier intentionally disallows. HTTPS still tunnels through CONNECT on port 443. No Squid policy change is needed. Do **not** put the external bridge IP in `NO_PROXY`, since the task container is attached to Pier's internal network and should reach inference through Squid.

The external host proxy may use its normal host network route to the fixed provider. It must not inherit the task's Squid proxy credentials. Both proxies reject arbitrary routes, unsupported query strings, redirects and alternate upstream URLs supplied by task requests. Only the documented scoped Files API list accepts its bounded query parameters.

## Acceptance and scoring boundary

Before a paid pilot, run a loopback/mock provider behind the external proxy and verify from a real Pier task container that: direct network access is unavailable; only the allowed inference host is reachable through Squid; native requests receive the expected mock response; the real-key sentinel is absent from task environment/mounts; stream usage appears in both ledgers; cancellations reach the mock upstream. Host-PID/process isolation and endpoint reachability are reported as unverified until this check occurs.

No benchmark score or model identity claim follows from passing this transport test. The official verifier alone awards task rewards. Timeout, missing usage, transport failures and request-limit exhaustion must remain explicit. The module default of 500 requests is a probe safeguard; this deployment example explicitly uses 5000. Neither request cap is the official 500 per-agent native-step rule. Formal experiments must record both limits and any differences from the published environment.

One external relay per trial gives clear usage/cost attribution; if a relay serves multiple sessions its totals include all of them. Do not sum the external and session ledgers because they describe the same API calls. SIGINT/SIGTERM stops the relay, aborts active requests and writes its final numerical report; a hard kill can lose at most the in-memory updates since the last report and must be recorded as an incomplete ledger.
