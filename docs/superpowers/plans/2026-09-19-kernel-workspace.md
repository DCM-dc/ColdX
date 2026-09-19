# ColdX kernel and workspace implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for independent parser and UI tasks; root implements integration. Track the checkboxes below.

**Goal:** Ship a substantive owned execution layer and a coherent Codex-style workspace with measured local performance improvements.

**Architecture:** Native DSH owns durable sessions/transport/permissions. ColdX kernel admits requests, accounts for context and exposes bounded telemetry; its protocol parser processes streaming text incrementally. Native UI slots mount a redesigned workspace and an optional kernel readout.

**Tech Stack:** Node 24, pinned DSH rc.2, Cordis/Typert, host React instance, CSS, node:test and pinned Playwright.

**Spec:** `docs/superpowers/specs/2026-09-19-kernel-workspace-design.md`

## Global constraints

- Preserve session/prompt/tool-result semantics, original checkout and installed app during development.
- No extra prompt injections, automatic retries, paid evaluation or fabricated performance/usage values.
- Kernel telemetry has no message text, arguments, paths, keys or reasoning; keep maps/queues bounded.
- Keep upstream licenses and candid architectural attribution.

## Review focus

1. Root disposal or queued cancellation must not leave a request running or leak a permit (Task 1).
2. Mutable context content and authoritative text replacement must invalidate caches/scanner assumptions (Tasks 1/2).
3. A long fenced example or delimiter split at any character boundary must not become an executable tool (Task 2).
4. Same-session live updates and child ownership changes must update activity; cross-session metrics remain isolated (Tasks 1/3).
5. Narrow/dark/reduced-motion UI preserves typing, plus menu, modes, selection and file/browser controls (Task 3).

## Task 1: Execution kernel and native integration — root

Files: `lib/kernel/scheduler.mjs`, `lib/kernel/context-meter.mjs`, `lib/kernel/ledger.mjs`, `plugin/kernel-host.mjs`, `lib/profile.mjs`, `test/kernel-*.test.mjs`.

Interfaces: `RequestScheduler.acquire({owner,priority,signal}) -> Promise<release>`; `scheduler.snapshot()`; `scheduler.dispose()`; `ContextMeter.measure(request) -> numeric summary`; `KernelLedger.start(owner,metrics) -> request handle`, `snapshot(owner)`. RPC `coldxKernel/read` and verified `readChild` use existing live-agent/address invocation conventions.

- [ ] Write tests that hold 4 leases, abort a queued fifth, verify fair root/child ordering, drain after return/throw, dispose waiters and reject queue overflow.
- [ ] Write tests asserting `measure(frozenRequest)` reuses immutable blocks, mutation is remeasured, image/binary data is not copied and no input changes.
- [ ] Implement bounded scheduler, numeric ledger and context meter. Capture native llm streaming only for ColdX scoped agents; wrap the iterable in try/finally and forward every chunk unchanged.
- [ ] Register profile-owned service and exact-session read RPC; add native deterministic-adapter tests for concurrent roots/children, cancellation, error, provider usage and unrelated presets.
- [ ] Run `node --test test/kernel-*.test.mjs`, integrate optional UI metrics and validate native profile startup.

## Task 2: Incremental protocol engine — isolated implementer

Files: `plugin/protocol-guard.mjs`, optional `lib/kernel/protocol-scanner.mjs`, `test/protocol-guard.test.mjs`, `test/protocol-scanner.test.mjs`, `scripts/bench-protocol.mjs`.

Interface: existing `repairProtocolStream(stream, options)` remains byte/semantic compatible. Benchmark may accept an explicit baseline module path and reports output-equivalent results; keep the frozen baseline outside published code.

- [ ] Add exact-boundary fixtures for markers, fences, quoted examples, long multiline streams and final text replacement; run against existing code to establish behavior.
- [ ] Implement persistent scanning cursor and line/fence state; retain necessary lookbehind. Avoid repeated full-buffer normalization while deciding idle reminder prefixes.
- [ ] Verify all protocol and native tool replay tests; compare 16KiB/128KiB/1MiB text streams against the frozen baseline with fixed chunk sizes.
- [ ] Report equality checks, iterations and median timings without calling them agent quality improvements.

## Task 3: Workspace visual system and activity performance — isolated implementer

Files: `plugin/client/workspace-shell-source.mjs`, `plugin/client/workspace-shell.css`, `plugin/client/activity-source.mjs`, relevant component CSS, UI tests. Root owns `client-source.mjs` and `build.mjs` wiring; implementer reports exact integration edits.

Interface: `createWorkspaceShell(React) -> {Home, KernelStatus}`. `KernelStatus` accepts `{snapshot,loading,error}` only, no RPC ownership. Home is functional presentational content in native home slot; composer remains native. If activity performance caching is unsafe, use bounded subscriptions/lazy rendering with evidence instead of identity-only memoization.

- [ ] Inspect pinned native UI class/slot contracts, current screenshots and browser fixtures; implement the spec's hierarchy/tokens/responsive states.
- [ ] Preserve plus-menu/modes/model slider/terminal/file/computer wiring and existing meaningful controls.
- [ ] Add browser fixture testing narrow layout, themes, keyboard focus and real control interactions; capture screenshots.
- [ ] Optimize a proven activity hot path with correctness fixtures and operation-count/performance evidence.
- [ ] Run relevant client/browser tests; return integration instructions and captures.

## Task 4: Review, measure and deliver — root

- [ ] Run full tests and browser acceptance after integration; resolve regressions and inspect light/dark screenshots.
- [ ] Fresh independent review of cancellation, caches, hidden state, attribution and tests; fix substantive findings.
- [ ] Add reproducible benchmark results and architecture docs. Bump to 0.2.0 only for validated release; package/CI if publishing installer. Push authorized source and release only verified artifacts.
- [ ] Report what changed, measured scope, limitations and installation state accurately.
