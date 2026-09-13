"""Native ColdX adapter for the pinned Pier runner, with prebuilt read-only mounts.

This adapter never scores a task. Pier's unchanged verifier owns that decision.
Linux container execution is mandatory; host-side contract tests are not a trial.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
import tempfile
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit
from uuid import uuid4

from pier.agents.base import BaseAgent
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.network import NetworkAllowlist


class ColdXMountedAgent(BaseAgent):
    SUPPORTS_ATIF = False  # Native DSH JSONL is retained; no fabricated ATIF conversion.
    SUPPORTS_WINDOWS = False

    def __init__(self, *args, source="/opt/coldx-app", harness="/opt/coldx-eval",
                 node="/opt/coldx-node/bin/node", workspace="/app", max_steps=500,
                 max_requests=500, timeout_ms=10_800_000, request_timeout_ms=10_800_000,
                 browsers_path="/opt/coldx-browsers", undici_module=None, extra_env=None, version=None, **kwargs):
        super().__init__(*args, **kwargs)
        if self.model_name not in {"deepseek-flash", "deepseek/deepseek-flash"}:
            raise ValueError("This protocol adapter requires the explicit model deepseek-flash")
        self.source, self.harness, self.node, self.workspace = map(str, (source, harness, node, workspace))
        self.browsers_path = str(browsers_path)
        self.undici_module = str(undici_module or (self.source + "/node_modules/.pnpm/undici@7.29.1/node_modules/undici/index.js"))
        for value in (self.source, self.harness, self.node, self.workspace, self.browsers_path, self.undici_module):
            if not PurePosixPath(value).is_absolute() or "\x00" in value:
                raise ValueError("Container paths must be absolute POSIX paths")
        self.max_steps, self.max_requests = int(max_steps), int(max_requests)
        self.timeout_ms, self.request_timeout_ms = int(timeout_ms), int(request_timeout_ms)
        if min(self.max_steps, self.max_requests, self.timeout_ms, self.request_timeout_ms) < 1:
            raise ValueError("Limits must be positive integers")
        self.extra_env = dict(extra_env or {})
        self._version = version
        self.run_dir = "/logs/agent/coldx-run"
        self.pid_file = f"/tmp/coldx-owned-process-{uuid4()}.pid"

    @staticmethod
    def name() -> str:
        return "coldx-native"

    def version(self) -> str | None:
        return self._version

    def _env(self, name):
        return self.extra_env.get(name) or os.environ.get(name)

    def _upstream(self):
        value = self._env("COLDX_EVAL_UPSTREAM_BASE_URL")
        parsed = urlsplit(value or "")
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("Set an explicit credential-free COLDX_EVAL_UPSTREAM_BASE_URL")
        return value, parsed.hostname

    def network_allowlist(self) -> NetworkAllowlist:
        _, hostname = self._upstream()
        return NetworkAllowlist(domains=[hostname])

    async def setup(self, environment: BaseEnvironment) -> None:
        # No downloads or installs inside a task. Linux dependencies must already
        # have been built with the frozen lockfile and mounted read-only.
        command = " && ".join([
            f"test -x {shlex.quote(self.node)}",
            f"test -f {shlex.quote(self.source + '/package.json')}",
            f"test -f {shlex.quote(self.harness + '/run-session.mjs')}",
            f"test -f {shlex.quote(self.harness + '/stop-owned-process.mjs')}",
            f"test -f {shlex.quote(self.harness + '/linux-process-group.mjs')}",
            f"test -f {shlex.quote(self.harness + '/execution-environment.mjs')}",
            f"test -f {shlex.quote(self.harness + '/evaluation-dispatcher.mjs')}",
            f"test -f {shlex.quote(self.undici_module)}",
            f"test -d {shlex.quote(self.browsers_path)}",
            "command -v setsid >/dev/null",
            f"test -d {shlex.quote(self.workspace)}",
            f"{shlex.quote(self.node)} --use-env-proxy --version",
            "mkdir -p /logs/agent",
        ])
        result = await environment.exec(command=command, timeout_sec=30)
        if result.return_code != 0:
            raise RuntimeError("ColdX Linux mounts/runtime preflight failed; no task was run")

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        upstream, _ = self._upstream()
        key = self._env("COLDX_EVAL_UPSTREAM_API_KEY")
        if not key:
            raise ValueError("Set COLDX_EVAL_UPSTREAM_API_KEY explicitly; private app config is never read")
        task_file = f"/tmp/coldx-instruction-{uuid4()}.txt"
        # Task text is uploaded as bytes, never interpolated into a shell command.
        with tempfile.TemporaryDirectory(prefix="coldx-pier-instruction-") as directory:
            local = Path(directory) / "instruction.txt"
            local.write_text(instruction, encoding="utf-8")
            await environment.upload_file(local, task_file)
        args = [self.node, "--use-env-proxy", self.harness + "/run-session.mjs",
                "--source", self.source, "--workspace", self.workspace, "--output", self.run_dir,
                "--task-file", task_file, "--max-steps", str(self.max_steps),
                "--max-requests", str(self.max_requests), "--timeout-ms", str(self.timeout_ms),
                "--request-timeout-ms", str(self.request_timeout_ms),
                "--undici-module", self.undici_module,
                "--playwright-browsers-path", self.browsers_path]
        # A unique process group makes external deadline cancellation explicit;
        # cancelling only the host's docker-exec client is insufficient.
        command = ("setsid " + shlex.join(args) + " > /logs/agent/coldx-launcher.log 2>&1 & "
                   + "coldx_pid=$!; printf '%s\\n' \"$coldx_pid\" > " + shlex.quote(self.pid_file)
                   + "; wait \"$coldx_pid\"")
        # The upstream key stays in the proxy parent. The native child gets only
        # a random local token. This is not a security boundary against /proc.
        process_env = environment.agent_process_env({
            "COLDX_EVAL_UPSTREAM_BASE_URL": upstream,
            "COLDX_EVAL_UPSTREAM_API_KEY": key,
            "COLDX_EVAL_UPSTREAM_CREDENTIAL_KIND": self._env("COLDX_EVAL_UPSTREAM_CREDENTIAL_KIND") or "provider-key",
            "NODE_USE_ENV_PROXY": "1",
        })
        result = None
        execution_error = None
        try:
            result = await environment.exec(command=command, cwd=self.workspace, env=process_env,
                                            timeout_sec=(self.timeout_ms + 999) // 1000 + 60)
        except (Exception, asyncio.CancelledError) as error:
            execution_error = error
        finally:
            # Normal completion also needs a stopped process group: a tool can
            # leave a background shell after the native agent process exits.
            cleanup = shlex.join([self.node, self.harness + "/stop-owned-process.mjs", self.pid_file,
                                  self.harness + "/run-session.mjs"])
            stopped = await environment.exec(command=cleanup, timeout_sec=20)
            if stopped.return_code != 0:
                raise RuntimeError("Cannot confirm ColdX stopped; refusing to verify a changing workspace") from execution_error
            # Even after a timeout, retain whatever real state the runner wrote.
            self.logs_dir.mkdir(parents=True, exist_ok=True)
            for name in ("session-report.json", "native/report.json"):
                target = self.logs_dir / ("coldx-" + name.replace("/", "-"))
                try:
                    await environment.download_file(self.run_dir + "/" + name, target)
                except Exception:
                    pass  # Missing report stays missing; it never becomes success.
            self._populate_context(context)
        if execution_error is not None:
            if isinstance(execution_error, RuntimeError) and re.fullmatch(r"Command timed out after \d+ seconds", str(execution_error)):
                # The pinned Docker environment wraps its exact timeout as a
                # RuntimeError. Pier converts TimeoutError to AgentTimeoutError
                # and still runs collection + verifier after confirmed cleanup.
                raise asyncio.TimeoutError("ColdX container command reached its deadline") from execution_error
            raise execution_error
        status = (context.metadata or {}).get("coldx", {}).get("status")
        if status not in {"completed", "step-limit", "timeout", "request-budget-exhausted"}:
            raise RuntimeError(f"ColdX evaluation failed before scoring (status={status or 'missing-report'})")
        if status == "completed" and result.return_code != 0:
            raise RuntimeError("ColdX process failed after its completion report")
        # Step/time limits are normal agent exhaustion. Pier must still collect
        # the patch and run its verifier; only that verifier can award 0 or 1.

    def _populate_context(self, context: AgentContext) -> None:
        def load(name):
            try:
                return json.loads((self.logs_dir / name).read_text(encoding="utf-8"))
            except (OSError, ValueError):
                return None
        session = load("coldx-session-report.json")
        native = load("coldx-native-report.json")
        metered = session.get("tokenAccounting") if session else None
        metered_complete = bool(metered and metered.get("complete"))
        context.metadata = {**(context.metadata or {}), "coldx": {
            "status": session.get("status") if session else "missing-report",
            "session_report": session,
            "native_identity": native.get("identity") if native else None,
            "usage_coverage": "All forwarded calls report input/output usage; cache and cost may remain unknown" if metered_complete else "Partial native task-agent usage; consult transport accounting for missing or incomplete responses",
        }}
        if native:
            usage = native.get("usage", {})
            context.n_input_tokens = usage.get("inputTokens")
            context.n_output_tokens = usage.get("outputTokens")
            context.n_agent_steps = native.get("steps", {}).get("actual")
        if metered_complete:
            totals = metered.get("totals", {})
            context.n_input_tokens = totals.get("promptTokens")
            context.n_output_tokens = totals.get("completionTokens")
        # cost/cache counts deliberately stay unknown rather than zero.
