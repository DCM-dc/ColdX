# ColdX Frost Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task with test-first evidence and review after every task.

**Goal:** Turn ColdX into a polished, Apple-inspired task workbench with expressive motion, discoverable native Goal and Plan controls, truthful task state, and visible token-cache efficiency while preserving DSH as the only execution kernel.

**Architecture:** Self-contained React factories provide the Frost component system and session controls to the existing serialized lazy client. Native DSH projections and commands remain authoritative for Goal, Plan, token usage, context pressure, tool calls, and session recovery. CSS owns materials and motion fallbacks; client components only animate state transitions after native state changes.

**Tech Stack:** Node.js 24, native ESM, DSH 0.1.1-rc.2 projections and Remote commands, React supplied by DSH, CSS custom properties, Node test runner.

**Spec:** `docs/frost-workbench-design.md`

## Global Constraints

- Preserve DSH as the single agent loop, session store, tool runtime, permissions layer, Goal/Plan owner, and transport.
- Preserve generated interfaces inline at their native `tool.call.toolview` positions and typed submit values bound to the original call ID.
- Every serialized factory is self-contained and reuses the React instance supplied by DSH.
- Motion is interruptible; Reduced Motion removes spatial motion and Reduced Transparency removes blur.
- Plan and Goal are independent native states. A pending transition stays visibly pending until its projection changes.
- Cache figures come only from provider usage. Unknown remains unknown; output tokens are excluded from cache-hit ratios.
- Existing working-tree contributions and the staged snapshot must not be reset or overwritten.

### Task 1: Frost component and material foundation

**Files:**
- Create: `plugin/client/frost-source.mjs`
- Create: `plugin/client/frost.css`
- Create: `test/frost-components.test.mjs`
- Create: `test/frost-css.test.mjs`

**Requirements:**
- Export `createFrostComponents(React, createMotionRuntime)` returning `Surface`, `Action`, `Status`, `Field`, `Meter`, `Disclosure`, and `pressHandlers`.
- Cover semantic elements, button defaults and labels, visible status text, clamped accessible meters, shared interruptible press motion, caller handler composition, and class/attribute preservation.
- Define documented `--cx-sys-*` and `--cx-motion-*` tokens plus bounded material, component, focus, coarse-pointer, Reduced Motion, Reduced Transparency, high-contrast, and forced-colors rules.
- Keep blur off structural sidebar ancestors and animate only transform, opacity, color, border, and shadow.

**TDD:** Write both tests first, run them and capture the expected missing-module/file failures, implement, then run `node --test test/frost-components.test.mjs test/frost-css.test.mjs`.

### Task 2: Native work-mode model and Frost control

**Files:**
- Create: `plugin/client/session-controls-source.mjs`
- Create: `test/session-controls.test.mjs`

**Requirements:**
- Export `createSessionControls(React, createFrostComponents)` returning `WorkModeControl`, `effectivePlanState`, `goalState`, and `cacheStats`.
- Derive only from native `goal`, `plan`, `tokenUsage`, and `contextPressure` projections.
- Route exact commands `/plan`, `/plan off`, `/goal <objective>`, `/goal edit <objective>`, `/goal pause`, `/goal resume`, `/goal clear`, and `/compact` through one supplied async executor.
- Build one keyboard-accessible bounded panel with independent Plan and Goal controls, native pending/error state, one in-flight command, Escape/focus return, outside-pointer close, and late-result unmount safety.
- Cache ratio excludes output; `{uncachedInputTokens:300,cacheReadTokens:600,cacheWriteTokens:100}` yields 60%; unknown and reported zero remain distinct. Recommend compaction at 72% projected pressure.

**TDD:** Write model and interaction tests first, confirm the expected missing-module failure, implement, then run `node --test test/session-controls.test.mjs`.

### Task 3: Client integration and workbench visual migration

