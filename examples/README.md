# Decision Studio

This example is an ordinary native DSH Host + Client dynamic package. Its React
layout and SVG radar are arbitrary JavaScript, not a ColdX form schema. Three
sliders update the diagram, and **确认这组偏好** returns the selected values to
the task through DSH's package-private `host.call` bridge.

1. Obtain the current session's real id from DSH (`execution.agent.id`).
2. Run `node examples/decision-studio.mjs <session-id>` in the ColdX project.
3. Pass that JSON to native `cordis_define`, then call `cordis_run` with the
   returned `pluginId`, `packageId`, and `mode: "run"`.
4. Allow the package in DSH's native Plugins panel. The studio appears above
   the owning session's composer. Other sessions do not render it.
5. Call the unique `coldx_decision_<digest>` tool named in the package's purpose.
   It waits without polling. Confirming priorities resolves that tool with
   `{status: "selected", speed, quality, budget}` so the original task continues.
6. Use the native Stop control or `cordis_stop` to remove the package. Cancelling
   a waiting tool yields `cancelled`; unloading the package yields `closed`.

In code, `createDecisionStudio(sessionId)` also returns `toolName`. Omit that
helper-only field when passing the object to `cordis_define`.

The shipped DSH runtime keeps dynamic definitions in process memory. Browser
reload preserves the native session, but the dynamic client must be run again
from its native panel. Restarting the host requires defining it again. Save
useful generated packages as files like this example before a restart.

The host validates numeric ranges and binds the result tool to the session id.
The UI carries no provider key. Stopping a plugin removes registrations and
settles its waiters; it does not reverse unrelated filesystem or network effects.

Verification: `node --test test/decision-studio.test.mjs test/decision-native.test.mjs`.
