# Goal and Plan Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose durable native DSH goal management, plan mode, and their truthful pending states through a single discoverable Frost work-mode panel.

**Architecture:** A self-contained client factory reads native `goal`, `plan`, `tokenUsage`, and `contextPressure` projections. It routes every mutation through `remote.commands.execute`, so native persistence, CAS checks, plan review, and command history remain authoritative.

**Tech Stack:** DSH projections and Remote commands, React supplied by DSH, Frost components, Node test runner.

**Spec:** `docs/frost-workbench-design.md`

## Global Constraints

- Goal and Plan are independent; do not flatten them into one local mode enum.
- Plan mode does not change sandbox or permission policy.
- Native `exit_plan_mode` remains the only plan-review acceptance path.
- UI success text follows the native command result and projected state.
- A pending plan transition is shown as pending until DSH applies it at a safe boundary.

---

### Task 1: Work-mode state model and command routing

**Files:**
- Create: `plugin/client/session-controls-source.mjs`
- Create: `test/session-controls.test.mjs`

**Interfaces:**
- Consumes: `React`, `createFrostComponents`, `sessionId`, `useProjection`, and `executeCommand(command)`.
- Produces: `createSessionControls(React, createFrostComponents)` returning `WorkModeControl`, `effectivePlanState`, `goalState`, and `cacheStats`.

- [ ] **Step 1: Write failing state-model tests**

Cover absent projections, `plan.active`, each pending transition, goal phases, zero-token usage, cache ratio excluding output, and context-pressure percentage clamping.

- [ ] **Step 2: Verify the state tests fail**

Run: `node --test test/session-controls.test.mjs`  
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the pure model inside the serialized factory**

Return labels and booleans derived only from projections. Define command strings exactly as `/plan`, `/plan off`, `/goal <objective>`, `/goal edit <objective>`, `/goal pause`, `/goal resume`, `/goal clear`, and `/compact`.

- [ ] **Step 4: Verify the state-model tests pass**

Run: `node --test test/session-controls.test.mjs`  
Expected: model tests PASS.

### Task 2: Interactive work-mode panel

**Files:**
- Modify: `plugin/client/session-controls-source.mjs`
- Modify: `test/session-controls.test.mjs`

**Interfaces:**
- Consumes: Frost `Surface`, `Action`, `Status`, `Field`, `Meter`, and `Disclosure`.
- Produces: a keyboard-accessible `WorkModeControl` and native command invocations.

- [ ] **Step 1: Add failing interaction tests**

Assert the trigger describes active goal/plan state, Escape closes and returns focus, outside pointer closes, goal input rejects whitespace, only one native command may be pending, failures remain visible, and an unmounted control ignores a late result.

- [ ] **Step 2: Verify failures are behavioral**

Run: `node --test test/session-controls.test.mjs`  
Expected: FAIL on the first missing interaction behavior.

- [ ] **Step 3: Implement the panel**

Use one popover-like bounded `Surface`, an independent plan toggle, goal create/edit and pause/resume/clear controls, cache and pressure meters, and a compact action. Add document listeners only while open and remove them on close or unmount.

- [ ] **Step 4: Verify the interaction tests pass**

Run: `node --test test/session-controls.test.mjs`  
Expected: all work-mode tests PASS.

### Task 3: Register the native Remote integration

**Files:**
- Modify: `plugin/client/client-source.mjs`
- Modify: `plugin/client/build.mjs`
- Modify: `plugin/client/client.js`
- Modify: `plugin/client/package.json`
- Modify: `test/client.test.mjs`

**Interfaces:**
- Consumes: `ctx.remote.commands.execute(sessionId, command, [])`.
- Produces: the `conversation.input.left` WorkModeControl and preserved native plan/goal UI.

- [ ] **Step 1: Add a failing client integration test**

Assert required client injections include `remote` and `remote.commands`, the registered entry receives `sessionId` and `useProjection`, `/plan` and `/goal` calls pass through untouched, and an unknown command result becomes a visible error.

- [ ] **Step 2: Verify the focused test fails**

Run: `node --test test/client.test.mjs`  
Expected: FAIL because the Remote command bridge is absent.

- [ ] **Step 3: Wire the native command bridge**

Instantiate `factories.sessionControls`, provide an `executeCommand` function that validates `sessionId`, awaits `ctx.remote.commands.execute(sessionId, command, [])`, and treats `ok:false` or `value === undefined` as failure. Keep the existing native goal dock and plan chip registered by DSH.

- [ ] **Step 4: Rebuild and verify focused tests**

Run: `node plugin/client/build.mjs`  
Run: `node --test test/client.test.mjs test/session-controls.test.mjs`  
Expected: build exits 0 and tests PASS.

### Task 4: Protect native plan review from the ColdX completion guard

**Files:**
- Modify: `plugin/page-guard.mjs`
- Modify: `test/page-guard.test.mjs`

**Interfaces:**
- Consumes: native `plan` projection and plan-review question intent.
- Produces: a guard that does not inject a competing ColdX completion while native plan review owns the boundary.

- [ ] **Step 1: Write a failing native plan boundary regression**

Construct a real projected active/pending plan and plan-review interaction. Assert no `coldx_finish` correction is injected while plan review is pending or its accepted exit is being folded.

- [ ] **Step 2: Verify the regression fails for the expected guard behavior**

Run: `node --test test/page-guard.test.mjs`  
Expected: FAIL because the guard currently considers only ColdX flow state.

- [ ] **Step 3: Add the narrow plan boundary exemption**

Read the existing native state or events without introducing a second plan state machine. Skip only when a native plan review boundary is actually present.

- [ ] **Step 4: Verify the regression and existing guard tests**

Run: `node --test test/page-guard.test.mjs test/interaction-model.test.mjs`  
Expected: all tests PASS.