**Files:**
- Modify: `plugin/client/build.mjs`
- Modify: `plugin/client/client-source.mjs`
- Modify: `plugin/client/client.js`
- Modify: `plugin/client/coldx.css`
- Modify: `plugin/client/native.css`
- Modify: `plugin/client/motion-source.mjs`
- Modify: `plugin/client/stage-source.mjs`
- Modify: `plugin/client/interaction-source.mjs`
- Modify: `test/client.test.mjs`
- Modify: `test/motion.test.mjs`
- Modify: `test/interaction-components.test.mjs`
- Modify or create focused visual/state tests as needed.
- Create: `test/native-secondary-surfaces.test.mjs`

**Requirements:**
- Serialize Frost and session-control factories, append Frost CSS, and inject native `remote` plus `remote.commands`.
- Register `WorkModeControl` in `conversation.input.left`; validate `sessionId`; pass commands unchanged to `ctx.remote.commands.execute(sessionId, command, [])`; expose `ok:false` or missing values as visible errors.
- Preserve composer selection, native Goal/Plan UI, DSH theme ownership, call-ID association, iframe CSP, submit idempotency, and iframe identity.
- Apply Frost hierarchy to the shell, conversation cards, composer, inline generated pages, questions, and details surfaces without changing their data ownership.
- Restyle both composer secondary surfaces rather than only their triggers: the command listbox (`._3e4SsG_menu` / `._3e4SsG_item`) and model menu (`._7KE1Ra_menu`, groups, options, and selected state) use Frost floating material, grouped hierarchy, bounded scrolling, visible focus/selection, and an expressive entrance. Preserve their native portal positioning, roles, keyboard behavior, and scroll ownership.
- Add expressive `materialize` and `confirm` runtime recipes using transforms, opacity, and bounded highlight shadow; avoid animated filter/blur. Play completion motion only after native/typed acceptance. Settled generated iframes become inert and visibly settled.

**TDD:** Extend focused client and stage tests first, verify behavioral failures, implement, rebuild with `node plugin/client/build.mjs`, then run focused tests.

### Task 4: Protect native Plan review from completion correction

**Files:**
- Modify: `plugin/page-guard.mjs`
- Modify: `test/page-guard.test.mjs`

**Requirements:**
- Add a regression with real projected active/pending Plan state and the native plan-review interaction.
- Skip `coldx_finish` only while a native Plan review boundary is pending or its accepted exit is being folded.
- Read native state/events; do not add a second Plan state machine or weaken ordinary completion enforcement.

**TDD:** Add and run the failing regression, implement the narrow exemption, then run `node --test test/page-guard.test.mjs test/interaction-model.test.mjs`.

### Task 5: Stable token-efficiency policy and operator evidence

**Files:**
- Modify: `plugin/policy.mjs`
- Modify: `test/policy.test.mjs`
- Modify: `README.md`
- Modify: `docs/verification.md`

**Requirements:**
- Add one stable policy section under 140 English words: reuse artifacts by reference, avoid repeating long tool output, keep transient findings out of durable instructions, inspect narrowly before broad listings, and compact only when pressure warrants it.
- Document the visible cache meter, native token buckets, `/compact`, 72% recommendation, and that a KV hit reuses prefix computation rather than an answer.
- Document a reproducible warm-prefix check and mark unavailable fields unknown.
- Record provider-aware future constraints for DeepSeek automatic exact-prefix caching, OpenAI cache keys/breakpoints, Anthropic TTL/breakpoints, and vLLM APC with tenant isolation. Do not claim unsupported parameters are configured in this DSH release.

**TDD:** Add the policy contract first and capture its failure, implement, run the policy test, then review documentation links and claims against the spec.

### Task 6: Full verification and Computer Use acceptance

**Files:**
- Modify: `docs/verification.md`

**Requirements:**
- Run `pnpm test`, rebuild once, and run `git diff --check`.
- Use Computer Use at `http://127.0.0.1:3086/` to verify the trigger, Plan pending/truthful transition, Goal create/edit/pause/resume/clear, cache/pressure labels, Escape/focus behavior, generated interaction continuation, settled-page behavior, and details inspector.
- Check narrow layout, keyboard navigation, Reduced Motion, and Reduced Transparency when the browser surface permits; record any unavailable provider fields or emulation limits as observations.
- Record commands, pass counts, and UI observations with timestamps in `docs/verification.md`.
