# ColdX / Generative pages

The user requests a fluid frontend inspired by Kimi's restrained visual language and Codex-like continuity. A large central ColdX wordmark uses an original ice cube in place of the o. After the user describes a task, the agent chooses and presents useful pages itself; it does not wait for a separate request to build a UI.

## Experience

Keep the native DSH shell, workspace/session navigation, input ownership, settings, stop control and history. Replace the small hero mark with the complete ColdX wordmark. Use warm white surfaces, restrained black typography, pale blue ice details, a quiet sidebar and a generous rounded composer.

A page stage mounts through `conversation.input.dock`. Once pages exist, the composer seat uses normal flow and the native transcript remains above it. New pages appear in order, with a compact page history and a return-to-latest control. Users can revisit pages without a later arrival taking them away from the page they chose. Rapid page changes cancel previous transitions; native typing and stop controls stay responsive.

Use transform and opacity for page transitions: 260ms entering, 140ms leaving, cubic-bezier(0.23,1,0.32,1). Small presses use 120ms. Honor reduced motion and fine-pointer hover gating. No idle decorative animation or fabricated work progress.

## Data and execution

`coldx_present_page` is a native DSH tool. It accepts a title, optional subtitle, arbitrary HTML, CSS and JavaScript, plus waitForInput. The native tool call ID is the page identity. A `coldx.pages` projection derives the page collection from native tool/call and tool/result events, preserving DSH persistence compatibility without a second session database.

The preferred compatibility path is script-only: a nonempty script receives an empty `#coldx-root` and builds arbitrary DOM with browser APIs. Explicit HTML and canonical UTF-8 Base64 HTML are also accepted, exclusively. Shared Host/projection input validation rejects corrupted JSON tag trees before publishing a waiting page. Native Code Mode dispatch events are projected with their real call and turn ownership.

The native question carrier handles session identity, acknowledgement, reconnect and cancellation. The composer chain elects ColdX only when every pending interaction is a ColdX page; ordinary approvals and questions retain their native renderer. A narrowly scoped rc.2 CSS rule keeps the native composer fallback mounted and visible during those page questions, preserving a single iframe instance.

For an interactive page, execute remains pending after publication. The built-in client renders markup inside a sandboxed iframe. Its only application bridge is ColdX.submit(value). The parent validates the source window and page channel and calls the native action bound to the current session. The Host validates the owner and pending page, settles the original tool result, and DSH continues its existing agent loop. Display-only result pages return immediately. Cancelled/interrupted pages remain reviewable with submission disabled.

When a normal completed turn has an accepted page selection but no later display page, derive its actual final assistant prose as a read-only result page. Projection state version 6 tracks that candidate within its native turn and excludes cancellation, pending choices and explicit text-only requests. The derived view adds no session event or model call. Its optional resultText is rendered by the native public MarkdownText component, which treats raw HTML as text. Ordinary generated pages retain the iframe path.

The iframe permits scripts but not same-origin access. It receives no provider configuration or Host credentials. Its CSP limits external resources and connections. Native Host plugins remain available through the existing Cordis tools and approvals; this page renderer provides presentation and structured replies, not arbitrary Host execution.

## Verification

Verify native projection/replay, tool waiting and continuation, session ownership, repeated/late submission and cancellation. Test the iframe message bridge with wrong sources/channels and failed requests. In the browser inspect the hero, page transitions, back/next navigation, successful confirmation, small-screen layout, reduced motion and history after reload. Keep deterministic UI checks separate from a live-model trial.

References consulted: https://www.kimi.ai/ and https://openai.com/index/introducing-the-codex-app/. Visual interpretation uses the user's direction; it does not claim exact copies of either product's animations.
