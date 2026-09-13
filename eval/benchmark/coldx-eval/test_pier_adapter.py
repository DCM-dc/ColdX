"""Host-side Pier contract tests. No containers or model calls are executed."""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from coldx_pier_agent import ColdXMountedAgent
from pier.models.agent.context import AgentContext


class RecordingEnvironment:
    def __init__(self, status="completed", exit_code=0):
        self.status = status
        self.exit_code = exit_code
        self.commands = []
        self.uploaded = []

    def agent_process_env(self, env):
        return {"HTTPS_PROXY": "http://SYNTHETIC_PIER_PROXY:8080", **env}

    async def upload_file(self, source, target):
        self.uploaded.append((Path(source).read_text(encoding="utf-8"), target))

    async def exec(self, **kwargs):
        self.commands.append(kwargs)
        code = 0 if "stop-owned-process.mjs" in kwargs["command"] else self.exit_code
        return SimpleNamespace(return_code=code, stdout="", stderr="")

    async def download_file(self, source, target):
        if source.endswith("session-report.json"):
            value = {"status": self.status, "transport": {"forwardedRequests": 3}, "SYNTHETIC_FIXTURE": True}
        else:
            value = {"identity": {"preset": "coldx"}, "usage": {"inputTokens": 10, "outputTokens": 2}, "steps": {"actual": 2}}
        Path(target).write_text(json.dumps(value), encoding="utf-8")


class TestColdXPierContract(unittest.IsolatedAsyncioTestCase):
    def make_agent(self, logs):
        return ColdXMountedAgent(logs_dir=logs, model_name="deepseek-flash", extra_env={
            "COLDX_EVAL_UPSTREAM_BASE_URL": "https://synthetic-model.invalid/v1",
            "COLDX_EVAL_UPSTREAM_API_KEY": "SYNTHETIC_KEY_NEVER_USED_ON_NETWORK",
        })

    async def test_native_command_uses_file_input_and_egress_env_without_scoring(self):
        with tempfile.TemporaryDirectory() as directory:
            logs = Path(directory)
            agent = self.make_agent(logs)
            env = RecordingEnvironment()
            context = AgentContext()
            instruction = "SYNTHETIC test: `echo no` $(echo no) ' \" \nDo not interpolate this."
            await agent.run(instruction, env, context)
            self.assertEqual(env.uploaded[0][0], instruction)
            command = env.commands[0]["command"]
            self.assertNotIn(instruction, command)
            self.assertNotIn("SYNTHETIC_KEY", command)
            self.assertIn("--use-env-proxy", command)
            self.assertIn("HTTPS_PROXY", env.commands[0]["env"])
            self.assertIn("--playwright-browsers-path /opt/coldx-browsers", command)
            self.assertIn("--undici-module /opt/coldx-app/node_modules/.pnpm/undici@7.29.1/node_modules/undici/index.js", command)
            self.assertIn("--request-timeout-ms 10800000", command)
            self.assertEqual(env.commands[0]["timeout_sec"], 10860)
            self.assertIn("stop-owned-process.mjs", env.commands[-1]["command"])
            self.assertEqual(agent.network_allowlist().domains, ["synthetic-model.invalid"])
            self.assertEqual(context.metadata["coldx"]["status"], "completed")
            self.assertEqual(context.n_agent_steps, 2)
            self.assertIsNone(context.cost_usd)
            self.assertNotIn("reward", context.metadata["coldx"])

    async def test_step_and_time_exhaustion_leave_verification_to_pier(self):
        for status in ("step-limit", "timeout"):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as directory:
                agent = self.make_agent(Path(directory))
                context = AgentContext()
                await agent.run("Synthetic", RecordingEnvironment(status, 2), context)
                self.assertEqual(context.metadata["coldx"]["status"], status)

    async def test_transport_error_is_not_task_failure_or_success(self):
        with tempfile.TemporaryDirectory() as directory:
            agent = self.make_agent(Path(directory))
            with self.assertRaisesRegex(RuntimeError, "transport-error"):
                await agent.run("Synthetic", RecordingEnvironment("transport-error", 1), AgentContext())

    async def test_nonzero_exit_cannot_be_hidden_by_completed_report(self):
        with tempfile.TemporaryDirectory() as directory:
            agent = self.make_agent(Path(directory))
            with self.assertRaisesRegex(RuntimeError, "failed after"):
                await agent.run("Synthetic", RecordingEnvironment("completed", 1), AgentContext())

    async def test_docker_timeout_stops_owned_process_before_pier_timeout_conversion(self):
        class TimeoutEnvironment(RecordingEnvironment):
            async def exec(self, **kwargs):
                self.commands.append(kwargs)
                if len(self.commands) == 1:
                    raise RuntimeError("Command timed out after 10860 seconds")
                return SimpleNamespace(return_code=0)
            async def download_file(self, source, target):
                assert "stop-owned-process.mjs" in self.commands[-1]["command"]
                return await super().download_file(source, target)
        with tempfile.TemporaryDirectory() as directory:
            agent = self.make_agent(Path(directory))
            env = TimeoutEnvironment("timeout", 1)
            with self.assertRaises(asyncio.TimeoutError):
                await agent.run("Synthetic", env, AgentContext())
            self.assertEqual(len(env.commands), 2)

    async def test_request_probe_exhaustion_retains_metadata_for_official_verifier(self):
        with tempfile.TemporaryDirectory() as directory:
            agent = self.make_agent(Path(directory))
            context = AgentContext()
            await agent.run("Synthetic", RecordingEnvironment("request-budget-exhausted", 1), context)
            self.assertEqual(context.metadata["coldx"]["status"], "request-budget-exhausted")

    async def test_surviving_or_ambiguous_processes_block_even_a_completed_report(self):
        class AmbiguousEnvironment(RecordingEnvironment):
            async def exec(self, **kwargs):
                self.commands.append(kwargs)
                return SimpleNamespace(return_code=1 if "stop-owned-process.mjs" in kwargs["command"] else 0)
            async def download_file(self, *_):
                raise AssertionError("Do not collect a workspace while owned processes may still run")
        with tempfile.TemporaryDirectory() as directory:
            agent = self.make_agent(Path(directory))
            with self.assertRaisesRegex(RuntimeError, "Cannot confirm ColdX stopped"):
                await agent.run("Synthetic", AmbiguousEnvironment(), AgentContext())

    async def test_complete_transport_usage_includes_auxiliary_requests(self):
        class MeteredEnvironment(RecordingEnvironment):
            async def download_file(self, source, target):
                await super().download_file(source, target)
                if source.endswith("session-report.json"):
                    value = json.loads(Path(target).read_text(encoding="utf-8"))
                    value["tokenAccounting"] = {"complete": True, "totals": {"promptTokens": 30, "completionTokens": 7}}
                    Path(target).write_text(json.dumps(value), encoding="utf-8")
        with tempfile.TemporaryDirectory() as directory:
            agent = self.make_agent(Path(directory))
            context = AgentContext()
            await agent.run("Synthetic", MeteredEnvironment(), context)
            self.assertEqual(context.n_input_tokens, 30)
            self.assertEqual(context.n_output_tokens, 7)
            self.assertIsNone(context.cost_usd)

    def test_explicit_model_and_endpoint_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                ColdXMountedAgent(logs_dir=Path(directory), model_name="another-model")
            agent = self.make_agent(Path(directory))
            agent.extra_env["COLDX_EVAL_UPSTREAM_BASE_URL"] = "https://user:secret@synthetic.invalid"
            with self.assertRaises(ValueError):
                agent.network_allowlist()


if __name__ == "__main__":
    unittest.main()
