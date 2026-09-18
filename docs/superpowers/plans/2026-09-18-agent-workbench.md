# ColdX Agent Workbench Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Track completed tasks here and in the local ledger; do not rerun paid evaluations.

**Goal:** Deliver Windows desktop control, complete browser controls, native Superpowers skills and plugin repair, a clear work panel, and accurate token/balance reporting.

**Architecture:** Native DSH retains the agent loop and permissions. Independent host services expose typed Typert RPCs; serialized React factories reuse native slots. Root owns profile/build/client registration and final integration.

**Tech Stack:** Node24, DSH0.1.1-rc.2, React18 native client, Playwright MCP0.0.80, Electron44, Windows PowerShell5.1/Win32.

**Spec:** ../specs/2026-09-18-agent-workbench-design.md

## Global constraints

- Preserve user data and original checkout edits; work in the existing isolated worktree.
- No second model loop; no secret in renderer; no fake usage/progress/capability claims.
- Baseline tests: 564 pass, 1 skip, 0 failure. Source starts at b90f52e.
- Each implementation owner writes behavioral failing tests first, observes failure, implements, then reports targeted results. Pure cosmetic styling gets visual verification, not implementation-mirroring tests.
- All agents avoid shared integration files `lib/profile.mjs`, `plugin/client/client-source.mjs`, `plugin/client/build.mjs`, generated `client.js`, package/lockfiles, and desktop main/stage unless coordinated with root.

## Task 1: Desktop and browser operation surfaces — desktop_control

Own `plugin/computer-host.mjs`, `computer-preset.mjs`, `browser-driver.mjs`, new desktop controller and Windows helper, computer guides, `plugin/client/computer-source.mjs`, `computer.css`, related tests.

- [x] Test stale observation, wrong owner, cancellation and sequential actions; compile helper self-check without private app actions.
- [x] Implement fixed action protocol and typed RPC as spec, returning real screenshots/controls with bounded traversal.
- [x] Add browser control RPC through native tool runtime; preserve existing cancellation and child lookup contracts.
- [x] Implement `ComputerWorkspace({sessionId,state,pane})`, plus existing status/preview API, and document exact root wiring.
- [x] Test real local browser page and owned desktop fixture; report platform limits and packaging inputs.

## Task 2: Token ledger and upstream balance — usage_insights

Own new `plugin/usage-model.mjs`, `usage-host.mjs`, `usage-balance.mjs`, `plugin/client/usage-source.mjs`, `usage.css`, and dedicated tests/docs.

- [x] Test chunk/message de-duplication, fork seed, missing usage/cache, reasoning, timezones, active time and removed sessions.
- [x] Implement numeric-only cache from sessionQuery/event; bounded scans and disposal cancellation.
- [x] Implement `coldxUsage/read`, `balance`, `settings`; test upstream errors/redirects/identity rotation/thresholds with local fake endpoints, not production keys.
- [x] Implement `createUsageComponents(React,rpc)` returning `UsageEntry`, `UsageSettingsRow`, `BalanceNotice`; true empty/stale/loading/error states and keyboard-accessible heatmap.
- [x] Report native registration config and evidence; root mounts sidebar/settings/banner.

## Task 3: Superpowers and AI-assisted install repair — superpowers_plugins

Own new superpowers host/store/client/CSS/skills sources and docs, marketplace host/jobs/installer/client/tests, model-control source/CSS/tests.

- [x] Test skill toggles do not create sessions; candidate download is not activation; cancellation/bad archive preserve active version; license and commit provenance retained.
- [x] Integrate scoped native skill providers; add typed status/setting/check/stage/activate RPCs and on-demand workflow catalog.
- [x] Add dumbbell `superpowersControl` slot/prop to `ModelControl` without disturbing gestures, focus or selected effort.
- [x] Add failed-job AI repair with native conversation/task identity and result verification; retain audit chain and original job.
- [x] Implement update confirmation UI and settings; report exact root wiring and tests.

## Task 4: Pinned summary, side panel and integration — root

Own `plugin/client/activity-source.mjs`, activity/layout/workbench CSS, `workbench-pane-source.mjs`, `client-source.mjs`, `build.mjs`, `lib/profile.mjs`, desktop release update service/UI and integration tests.

- [x] Add compact top summary and five coherent panel views; maintain preview and focus behavior with docked/drawer layouts.
- [x] Register feature factories/host services in native profile and sidebar/settings slots; wire model dumbbell and update/banner surfaces.
- [x] Add GitHub Release checking with explicit download/load controls and current-platform capability checks.
- [x] Verify original policy/config migration does not overwrite user-owned values or create phantom sessions.

## Task 5: Validation and delivery — root with independent reviewers

- [x] Run complete unit/native tests once integration is stable; fix real regressions and add only necessary tests.
- [x] Run browser UI scenarios, screenshots light/dark/compact, real controls and no-op/empty states.
- [ ] Build and verify desktop stage/helper assets; create updated installation artifact only after required checks pass.
- [x] Review diffs and credential/path exposure; document capability and validation limits.
- [ ] Publish authorized code to GitHub and report exact verified result; preserve private data and original checkout changes.
