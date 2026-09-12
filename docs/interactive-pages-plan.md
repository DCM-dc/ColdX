# ColdX Generative Pages Implementation Plan

**Goal:** Give ColdX an ice wordmark, fluid task pages and native automatic interaction feedback.
**Architecture:** Native DSH profile plus ColdX brand/theme, a client page stage and a native presentation tool/projection. DSH owns execution and session persistence.
**Spec:** interactive-pages-design.md

- [x] Inspect the pinned native slots, theme, tool and event contracts; select input.dock without replacing ConversationRoot.
- [x] Create self-contained SVG/React brand components in plugin/client/brand-source.mjs.
- [x] Add native page tool/projection and actions in dedicated Host modules. Test pending results, ownership, cancellation and replay against the installed runtime.
- [x] Create page-document.mjs and exercise its iframe bridge behavior, including source/channel validation and failed submissions.
- [x] Add stage-source.mjs with page history, follow-latest behavior and interruptible transitions; use the native coldx.pages projection.
- [x] Restyle the native shell and hero with scoped CSS and theme overrides; integrate the new modules through the existing client factory build.
- [x] Update the agent policy so useful UI appears proactively after the initial task; teach ColdX.submit and the display-only path.
- [x] Test native behavior and browser rendering, fix actionable review findings and leave the current app running with updated documentation.

No code is written into the installed DSH packages. No provider credentials are exposed in the client, examples or verification artifacts. Existing user configuration is preserved. Git commits are optional here because this machine has no configured author identity; do not invent one.
