# Token Efficiency and Cache Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make provider cache behavior and context pressure visible now, reduce avoidable prompt churn, and define the provider-aware path for measurable token savings.

**Architecture:** Phase one consumes native DSH usage projections and adds a short stable efficiency policy. It does not forge unsupported provider parameters. Future provider adapters use a canonical PromptPlan and capability matrix documented in the design spec.

**Tech Stack:** DSH token projections and compaction command, native system-prompt section, Node test runner, provider usage metadata.

**Spec:** `docs/frost-workbench-design.md`

## Global Constraints

- Prefix-cache correctness is best effort and never a dependency of task correctness.
- Cache hit ratio excludes output tokens.
- DeepSeek receives no unsupported `prompt_cache_key` or breakpoint parameters.
- Volatile data remains at the request tail when a future provider adapter is added.
- Context compaction preserves goals, constraints, decisions, side effects, pending work, artifacts, and evidence.

---

### Task 1: Cache and pressure presentation model

**Files:**
- Modify: `plugin/client/session-controls-source.mjs`
- Modify: `test/session-controls.test.mjs`

**Interfaces:**
- Consumes: native `tokenUsage` and `contextPressure` projection snapshots.
- Produces: normalized cache totals, ratio text, meter values, reporting labels, and compact recommendation state.

- [ ] **Step 1: Write failing token math tests**

Use concrete fixtures: `{uncachedInputTokens: 300, cacheReadTokens: 600, cacheWriteTokens: 100, outputTokens: 200}` must produce a 60 percent cache ratio; missing projections produce `暂无统计`; a reported zero produces `0%`; projected pressure uses `projectedTokens / contextWindow` and recommends compaction at 72 percent.

- [ ] **Step 2: Verify the tests fail**

Run: `node --test test/session-controls.test.mjs`  
Expected: FAIL on missing cache presentation behavior.

- [ ] **Step 3: Implement deterministic calculations**

Use integer-safe arithmetic for displayed percentages, guard every optional field, clamp meters to 0-100, and keep provider totals separate from output.

- [ ] **Step 4: Verify tests pass**

Run: `node --test test/session-controls.test.mjs`  
Expected: cache and pressure tests PASS.

### Task 2: Short stable token-efficiency policy

**Files:**
- Modify: `plugin/policy.mjs`
- Modify: `test/policy.test.mjs`

**Interfaces:**
- Consumes: the existing stable ColdX operating-policy section.
- Produces: a small immutable policy that prevents avoidable repeated context and volatile-prefix guidance.

- [ ] **Step 1: Write a failing policy contract test**

Assert the policy tells the agent to reuse existing artifacts by reference, avoid repeating long tool results, keep temporary findings out of durable instructions, use targeted inspection before broad listings, and compact only when context pressure warrants it.

- [ ] **Step 2: Verify the policy test fails**

Run: `node --test test/policy.test.mjs`  
Expected: FAIL on the first missing efficiency rule.

- [ ] **Step 3: Add one concise stable section**

Add no timestamps, IDs, provider state, or workspace state. Keep the section below 140 English words so the permanent prompt cost stays bounded.

- [ ] **Step 4: Verify policy tests pass**

Run: `node --test test/policy.test.mjs`  
Expected: policy tests PASS.

### Task 3: Provider capability roadmap and observability evidence

**Files:**
- Modify: `README.md`
- Modify: `docs/verification.md`

**Interfaces:**
- Consumes: official provider research linked in the spec.
- Produces: operator guidance that distinguishes current native DeepSeek caching from future provider-specific adapters.

- [ ] **Step 1: Document current visible behavior**

Describe the work-mode cache meter, DSH token buckets, the `/compact` action, the 72 percent recommendation threshold, and the fact that a KV hit lowers repeated prefill work but does not reuse an answer.

- [ ] **Step 2: Document a reproducible warm-cache check**

Specify two requests with an identical long prefix and different tail questions, record provider cache-read fields, then change a stable tool or system prefix and confirm the expected miss. Mark unavailable provider fields as unknown.

- [ ] **Step 3: Add future adapter constraints**

Record DeepSeek automatic prefix behavior, OpenAI keys/breakpoints, Anthropic TTL/breakpoints, and vLLM APC plus tenant salt without claiming these are already configured in DSH rc.2.

### Task 4: Full regression and browser acceptance

**Files:**
- Modify: `docs/verification.md`

**Interfaces:**
- Consumes: all earlier tasks.
- Produces: fresh deterministic and Computer Use evidence.

- [ ] **Step 1: Run the full suite from generated source**

Run: `pnpm test`  
Expected: build exits 0 and every Node test passes.

- [ ] **Step 2: Verify generated bundle parity and diff quality**

Run: `node plugin/client/build.mjs`  
Run: `git diff --check`  
Expected: no generated mismatch and no whitespace errors.

- [ ] **Step 3: Exercise the UI with Computer Use**

In `http://127.0.0.1:3086/`, verify the work-mode trigger, Plan toggle, Goal creation/edit/pause/resume/clear, cache/pressure labels after model usage, Escape/focus behavior, a generated interaction continuation, and the existing details inspector.

- [ ] **Step 4: Exercise accessibility variants**

Verify a narrow viewport, keyboard-only navigation, Reduced Motion, and a solid fallback when transparency is reduced. Record observed limitations rather than inferring unavailable provider cache fields.

