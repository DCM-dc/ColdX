# ColdX Coding mode revision plan

**Goal:** Replace the manual Work Mode form with a compact `Coding mode` menu whose only choices are Goal and Plan. Selection is persisted by DSH, rendered as small truthful tags, and Goal makes the model infer a native continuing objective from the next real user request.

**Architecture:** Plan continues to use the native `/plan` commands and projection. ColdX adds one Host-owned, event-sourced Goal-selection preference and a dynamic system-prompt contribution; the existing DSH goal tools, goal projection, round driver, permissions, and agent loop remain authoritative. Clicking Goal never launches a model turn or invents an objective. The serialized client reads projections and sends commands only.

## Product contract

- The trigger text is always `Coding mode` with a disclosure chevron.
- The open menu contains exactly two selectable rows: `Goal` and `Plan`. There is no objective field, cache section, compact action, or native-goal editor in this menu.
- Accepted selections appear beside the trigger as small animated `Goal` and `Plan` tags. Pending and error states remain truthful and accessible; browser-local optimistic selection is forbidden.
- Goal and Plan are independent and may both be selected.
- Selecting Goal persists a preference and returns immediately. The next direct human message instructs the root model to inspect the native goal, infer a concise objective grounded in that message, and create or appropriately resume/edit it with native goal tools. Generated notices and autonomous goal rounds never create a new goal from the preference.
- Turning Goal off first pauses an active native goal, retaining its objective, then persists the preference off. Turning it on does not resume work until a real human request arrives.
- Plan keeps `/plan`, `/plan off`, the native projection, and native plan review. Goal bookkeeping is allowed while Plan is active, while other implementation mutations remain governed by Plan.
- Provider-reported cache ratio may appear only as a separate subdued read-only badge outside the two-row menu. Unknown stays hidden; no cache control is mixed into Coding mode.
- Menus and tags use the shared Frost materials and expressive transform/opacity spring motion, with Reduced Motion, Reduced Transparency, contrast, keyboard, focus-return, outside-close, narrow-screen, and coarse-pointer behavior preserved.

## Runtime work

1. Add a validated `coldx.codingMode` projection over a versioned `coldx/coding-mode` event.
2. Add a scoped Host plugin registering `/coldx-goal on|off`, exact live-root checks, safe pause-before-off ordering, and dynamic prompt context. Mount it from `plugin/host.mjs`.
3. Make native terminal `update_goal` complete/blocked a narrow authenticated completion-guard boundary so it does not conflict with the native instruction forbidding later tools.
4. Rebuild `createSessionControls` as `CodingModeControl`, retaining pure Plan/cache helpers as needed and using `coldx.codingMode`, `plan`, `goal`, and provider usage projections only.
5. Update the client command bridge to surface native `result.text` errors. Declare `@deepseek-ai/dsh-api-remotes` in the client manifest so a fresh boot can satisfy `remote` and `remote.commands` injection.
6. Replace the old panel CSS with a compact two-row menu and pop-in tags, then regenerate `plugin/client/client.js`.

## Verification

- Begin with failing focused tests for projection validation, command persistence and no-model-click behavior, first-human-turn goal inference prompt/tool path, off/pause ordering, Plan coexistence, guard boundary, command error text, manifest dependency, and serialized UI behavior.
- Prove the UI has exactly two menu items, no objective input, no cache/compact row, projection-owned tags, bounded command concurrency, Escape/focus restoration, outside close, and no late-result state update.
- Run focused tests, the complete suite, build parity, diff whitespace checks, and fresh-process browser acceptance at `http://127.0.0.1:3086/`.

