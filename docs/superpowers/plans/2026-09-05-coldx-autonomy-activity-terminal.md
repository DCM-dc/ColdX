# ColdX autonomy, activity sidebar, and terminal plan

**Goal:** Make ColdX act with stronger practical autonomy, expose verifiable agent activity in a dedicated side panel, and optionally show real terminal commands and captured output without inventing execution state.

**Architecture:** DeepSeek Harness remains the only agent loop, session/event store, tool runtime, goal/plan owner, job system, and subagent registry. ColdX shortens its stable system prefix to an outcome-driven policy and keeps exact protocols in tool descriptions. The Client derives every activity row from typed DSH snapshots and projections. A browser-local Settings preference controls only terminal presentation; command truth always comes from native `TerminalCallView` and `TerminalResultView` records.

## Product contract

- ColdX works in a short evidence loop: inspect, choose, execute, inspect the result, repair, verify, and report.
- It resolves normal implementation choices itself and asks only for information, authority, or preference that the user alone can provide.
- It creates task-specific interfaces when interaction materially improves the task, infers audience/domain/density/primary action/visual thesis, and implements real states and one verified interaction. Simple answers remain direct.
- It delegates only independent or parallel work with a clear deliverable and integrates the result in the root task. Sequential and tightly coupled work stays in the root task.
- Stable system content stays before dynamic conversation content, tool names/schema/order remain stable, and repeated large outputs are summarized or referenced once.
- A compact Activity button in the session header opens a modeless right-side Frost panel. It shows current observable action, generated outputs, subagents, jobs, typed web sources, and durable recalled sessions. It never exposes hidden reasoning.
- Subagent rows use the native catalog, preserve `running`, `inactive`, and diagnostic states exactly, and open through the public `openSubagent` action.
- Source rows are accepted only from typed `WebResultView` results or versioned `session-reference` recall records. No Markdown or tool-name guessing is allowed.
- Settings includes a default-off Terminal switch. When enabled, a terminal panel appears at the bottom-left of the conversation area.
- The terminal shows the real running command/title immediately when DSH exposes a terminal call view, then appends the captured output, exit code, or signal from the settled terminal result. Python and C program output is included only when it is present in that terminal result.
- DSH rc.2 does not expose generic stdout chunks to the browser before settlement. The UI therefore says that output is captured, and never claims byte-stream live output.
- Terminal text is rendered as text, scoped to the current session, bounded for performance, and reset when the session changes. Presentation controls never alter durable history.
- Motion uses the existing Frost system: expressive interruptible entrance, transform/opacity animation, clear focus, and reduced-motion/transparency/contrast fallbacks.

## Implementation tasks

1. Add deterministic prompt-policy tests for autonomy, UI judgment, delegation, verification, truthfulness, stable-prefix hygiene, and a strict size budget.
2. Refactor `plugin/policy.mjs` into a compact stable core while preserving Goal/Plan ownership, ColdX completion state, native approvals, page continuation, and generated-plugin safety.
3. Remove the absolute runnable-example path from `plugin/host.mjs`; keep exact interaction/page/Cordis protocols in their tool descriptions and existing project examples.
4. Add prompt evaluation fixtures and a scoring rubric covering direct answers, autonomous UI, blockers, sourced research, useful delegation, and sequential work. Keep provider runs explicit rather than asserting unmeasured quality.
5. Add pure activity selectors for conversation tool nodes, nested calls, pages, subagents, jobs, sources, recall records, and terminal records. Every derived row retains its typed truth source.
6. Add the right-side Activity panel and header trigger through `conversation.session.header.utilities`; keep composer, native trajectory, Settings, stop, and approvals accessible.
7. Add a Settings row through `settings.general.item` and a small subscribed presentation preference for the Terminal switch.
8. Render the session-scoped bottom-left terminal from terminal-shaped call/result views, including running/settled/error states and visible truncation.
9. Wire the factory and CSS into the generated Client build and regenerate `plugin/client/client.js` only through `plugin/client/build.mjs`.

## Verification

- Pure selector tests prove activity priority, nested traversal, source deduplication with query strings preserved, strict recall narrowing, subagent state fidelity, session isolation, terminal-call/result pairing, and output truncation.
- Client tests prove exact slot registration/disposal, header toggle behavior, public subagent navigation, Settings persistence, default-off terminal behavior, and no private DOM/Remote dependency.
- CSS tests prove side-panel geometry, bottom-left terminal placement, narrow-screen behavior, keyboard focus, coarse-pointer targets, and reduced preferences.
- Prompt tests prove stable-prefix size, no dynamic path/model/cwd/session data, exact Goal/Plan semantics, autonomy loop, UI decision rule, delegation rule, and honest verification.
- Run focused tests, the complete suite, generated-source parity, `git diff --check`, a fresh Host process, headless browser interaction, and final Computer Use acceptance.

