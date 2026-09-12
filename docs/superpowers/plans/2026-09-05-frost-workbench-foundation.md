# Frost Workbench Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable Apple-inspired Frost component and motion foundation and use it for ColdX work-mode UI without changing DSH execution ownership.

**Architecture:** A self-contained factory supplies React components to the existing lazy client build, while `frost.css` owns semantic tokens, materials, and accessibility fallbacks. The factory reuses the single React instance supplied by DSH and delegates press motion to the existing interruptible runtime.

**Tech Stack:** Node.js 24, native ESM source, DSH lazy client factory, React supplied by DSH, CSS custom properties, Node test runner.

**Spec:** `docs/frost-workbench-design.md`

## Global Constraints

- DSH 0.1.1-rc.2 remains the only execution kernel and React provider.
- Generated interfaces remain inline at their native `tool.call.toolview` positions.
- New factories must be self-contained because `build.mjs` serializes `Function#toString()`.
- Motion is interruptible and Reduced Motion removes all spatial motion.
- Existing working-tree contributions must not be reset or overwritten from the staged snapshot.

---

### Task 1: Frost component semantics

**Files:**
- Create: `plugin/client/frost-source.mjs`
- Create: `test/frost-components.test.mjs`

**Interfaces:**
- Consumes: `React` and `createMotionRuntime`.
- Produces: `createFrostComponents(React, createMotionRuntime)` returning `Surface`, `Action`, `Status`, `Field`, `Meter`, `Disclosure`, and `pressHandlers`.

- [ ] **Step 1: Write failing component tests**

Test a minimal React stub and assert that `Surface` preserves the requested semantic element, `Action` is a `type="button"` button with an accessible label, `Status` exposes text without color-only meaning, `Meter` clamps its value and provides `aria-valuemin/max/now`, and pointer handlers call the shared motion runtime.

- [ ] **Step 2: Verify the tests fail because the module is absent**

Run: `node --test test/frost-components.test.mjs`  
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `frost-source.mjs`.

- [ ] **Step 3: Implement the self-contained Frost factory**

Use `React.createElement`, create no second React runtime, keep every helper inside `createFrostComponents`, merge caller class names and attributes, and return pointer press/release/cancel handlers that never delay the caller's event.

- [ ] **Step 4: Verify component tests pass**

Run: `node --test test/frost-components.test.mjs`  
Expected: all Frost component tests PASS.

### Task 2: Frost tokens and accessibility fallbacks

**Files:**
- Create: `plugin/client/frost.css`
- Create: `test/frost-css.test.mjs`

**Interfaces:**
- Consumes: DSH `--dsw-*` theme tokens under `[data-slot="root"]`.
- Produces: `--cx-sys-*`, `--cx-motion-*`, and `.cx-*` component classes.

- [ ] **Step 1: Write failing CSS contract tests**

Assert semantic token definitions, four material modes, focus-visible styling, a 44 px coarse-pointer target, `prefers-reduced-motion`, `prefers-reduced-transparency`, `prefers-contrast: more`, and `forced-colors` fallbacks. Assert structural sidebar ancestors never receive `backdrop-filter`.

- [ ] **Step 2: Verify the tests fail because the stylesheet is absent**

Run: `node --test test/frost-css.test.mjs`  
Expected: FAIL reading `plugin/client/frost.css`.

- [ ] **Step 3: Implement the stylesheet**

Define the documented token scales, `Surface`, `Action`, `Status`, `Field`, `Meter`, `Disclosure`, and work-mode panel presentation. Use blur only on bounded floating surfaces and animate only `transform`, `opacity`, color, border, and shadow.

- [ ] **Step 4: Verify CSS tests pass**

Run: `node --test test/frost-css.test.mjs`  
Expected: all Frost CSS tests PASS.

### Task 3: Integrate the factory into the lazy build

**Files:**
- Modify: `plugin/client/build.mjs`
- Modify: `plugin/client/client-source.mjs`
- Modify: `plugin/client/client.js`
- Modify: `test/client.test.mjs`

**Interfaces:**
- Consumes: `factories.frost` and the existing `factories.motion`.
- Produces: a ColdX client bundle that injects Frost without adding an external dependency.

- [ ] **Step 1: Extend the client test with a missing Frost factory failure**

Update `mountClient()` to pass a deterministic Frost stub and assert the composer-left entry renders the Frost work-mode trigger while retaining the two inline tool renderers and composer ownership behavior.

- [ ] **Step 2: Verify the focused client test fails**

Run: `node --test test/client.test.mjs`  
Expected: FAIL because `client-source.mjs` does not consume the Frost factory.

- [ ] **Step 3: Add the build and client integration**

Import `createFrostComponents`, add it to serialized factories, append `frost.css` to the stylesheet order, and pass the factory to the work-mode component. Do not alter the call-ID association, `conversation.composer` selection, or DSH theme ownership.

- [ ] **Step 4: Rebuild and verify**

Run: `node plugin/client/build.mjs`  
Run: `node --test test/client.test.mjs test/frost-components.test.mjs test/frost-css.test.mjs`  
Expected: build exits 0 and all focused tests PASS.

