# ColdX Web on DSH

Date: 2026-09-04
Status: implementation authorized by the current migration request and the referenced conversation's explicit approval to implement directly.

## Product

ColdX is a local AI workspace whose interface and capabilities grow with the task. A user can ask for work in natural language; the agent can reuse a tool, discover a plugin, write a plugin, generate an arbitrary interactive surface, or organize a continuing loop. Interface interactions must return real data to the running task.

The latest request replaces the old independent Cordis runtime and TUI with DeepSeek Harness and its own Web client. DSH already uses Cordis internally. Its agent loop, tools, model adapters, session journal, client models, connection, and plugin lifetimes are authoritative. No second agent loop, SDK-to-TUI wrapper, duplicate session database, or custom generic RPC server is required.

## Composition

- An exact pinned DSH dependency launches a private, project-owned web profile.
- ColdX contributes its operating policy and product UI through native DSH extension points.
- DSH dynamic Cordis tools supply inspect, definition/update, lifecycle, and client contributions where supported by the pinned runtime.
- Generated interactions allow arbitrary HTML/CSS/JS or native client plugins, not only predetermined form templates. Stable navigation, stop, settings, and task history remain accessible.
- Per-task loop behavior uses DSH goals, jobs, workflows, and lifecycle hooks. A running root loop is not replaced mid-request.
- Local execution follows the user's existing native-machine choice. Browser code uses the runtime's explicit host bridge; API keys remain on the host.
- DSH owns model/provider configuration. ColdX onboarding opens those controls rather than storing another copy of credentials.

## Success criteria

1. A single local command opens the actual DSH Web client with ColdX policy enabled.
2. The active agent can inspect and create a dynamic tool/plugin, call it, update it, and stop it.
3. A generated custom interface becomes visible without restarting the backend, accepts input, and returns that input to its session.
4. Continuing work has explicit status and cancellation and does not depend on keeping a browser tab alive.
5. Browser reload restores the current DSH session; provider-reported metrics are displayed honestly, unknown values remain unknown.
6. Startup, configuration generation, and at least one complete browser interaction receive executable verification. Live-model verification is separate from deterministic protocol checks.

## Scope discipline

Prefer native DSH capabilities over duplicating the old capability broker or process supervisor. Pin and inspect actual installed APIs. Do not claim cross-platform verification based on Windows alone. Do not claim that prompt instructions guarantee a model's creative behavior or that arbitrary plugin side effects roll back with plugin disposal.

## Sources

- Earlier product requirements established native DSH integration and free-form generated interfaces. The private task link is omitted from the published source.
- https://deepseek-harness.github.io/deepseek-harness/en/reference/
- https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/web-client
- https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/slots
