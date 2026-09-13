# Actual Pier/Squid Docker acceptance

`docker-egress-smoke.py` uses the prepared pinned Pier `DockerEnvironment` and its generated Squid container. This is an isolated transport/environment test, **not a benchmark, model run, or task score**. It never reads ColdX credentials or user files. The only inference server is a loopback fake provider in the WSL host, protected by a fresh random credential sentinel.

Prerequisites: working Linux Docker Engine and Compose, prepared Linux Node, and the pinned Pier Python environment with the official environment patch applied. Do not run against an uninstalled source copy: Pier's own package metadata and Python dependencies must be installed.

```bash
<PIER_VENV_PYTHON> <BENCHMARK_DIR>/coldx-eval/docker-egress-smoke.py \
  --pier-source <PINNED_PIER_CHECKOUT> \
  --node <LINUX_NODE_BIN> \
  --undici-module <COLDX_APP>/node_modules/.pnpm/undici@7.29.1/node_modules/undici/index.js \
  --output <NEW_SMOKE_OUTPUT>
```

Use a new output directory for every run. The script reads the actual default Docker bridge address and binds its host relay to that address on port 80; it does not open a LAN-wide listener or modify daemon/firewall/package configuration. Port 80 must be free on that bridge. Pier may pull `ubuntu:24.04` and build its standard Squid image with normal setup-network access. Task execution itself uses `allow_internet=false` and the exact bridge IP as its sole inference allowlist destination.

The main task container uses 2 CPUs and 8 GiB memory. It receives only read-only Node/probe inputs and Pier's normal log mounts. It has no host PID namespace, Docker socket, private relay directory or real provider credential. The random relay token, its fixed endpoint and a one-way hash of the provider sentinel are passed only to its probe process.

Checks cover:

- Docker CPU/memory configuration, one internal network, no privileged/host-PID mode.
- Actual write rejection on the read-only probe mount; additive default log mounts remain writable.
- Host credential sentinel absent from task-visible process environments; different host/task PID namespaces and absent private/socket paths.
- Direct host-relay and direct internet connections rejected; nonallowlisted internet rejected by Pier Squid; arbitrary relay paths rejected.
- Native image multipart upload through both proxy hops, followed by a scoped file reference and streamed model response.
- Client cancellation reaches the host fake provider; observed usage is retained and missing cancelled usage stays unknown; files are counted separately from model calls.

The script writes `docker-egress-report.json` containing bounded, credential-free checks and counters. `status=passed` requires all checks; failures name their stage and exception type without dumping arbitrary command/provider errors. It removes only its own Compose containers/network afterward and retains image caches. No reward is produced.

The output's `host-private-relay/` and generated Pier Squid configuration contain temporary **proxy** credentials, even though no real API key is used in this test. Share the sanitized report, not the whole directory. The script does not install Python packages, patch Pier or configure Docker; prerequisite setup remains separate.


All placeholder paths are supplied by the operator. The source package does not bundle Pier, Chromium, task images or runtime binaries. This check has passed with the prepared pinned Linux environment; it must be repeated for another deployment, and its generated private directory is never a public artifact. See [deployment instructions](../README.md).
