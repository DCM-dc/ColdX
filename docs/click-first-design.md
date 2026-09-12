# ColdX: direct interaction and fluid motion

Approved direction: expose complex capabilities through clicks and light input. Generate the interface for the task, keep attention on the effect, and let DSH own execution. The user explicitly requested implementation and substantial visual/motion refinement on 2026-09-04.

## Interaction contract

The runtime distinguishes working, waiting for input and completed. Add native `coldx_interact` for a decision, and `coldx_finish` for an explicit completion boundary. The interaction tool awaits native userQuestions and returns the selected IDs, labels and optional custom input to the same tool call. The UI never gains arbitrary Host tool execution. Local previews, ranges, selection and editing stay local until the user submits a meaningful decision.

`coldx_interact` accepts title, question, options (id, label, optional short description and optional sandbox preview source), multiSelect, allowCustom and submitLabel. Its durable native calls/results project into `coldx.flow`. Raw generated layouts continue to use `coldx_present_page`; this quick decision path is a reliable floor, not a constraint on generated applications.

Ordinary native questions are also presented as clickable ColdX interactions, preserving question IDs, labels, multiSelect, optional answers and receipt semantics. Native approvals and plan-review keep their native renderer. Wrong-session, duplicate, cancelled and stale submissions cannot execute a decision again.

A scoped native turn-stopping guard requests an explicit next-state declaration once when a root agent ends without a valid completion boundary. This is based on native records, not promises or question-mark matching. A successful finish is invalidated by subsequent business tools. Cancellation and unloaded scopes do not restart. Failed declarations remain visible; the guard does not create an unbounded retry loop.

## Visual behavior

Show the object/effect first. Choices are compact visual controls, details expand on demand, and a single clear action commits the current decision. The shell retains the central ice ColdX wordmark and native settings, workspaces and stop controls. A task workbench gives the current effect the main surface while keeping its process accessible.

Motion responds on press, connects source and destination, preserves continuity on interruption, and marks actual accepted/completed states. Use restrained translucent local chrome, short blur-to-sharp transitions, a continuously moving selection plate and natural spring settling. Typography and controls stay legible. No perpetual ornamental movement and no artificial wait to finish animation.

Reuse --ds-ease-out (0.23,1,0.32,1), add --coldx-ease-morph (0.77,0,0.175,1), and --coldx-ease-sheet (0.32,0.72,0,1). Press 100–160ms, state changes 150–220ms, page transitions 240–300ms. Larger spring transitions may settle beyond that only while remaining fully interactive. Movement is 8–12px and scale about .985–1, with small local blur. Reduced motion removes displacement/scale/blur; reduced transparency uses solid materials; keyboard navigation is immediate.

User reading or editing takes ownership of the current view. New content is offered without replacing a chosen history page. Mounted generated pages preserve local drafts during page switches. Existing native reconnect and interruption boundaries remain truthful.

## Concrete proof

Ship an interaction lab inside the application. It uses clearly labelled artificial sample files under a dedicated local lab directory. The user clicks different organization effects, makes a small adjustment and applies a version. The Host writes a new organized version, scans it and verifies file content hashes. Repeated application produces a new version rather than overwriting an earlier result. The user's actual desktop is not involved.

The lab must reuse the production interaction/runtime path. Also run one ordinary model task without UI-specific wording, verifying a decision interface and the result of a meaningful click. Record model reliability separately from deterministic checks.

References: Apple Designing Fluid Interfaces (https://developer.apple.com/videos/play/wwdc2018/803/) and Motion animate (https://motion.dev/docs/animate). The visual interpretation follows the user's taste, without claiming an exact platform animation replica.
