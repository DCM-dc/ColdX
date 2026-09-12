# ColdX Web Implementation Plan

> **For agentic workers:** Use subagent-driven-development to implement independent tasks with bounded review.

**Goal:** Deliver a runnable native DSH Web distribution that supports self-created capabilities, task-specific interfaces, and configurable loops.

**Architecture:** DSH web profile plus native ColdX extensions. DSH remains the only agent and session runtime. Keep generated content and persistent user configuration in a project-owned runtime home.

**Tech Stack:** Node 24, DSH 0.1.1-rc.2, DSH Cordis plugins and React Web client.

**Spec:** docs/design.md

## Global constraints

- Do not modify the previous ColdX repositories or their running tasks.
- Do not print, commit, or inject provider credentials into model or frontend content.
- Use exact installed DSH contracts; distinguish repository-head docs from the pinned package.
- Native execution on Windows, macOS, and Linux is the target; report platforms actually checked.
- Free-form generated interaction is required, and a chat-only result is insufficient.

## Task 1: Native web launcher

Files: bin/coldx-web.mjs, lib/profile.mjs, test/profile.test.mjs, test/launcher.test.mjs.

Produces a private DSH web profile, a stable startup command, isolated runtime storage, and configuration pointers. Test profile construction/idempotency, path handling with spaces, preservation of user settings, and loopback binding before implementing. Launch the native DSH CLI with an argument array and readiness output; no shell-built commands. Keep startup and shutdown owned by the native process lifecycle.

- [x] Inspect pinned profile and CLI contracts.
- [x] Write and run behavioral tests.
- [x] Implement launcher and verify config dump/startup.

## Task 2: Generative behavior and native plugin tools

Files: plugin/ policy and native integration files, test/policy.test.mjs.

Consumes the pinned DSH profile. Produces ColdX identity and actionable operating instructions for tool inspection/reuse, capability creation, free-form interface generation, result validation, and bounded continuing work. Enable the native dynamic tool preset and appropriate loop/job/workflow capabilities. Exercise a real dynamic plugin lifecycle against DSH; a source-text assertion alone is insufficient.

- [x] Verify supported dynamic package interfaces.
- [x] Implement policy/native integration without a second broker.
- [x] Verify create, invoke, update, and dispose behavior.

## Task 3: Native Web interaction and product presentation

Files: plugin/client.*, plugin/client metadata and examples/ as needed; behavioral interaction tests.

Consumes DSH slots and session models. Produces a ColdX branded workspace with working native settings, session input, generated surfaces, and feedback into the correct session. Reuse the upstream renderer and transport. Verify arbitrary layout and JS interaction, not only static cards. If upstream provides the complete mechanism, add a runnable example and verify it rather than duplicate it.

- [x] Inspect client module and slot contracts.
- [x] Integrate the product surface and generated interaction path.
- [x] Exercise browser feedback; verify native stop/disposal and document the dynamic Client reload limitation.

## Task 4: End-to-end verification and delivery

Files: README.md, verification notes, start scripts as needed.

- [x] Run the focused test suite and native startup.
- [x] Exercise a deterministic generated plugin and browser interaction.
- [x] Use an existing authorized provider only through host-side credential handling if available; report live-model evidence independently.
- [x] Review integration, fix actionable findings, and leave a runnable entry point.
