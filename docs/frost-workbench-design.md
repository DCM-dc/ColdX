# ColdX Frost Workbench Design

**Status:** Approved for implementation on 2026-09-05  
**Product:** ColdX on native DeepSeek Harness Web  
**Positioning:** A local generative workbench for real work, with software development as its first high-trust workflow.

## Product outcome

ColdX should reduce the time and number of user actions between an intent and a verifiable result. A task may begin as natural language, but it should not remain a transcript when a purpose-built editor, comparison surface, approval panel, progress view, or artifact viewer would let the user work faster.

The product contract is:

1. DSH remains the only execution kernel. It owns models, providers, the agent loop, tools, approvals, goals, plans, sessions, projections, cancellation, plugins, and transport.
2. ColdX compiles task state into an interface. Generated controls return typed values to the exact owning DSH operation and the same agent continues.
3. UI state follows durable execution state. A control may acknowledge touch immediately, but it may only claim acceptance or completion after the Host receipt.
4. Every important result remains inspectable through its source task, tool calls, files, diffs, tests, screenshots, or citations.

## Competitive baseline

ColdX treats the current public capabilities of three products as a baseline:

- Tencent WorkBuddy describes a desktop office agent with autonomous task planning, local file access, Experts, Skills, Connectors, Automations, deep research, document/design/development workflows, and an open Buddy App ecosystem. Sources: [WorkBuddy](https://cloud.tencent.com/product/workbuddy), [WorkBuddy Open Platform](https://open.workbuddy.cn/en), and [Buddy App](https://open.workbuddy.cn/en/docs/buddy-app).
- Doubao's current task mode can operate an embedded or remote browser, show the visited pages and actions, support user takeover for login, and stop a running task. Its product listing also describes Office skills, document and presentation output, and scheduled tasks. Sources: [Doubao privacy disclosure](https://www.doubao.com/legal/privacy) and [Doubao App Store listing](https://apps.apple.com/cn/app/id6459478672).
- Codex currently provides projects and chats, parallel and long-running work, browser and computer use, files, plugins and skills, scheduled tasks, worktrees, code review, integrated terminals, and remote continuation. Sources: [Codex app](https://learn.chatgpt.com/docs/app), [long-running work](https://learn.chatgpt.com/docs/long-running-work), and [code review](https://learn.chatgpt.com/docs/code-review).

ColdX differentiates through four connected capabilities:

1. **Task interface compiler:** choose a stable component schema by default and a sandboxed page only when the task needs a free-form surface.
2. **Typed continuation:** every meaningful interaction becomes a validated, idempotent event that resumes the same task.
3. **Branch laboratory:** parallel agents produce real alternatives that can be compared, tuned, combined, and traced to evidence.
4. **Workflow crystallization:** a successful one-off task can become a versioned reusable mini-application, complete with its UI, tools, rules, and checks.

## Stable kernel and generative surface

The default rendering path is a declarative Frost schema. The model supplies component types, semantic content, bindings, actions, and motion recipes. The renderer owns DOM structure, CSS, accessibility, responsive behavior, state reconciliation, and degradation.

Free-form HTML, CSS, canvas, SVG, and JavaScript remain available through the existing `coldx_present_page` sandbox. It continues to use `sandbox="allow-scripts"`, an authenticated per-frame channel, a strict CSP, source validation, JSON-only values, size limits, and the owner-bound native question carrier.

The two paths share the same state rules:

```text
Agent UI plan
  -> validate version and capabilities
  -> Frost schema renderer OR sandbox document
  -> local interaction feedback
  -> typed Host submission with clientEventId
  -> native receipt
  -> durable state patch
  -> same agent continues
```

## Frost component system

Frost is implemented as internal source modules first. The build can later expose versioned packages without forcing the current DSH lazy module loader to bundle a second React instance.

### Token layers

- `--cx-ref-*`: raw palette and numeric values; generated schemas cannot reference these.
- `--cx-sys-*`: semantic surface, text, accent, separator, focus, status, and material values; schemas may reference these.
- `--cx-comp-*`: component implementation values; renderer-only.
- `--cx-motion-*`: durations, curves, and spring approximations.
- Context values such as theme, density, motion preference, transparency preference, contrast, locale, and run status are injected by the Host.

Base scales:

- spacing: `4, 8, 12, 16, 24, 32, 48px`
- radius: `10, 14, 20, 28px`, plus pill
- material: `solid`, `thin`, `regular`, `thick`
- blur: `16, 24, 36px`, with no nested glass
- elevation: `rest`, `float`, `modal`

### Core components

The first renderer API includes `Surface`, `Action`, `Status`, `Field`, `Meter`, and `Disclosure`. The schema vocabulary grows toward `Canvas`, `Flow`, `Text`, `ChoiceGroup`, `Segmented`, `Metric`, `DataView`, `Progress`, `Callout`, `Artifact`, and `Overlay`.

Host-only components such as `AppShell`, `Composer`, `RunTimeline`, `ArtifactDock`, `Inspector`, and `CommandPalette` are never emitted by generated schemas.

### Motion recipes

- `press`: 120-140 ms, scale to 0.96, immediate input delivery.
- `materialize`: 520 ms, opacity, 12 px lift, and restrained blur removal.
- `optionSwap`: 480 ms, directional travel with 4-6 degree rotation.
- `confirmBloom`: 420 ms, 0.96 -> 1.025 -> 1 with one ice-blue highlight.
- `shapeMorph`: 360-600 ms between working, waiting, confirmation, and result forms.
- `generateReveal`: 600-760 ms with bounded overshoot for a new generated work surface.
- `streamInsert`: 160-220 ms for newly appended information; history never replays entrance motion.

Motion must be interruptible and preserve the visible pose when redirected. Reduced Motion removes translation, rotation, bounce, particles, and animated blur and keeps only a 120-180 ms semantic fade. Reduced Transparency and increased contrast replace translucent material with a solid surface.

## Coding mode control

Goal and Plan remain independent native DSH concepts. The composer-left Frost control has one visible `Coding mode` trigger and exactly two checkable rows, `Goal` and `Plan`. It contains no objective field, native-goal editor, cache section, context meter, or compaction action.

### Goal selection

ColdX owns one durable, event-sourced preference at `coldx.codingMode`; it does not copy the native goal lifecycle. `/coldx-goal on` appends the preference only. It never sends a message, opens a model turn, invents a placeholder objective, or resumes prior work. On the next direct human request, selected Goal context tells the model to call native `get_goal`, infer a concise objective grounded in that request, and call native `create_goal` only when no unfinished goal exists. Generated plugin notices and automatic goal rounds cannot authorize another inferred goal.

`/coldx-goal off` pauses an active native goal through its current `{ id, revision }` before recording the off preference, and never clears the objective. If pause, cancellation, or preference persistence fails, the UI reconciles from the durable projections and cannot claim a successful transition.

An accepted `coldx.codingMode` projection is the sole source for the small Goal tag. An undefined projection during hydration means default-unselected and remains clickable; a click or successful command promise cannot create the tag.

### Native Plan ownership

Plan continues to use `/plan`, `/plan off`, the native `plan` projection, `exit_plan_mode`, and the `plan-review` question. The menu derives effective selection as `pending ? !active : active` and prevents another Plan toggle during a pending native transition. DSH already renders its own Plan chip beside the composer, so ColdX never adds a duplicate Plan tag.

Goal and Plan may both be selected. Before Plan approval, native Goal bookkeeping is the sole narrow exception to the Plan policy's general mutation rule and its precedence clause; filesystem, code, configuration, business, and every other mutation remain prohibited. Native review still decides when implementation may begin.

### Interaction and material

The popup is one compact Frost surface with two action rows. It focuses a row on open, supports Arrow Up/Down, Home/End, native Enter/Space activation, Tab exit, Escape with focus return, and outside pointer close without stealing focus. One command may be in flight per rendered session. Session changes invalidate the old request ticket, so a late result from Session A cannot clear Session B's pending state or show an error there.

Pointer opening uses a brief trigger-origin transform and opacity pop; keyboard opening and repeated accessibility use a short fade. Hover movement is limited to fine pointers. Reduced Motion removes spatial movement, while Reduced Transparency, increased contrast, and forced colors replace translucent material with solid semantic surfaces.

## Task contract and evidence roadmap

ColdX should present four friendly presets without flattening native state into a single mode flag:

```text
Agent = execute collaboration + one turn
Plan  = plan collaboration + one turn
Goal  = execute collaboration + durable continuation
Ask   = advisory collaboration + one turn
```

Plan and Goal can compose. A reviewed plan may execute once or become the plan for a continuing goal. Activity such as queued, running, waiting for input, waiting for approval, verifying, and stopping is derived from DSH turn, tool, job, workflow, and carrier events rather than stored as another lifecycle.

The next product protocol is a versioned `ColdXTaskSpec` that references native entities instead of copying them. It records the objective, constraints, deliverables, acceptance criteria, plan revision, resource policy, and links to the current native goal, jobs, workflows, and evidence. Plan approval names an exact revision; user steering advances the task revision; evidence from an older revision cannot satisfy new criteria.

That protocol enables the product surfaces that form ColdX's long-term advantage:

1. **Generated Plan Card:** task-specific editable steps, constraints, assumptions, risks, dependencies, and acceptance criteria rather than a static markdown sidebar.
2. **Mission Control:** one truthful timeline for the active plan nodes, tool calls, jobs, workflows, delegated agents, artifacts, blockers, screenshots, and logs.
3. **Verification Ledger:** every completion criterion links to fresh command output, file hashes, artifacts, browser observations, workflow outcomes, or an explicit human check. The system does not treat model prose as proof.
4. **Blocker Card:** a generated, typed repair surface for missing input, changed constraints, retry, or skip that resumes the same task.
5. **Action Receipt:** each external side effect records the connector, resource, operation, approval, result, and undo capability where one exists.
6. **Task recipes:** a successful task can be saved as a versioned reusable workflow with the same permissions, criteria, generated UI, and notification policy.
7. **Parallel option lab:** multiple agents can produce alternatives with explicit cost ceilings, evidence, diffs, and a generated comparison surface before the user promotes one.

Connectors with typed schemas, permission checks, durable receipts, and undo should be the primary cross-application path. GUI automation is a controlled fallback for applications without a reliable API, and its screenshots and actions become evidence in the same ledger.

## Token efficiency and cache design

Provider KV prefix caching and ColdX content caching solve different problems. Prefix caching lowers repeated prefill latency and cost but still generates a fresh answer. Content caching avoids repeating file parsing, chunking, embedding, and retrieval work.

Primary technical sources:

- [DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache/)
- [OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Anthropic Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [vLLM Automatic Prefix Caching](https://docs.vllm.ai/en/latest/features/automatic_prefix_caching/)

All four systems reward an identical prefix. ColdX therefore uses a deterministic conceptual request layout:

```text
P0 provider and model invariants
P1 canonical ToolManifest
P2 ColdX core policy and Frost contract
P3 stable workspace rules and pinned ReferencePacks
-- stable cache boundary --
P4 immutable SummaryCheckpoint, when present
P5 append-only conversation history
-- rolling cache boundary --
P6 current time, permissions, git state, and temporary retrieval
P7 current user input
```

Rules:

- Never place timestamps, random IDs, volatile git state, temporary retrieval, or current permission state in the stable prefix.
- Keep tool names, descriptions, schemas, and order stable. Dynamic tools are discovered through a stable search capability; a real tool-set change creates a new tool epoch.
- Use canonical JSON and stable property ordering when ColdX authors a provider request or tool manifest.
- Keep conversation history append-only. Editing or retrying creates a branch instead of rewriting ancestors.
- Compact at a coarse threshold, initially 72 percent of the model window, into an immutable checkpoint with goal, constraints, decisions, side effects, pending work, artifact references, and evidence node IDs.
- Preserve the original event DAG for audit and summary regeneration.
- Treat provider caching as best effort. Correctness and recovery may never depend on a hit.

DeepSeek manages caching automatically and does not support `prompt_cache_key` in its Responses-compatible API. OpenAI routing keys and cache breakpoints and Anthropic cache controls are provider adapter features for a later adapter-capability phase. They must only be sent when the selected provider declares support.

### Phase-one observability

DSH already projects `tokenUsage` and `contextPressure`. ColdX presents:

- uncached input tokens
- cache read tokens
- cache write tokens
- output tokens
- cache token hit ratio: `cacheRead / (uncachedInput + cacheRead + cacheWrite)`
- projected context pressure and its percentage when the context window is reported

When a provider omits cache fields, the UI must say that cache reporting is unavailable rather than promise a zero hit. The initial UI can only make a definite claim when a reporting-aware projection is available; otherwise it labels totals as provider-reported DSH values.

### Content-addressed cache roadmap

The next storage phase uses:

- `FileCAS(sha256(bytes))`
- `ParseCache(contentHash, parserVersion)`
- `ChunkEmbeddingCache(chunkHash, chunkerVersion, embeddingModel)`
- `RetrievalCache(workspaceSnapshot, aclDigest, normalizedQuery, retrieverVersion, topK)`
- `ContextPackCache(sortedChunkHashes, rendererVersion, tokenBudget, locale)`

Permission and ACL digests are part of cache identity. Revocation invalidates retrieval and context packs immediately. File renames may reuse parsed content but must regenerate displayed paths.

## Reliability and validation

Required deterministic coverage:

- Frost semantics, keyboard behavior, focus, reduced motion, reduced transparency, and forced colors.
- Goal preference replay and first-human-turn inference, Plan state derivation, native command routing, pending transitions, stale requests, unmount, and command failures.
- Native plan review remains separate from ColdX interaction completion.
- Page and choice acceptance remain owner-bound, idempotent, reconnectable, and truthfully acknowledged.
- Cache ratio excludes output tokens; missing projections and zero denominators are explicit.
- Existing inline tool call identity, iframe identity, CSP, source/channel checks, composer ownership, and scroll behavior remain unchanged.

Browser acceptance covers a new session, Goal on/off with projection-owned tagging, native Plan on/off without a duplicate chip, both modes together, a generated interaction, a confirmed continuation, a provider-reported cache badge, narrow width, keyboard-only operation, and Reduced Motion.

## Delivery sequence

1. Add the Frost primitives, tokens, and Coding mode surface without changing DSH execution ownership.
2. Wire the durable Goal-selection preference, native Plan commands, and provider-reported token usage.
3. Fix plan-review/ColdX completion boundary conflicts and synchronize confirmed generated-page state.
4. Migrate existing interaction and page shells to Frost primitives while preserving call and iframe identity.
5. Add provider-aware prompt planning and content-addressed workspace caches behind measured capability flags.
