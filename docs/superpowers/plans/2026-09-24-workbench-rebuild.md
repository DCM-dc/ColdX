# Native workbench rebuild implementation plan

> Execute inline using superpowers:executing-plans. Prior instruction is autonomous execution; preserve existing source and validate before claiming completion.

**Goal:** Deliver a functional pixel-referenced reproduction of the current Windows Codex workbench on native DSH.
**Architecture:** Replace client composition and chrome, retain proven native adapters and runtime. Actual captured Codex states determine dimensions, typography, grouping and interactions. Preserve native functional services; do not replace missing capabilities with inert buttons.
**Tech Stack:** Pinned DSH rc.2, its React/slots/theme services, existing authenticated host RPC.
**Spec:** docs/superpowers/specs/2026-09-24-workbench-rebuild.md

## Constraints and review focus

No new agent loop, no credential migration, no desktop pet, no fake controls, no publish/install. Preserve pending approvals and generated-tool carrier ownership; unchanged composer metrics; repeated inspector toggles; model/theme menus; short/narrow viewport.

## Tasks

1. Preserve baseline and establish clean assembly: new `plugin/client/workbench-entry.mjs` and `workbench-shell-source.mjs`, `build.mjs` loads only the required modules. Add behavior tests for registered native seats and absent experiment activation, run red then green.
2. Fresh `workbench-rebuild.css` owns typography, layout, header, composer and menu styling. Retain narrowly scoped file/PDF/computer/terminal presentation, remove legacy global style layers from build. Test native chrome and visual responsive states.
3. Run isolated actual DSH preview, complete send/result/file/setting loop using Computer Use. Run full tests and focused browser regressions, review changes independently, document limits and leave a runnable preview.
4. User clarification: inspect reference navigation, task menus, plus menu, model slider, full-page plugins/schedules/settings and side previews. Implement the functional equivalent over native owners, including a typed workbench RPC for schedule and read-only PR operations. Exercise new controls in the isolated profile, document observed states and parity boundaries.

## Baseline

2026-09-24: 716 tests, 714 passed, 2 environment-gated skips, 0 failed before implementation. User's original source and data preserved.

## Reference measurements

Private local Codex screenshots at .runtime/codex-reference (never publish). At 2048 × 1111 screenshot pixels: sidebar 294, reading/composer width 740, summary width 300 with 16 right inset, 32px navigation rows, 20px composer radius. Browser viewport comparison excludes native OS title bar. Addition menu shares composer width and uses single-line label/description rows.

## Package calibration, 2026-09-25

User requested direct package inspection because the screenshot approximation was insufficient. Read-only extraction of the installed Codex 26.915.4065.0 ASAR is complete; the inventory and selected resources stay in ignored `.runtime/codex-package-26.915.4065`. Independently implement the measured desktop design tokens in the existing ColdX presentation layer. Supersede approximate measurements with a 768px reading column, 22px composer radius, 28px composer controls, 31px desktop navigation rows and the package's neutral light/dark palette. Preserve DSH input/mirror/backdrop metric equality and context-injection disclosure. Calibrate message bubbles, menu rows, focus/hover feedback and panel headers together; verify real typing, mode toggles, model menu, files, dark theme and narrow layout in the isolated fixture. No extracted executable code, fonts or assets enter the product or repository.
