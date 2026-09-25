# ColdX native workbench rebuild

User direction, corrected explicitly: a highly usable pixel-level reproduction of the actual Codex UI on DSH, not an independently simplified Codex-inspired design. This supersedes the pet/group-first interface and the first draft of this spec. Prior autonomous execution authorization remains applicable; no repetitive design approval questions. Scope is a working development build, not a new installer or a claim of complete Codex feature parity.

Reference: the user's current Windows Codex task screen observed through Computer Use on 2026-09-24. Private reference capture stays only under ignored `.runtime/codex-reference/`. Match the captured chrome, whitespace, row density, bottom composer, menus and output summary. Do not copy private conversations or account data into demo fixtures.

## Product contract

- A quiet three-region workspace: project/task sidebar, native conversation, contextual right-hand files/activity/browser pane. Native settings remain accessible at the bottom.
- Rebuild the client composition entry and visual foundation. Remove the decorative pet/group interfaces. The user's subsequent clarification expands this baseline to functional navigation, search, pinned tasks, native schedules, PR listing, full-page marketplace and usage, compact model control and settings. Preserve existing Superpowers and DeepSeek research services behind those surfaces.
- Keep a ColdX identity with a simple monochrome mark, rather than claiming to be the official Codex application.
- Native DSH remains authoritative for sessions, drafts, model selection, stream/cancel, permission prompts, tools, jobs, and child agents. No second message loop or custom session protocol.
- Reuse the tested attachment/file/PDF/terminal bridges and inline generated-tool carriers. Preserve authenticated file access and pending approvals.
- Blank-task view is a modest heading and native composer. Existing tasks keep readable transcripts with tool history collapsed. One compact header, one contextual inspector, no duplicate dashboard cards.
- Match reference geometry at the same viewport and scale: neutral gray sidebar, white rounded main canvas, compact title row, centered 740px transcript/composer, floating summary on the right and contextual side preview. Read actual screenshot pixels before claiming visual equivalence. Dark/light follow native theme. Native input/mirror/backdrop metrics stay identical; focus and keyboard submission must work. Narrow windows use existing native responsive geometry.
- Simple opacity/press feedback, a continuously tracking compact model slider, and a short particle response at the highest supported effort. Match the inspected reference; no permanent glow or decorative startup motion. Respect reduced motion.

## Functional boundaries

Account, login, billing subscriptions, OpenAI cloud hosting and product switching are excluded. Display actual local/DSH/provider capabilities, never fake unavailable cloud or Git features. PR reading uses the user's existing GitHub CLI installation and reports connection failures. Scheduling uses DSH's durable session event log and native tool policy, and explicitly requires the application and owning session runtime to remain active. The archived-task restore API is absent in pinned DSH; do not imply that archive/recovery parity is implemented without adding and verifying that native capability.

## Preservation and validation

Current dirty source is retained in `.runtime/rebuild-baseline-20260924`; old client source remains readable. Work continues on `feat/codex-workbench-rebuild-20260924` in the existing isolated checkout. No user configuration, credentials or conversations are replaced. Preview uses a separate home and local deterministic provider.

Acceptance: actual native page opens, workspace/task navigation, editing and sending, streamed reply, file preview, inspector close, native settings/theme/model menu, narrow layout. Verify behavior by browser interaction in addition to automated tests. Local fixture verifies application flow, not paid model output quality.
