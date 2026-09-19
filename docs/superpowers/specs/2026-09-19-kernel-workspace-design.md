# ColdX execution kernel and workspace redesign

## Intent and authorization

The user asks for a substantive kernel overhaul, higher performance and a UI close to Codex. Prior instruction is autonomous execution without questions. This spec records the implementation decisions for review without inserting additional approval gates. Quality, compatibility and measured improvements take precedence over removing an upstream name. Existing DSH storage, provider adapters, permissions, plugin interfaces and attribution remain; ColdX owns the execution-control, stream-processing and workspace presentation implemented here. This is not a claim of an entirely independent model runtime.

## Chosen approach

Retain the tested DSH event/storage spine and implement a distinct ColdX kernel with bounded fair request admission, cancellation, context accounting and execution telemetry. Replace the quadratic ColdX protocol guard scanner. Rebuild the workspace chrome and avoid rebuilding full activity projections on irrelevant updates. A complete runtime rewrite would endanger session/plugin compatibility; CSS-only changes do not meet the request.

## Kernel contract

- A profile-owned `coldxKernel` service serves all ColdX-owned root/child agents. Requests from unrelated presets are not intercepted.
- `RequestScheduler.acquire({owner,priority,signal})` returns an idempotent release function. Default maximum 4 active requests and 64 queued; roots are interactive priority, child/background requests normal. After at most 3 interactive admissions a waiting normal request proceeds. FIFO within each class. Abort removes a queued request promptly, disposal rejects waiters, and permits are released on finish, throw, consumer return and cancellation. No automatic retries or duplicate model calls.
- `ContextMeter.measure(request)` returns numeric counts only: system/message/tool characters, message/tool counts, memo hit/work counters. Immutable content subtrees may be cached; mutable objects must be remeasured. It preserves message order, reasoning replay, images and tool pairs, and never truncates or rewrites the provider request. Counts are explicitly characters/estimates rather than invented token savings or cache hits.
- An execution ledger records bounded numeric request and tool outcomes: queued/active count, queue/first-chunk/total duration, actual provider-reported usage, failures, cancellations, tool counts. Never stores prompts, arguments, output text, credentials or reasoning. Snapshots disclose no other session's identifiers or data.
- `coldxKernel/read` takes an exact live Agent and returns its own numeric metrics plus global queue counts. Child access uses the existing verified parent/child access boundary. The kernel summary is a small optional UI disclosure, not a second activity log.
- Native scope/lifecycle must own cleanup. The installed app and existing user's working checkout are not modified during development.

## Stream processing

Replace per-delta full-buffer scans in `repairProtocolStream` with incremental line/fence/control-marker tracking. Preserve literal fenced/quoted examples, split delimiters, Unicode marker variants, idle reminders, native tool calls, final authoritative text, chunk ordering, finish/replay and partial/cancel behavior. Existing tests plus adversarial boundary equivalence tests decide correctness. Benchmark against the frozen 0.1.4 implementation using identical synthetic streams, reporting timings, input size and output equality. A parser benchmark is not an end-to-end model quality score.

## Workspace UI

Use the existing licensed ColdX brand as a small sidebar identity. Replace the oversized logo landing composition with a compact task-oriented heading. Match Codex's information hierarchy: quiet left task list, central transcript/composer, right results surface. Monochrome neutral chrome, 1px separators, restrained accent for selection, common 8/12/16/24 spacing, 32px controls (44px touch), coherent 10/14px corners, no glowing composer or giant gradient shells. Keep the unified plus menu, Goal/Plan chips, reasoning slider/dumbbell, uploaded/reference files, execution status, browser/computer and terminal functional.

The work panel has one header and coherent tabs, genuine space for file/browser content, compact expandable process rows, responsive drawer behavior and accessible focus/escape. Support dark/light, 820px desktop minimum and 390px browser layout. Decorative transitions are short opacity/transform changes, honor reduced motion and never animate streaming text/layout continuously.

Activity projection caches must invalidate for actual native updates, owner switches, child/job changes and file artifacts. Never cache mutable snapshot identity alone; verify the native update contract before choosing cache keys. Do not hide current errors or running work to gain speed.

## Evidence and boundaries

Baseline c58d63d: 647 tests, 645 pass, 0 fail, 2 conditional skips. Verify native streaming/cancellation/child ownership with deterministic adapters; run browser interaction and real isolated UI acceptance. Publish local CPU/allocation/parser metrics with reproducible scripts and their exact scope. No paid model quality uplift is claimed without controlled live evaluation. Preserve DeepSeek/DSH attribution and existing source licenses.

References checked: [DeepSeek prefix cache](https://api-docs.deepseek.com/guides/kv_cache/), [DSH context and compaction seams](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/compaction). Installed rc.2 code is authoritative where rolling docs differ. Dynamic counters do not enter model system prompts.
