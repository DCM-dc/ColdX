"""SYNTHETIC TEST FIXTURES ONLY. No model runs or benchmark evidence.

All trial JSON and charts are created inside automatically removed temporary
directories. The explicit marker must prevent their use in production charts.
"""
import importlib.util
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import shutil
import unittest
import uuid

HERE = Path(__file__).resolve().parent


def module(name):
    path = HERE / f"{name}.py"
    if not path.exists():
        return None
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class ResultsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="SYNTHETIC_TEST_ONLY_")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "trials").mkdir()
        self.manifest = {
            "schema_version": 1, "benchmark": "deepswe", "scope": "pilot",
            "inventory": "inventory.json", "results_dir": "trials",
            "task_names": ["task-a", "task-b"], "repetitions": 2,
            "agent_label": "ColdX", "model": "DeepSeek-V4.1-Flash",
            "agent": {"name": "coldx-native", "version": "TEST_ONLY", "model_name": "deepseek-flash"},
            "pier_commit": "0c802fc067a425345b24d1c69411aa98acf61a1d",
            "benchmark_revision": "0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea",
            "protocol_notes": ["SYNTHETIC TEST FIXTURE - NOT BENCHMARK EVIDENCE"],
            "protocol": {"reasoning_effort": 100, "temperature": 1.0, "top_p": 0.95,
                         "context_limit": "1M", "max_steps": 500,
                         "platform": "Linux containers", "terminal_network": False},
        }
        self.inventory(["task-a", "task-b"])
        self.save_manifest()

    def inventory(self, names):
        (self.root / "inventory.json").write_text(json.dumps({
            "commit": self.manifest["benchmark_revision"], "task_count": len(names),
            "tasks": [{"task_id": n} for n in names]}), encoding="utf-8")

    def save_manifest(self):
        path = self.root / "run.json"
        path.write_text(json.dumps(self.manifest), encoding="utf-8")
        return path

    def trial(self, task, reward=1, **changes):
        name = f"{task}__{uuid.uuid4().hex[:7]}"
        value = {
            "_synthetic_test_fixture": "SYNTHETIC TEST ONLY - NEVER BENCHMARK EVIDENCE",
            "id": str(uuid.uuid4()), "task_name": task, "trial_name": name,
            "trial_uri": "file:///SYNTHETIC_TEST_ONLY/" + name,
            "task_id": {"path": "tasks/" + task}, "task_checksum": "a" * 64,
            "config": {"trial_name": name, "task": {"path": "tasks/" + task},
                       "verifier": {"disable": False}, "agent": {"name": "coldx-native"}},
            "agent_info": {"name": "coldx-native", "version": "TEST_ONLY",
                           "model_info": {"name": "deepseek-flash", "provider": "deepseek"}},
            "verifier_result": {"rewards": {"reward": reward, "partial": 0.75, "f2p": 0.5}},
            "started_at": "2026-09-13T00:00:00Z", "finished_at": "2026-09-13T00:02:00Z",
            "verifier": {"started_at": "2026-09-13T00:01:00Z", "finished_at": "2026-09-13T00:02:00Z"},
            "exception_info": None,
        }
        value.update(changes)
        directory = self.root / "trials" / name
        directory.mkdir()
        path = directory / "result.json"
        path.write_text(json.dumps(value), encoding="utf-8")
        return path, value

    def aggregate(self):
        target = module("aggregate")
        self.assertIsNotNone(target, "aggregate.py must exist")
        return target.aggregate_run(self.save_manifest())

    def complete_pilot(self):
        for task in self.manifest["task_names"]:
            self.trial(task, 0)
            self.trial(task, 1)

    def test_no_data_has_no_score(self):
        report = self.aggregate()
        self.assertEqual(report["status"], "no_data")
        self.assertIsNone(report["score_percent"])
        self.assertEqual(report["missing_trials"], 4)

    def test_true_zero_counted_and_auxiliary_metrics_ignored(self):
        self.complete_pilot()
        report = self.aggregate()
        self.assertEqual(report["status"], "complete")
        self.assertEqual(report["score_percent"], 50)
        self.assertEqual(report["counts"]["scored_task_failure"], 2)
        self.assertEqual(report["evidence_kind"], "synthetic_test_fixture")

    def test_partial_never_emits_formal_score(self):
        self.trial("task-a", 1)
        report = self.aggregate()
        self.assertEqual(report["status"], "partial")
        self.assertIsNone(report["score_percent"])
        self.assertEqual(report["missing_trials"], 3)

    def test_infrastructure_sentinel_not_zero(self):
        self.trial("task-a", -1)
        report = self.aggregate()
        self.assertEqual(report["counts"]["infrastructure_failure"], 1)
        self.assertEqual(report["scored_trials"], 0)

    def test_missing_or_bad_rewards_not_coerced(self):
        for value in (None, {}, {"partial": 1}, {"reward": True}, {"reward": "1"}, {"reward": 0.5}, {"reward": float("nan")}):
            with self.subTest(value=value):
                result = module("aggregate")
                self.assertIsNotNone(result)
                _, trial = self.trial("task-a", verifier_result={"rewards": value})
                category = result.classify_trial(trial)["category"]
                self.assertIn(category, {"missing_reward", "invalid_reward"})

    def test_agent_timeout_with_completed_verifier_counts(self):
        self.complete_pilot()
        path = next((self.root / "trials").glob("*/result.json"))
        trial = json.loads(path.read_text())
        trial["exception_info"] = {"exception_type": "AgentTimeoutError"}
        path.write_text(json.dumps(trial))
        report = self.aggregate()
        self.assertEqual(report["status"], "complete")
        self.assertEqual(report["score_percent"], 50)
        self.assertEqual(report["agent_timeouts"], 1)

    def test_probe_request_budget_is_protocol_limit_not_normal_steps(self):
        self.complete_pilot()
        path = next((self.root / "trials").glob("*/result.json"))
        trial = json.loads(path.read_text())
        trial["agent_result"] = {"metadata": {"coldx": {"status": "request-budget-exhausted"}}}
        path.write_text(json.dumps(trial))
        report = self.aggregate()
        self.assertEqual(report["status"], "partial")
        self.assertIsNone(report["score_percent"])
        self.assertEqual(report["counts"]["protocol_limit"], 1)
        detail = next(d for d in report["trial_details"] if d["category"] == "protocol_limit")
        self.assertIn(detail["observed_reward"], (0, 1))

    def test_native_step_and_time_limits_with_reward_are_valid(self):
        target = module("aggregate")
        self.assertIsNotNone(target)
        for status in ("step-limit", "timeout"):
            _, trial = self.trial("task-a", 0, agent_result={"metadata": {"coldx": {"status": status}}})
            verdict = target.classify_trial(trial)
            self.assertEqual(verdict["score"], 0)
            self.assertEqual(verdict["agent_timeout"], status == "timeout")

    def test_recovered_native_completion_counts_actual_verifier_reward_without_erasing_errors(self):
        target = module("aggregate")
        for reward in (0, 1):
            coldx = {"status": "completed", "session_report": {
                "status": "completed", "transportOutcome": {"state": "completed-after-errors"},
                "transport": {"upstreamHttpErrors": 2}, "tokenAccounting": {"complete": False},
            }}
            _, trial = self.trial("task-a", reward, agent_result={"metadata": {"coldx": coldx}})
            verdict = target.classify_trial(trial)
            self.assertEqual(verdict["score"], reward)
            self.assertEqual(verdict["transport_outcome"], "completed-after-errors")
            self.assertEqual(verdict["transport_error_counts"]["upstreamHttpErrors"], 2)
            self.assertFalse(verdict["token_usage_complete"])
            self.assertEqual(coldx["session_report"]["transport"]["upstreamHttpErrors"], 2)

    def test_explicit_terminal_failure_cannot_be_hidden_by_missing_pier_exception(self):
        target = module("aggregate")
        for status in ("transport-error", "driver-error", "native-error", "interrupted", "missing-report", "error", "unknown"):
            with self.subTest(status=status):
                _, trial = self.trial("task-a", 1, agent_result={"metadata": {"coldx": {"status": status}}}, exception_info=None)
                verdict = target.classify_trial(trial)
                self.assertEqual(verdict["category"], "infrastructure_failure")
                self.assertIsNone(verdict["score"])
                self.assertEqual(verdict["observed_reward"], 1)

    def test_infrastructure_timeout_or_error_with_reward_not_counted(self):
        result = module("aggregate")
        self.assertIsNotNone(result)
        for kind in ("VerifierTimeoutError", "AgentSetupTimeoutError", "EnvironmentStartTimeoutError", "RewardFileNotFoundError", "NonZeroAgentExitCodeError", "UnknownError"):
            with self.subTest(kind=kind):
                _, trial = self.trial("task-a", exception_info={"exception_type": kind})
                observed = result.classify_trial(trial)
                self.assertEqual(observed["category"], "infrastructure_failure")
                self.assertIsNone(observed["score"])
                self.assertEqual(observed["observed_reward"], 1)

    def test_unfinished_and_disabled_verifiers_excluded(self):
        result = module("aggregate")
        self.assertIsNotNone(result)
        for changes in ({"finished_at": None}, {"verifier": {"finished_at": None}}, {"config": {"verifier": {"disable": True}}}):
            _, trial = self.trial("task-a", **changes)
            self.assertIsNone(result.classify_trial(trial)["score"])

    def test_duplicate_trial_is_not_an_extra_attempt(self):
        path, value = self.trial("task-a", 1)
        self.trial("task-a", **{"id": value["id"], "trial_name": value["trial_name"]})
        report = self.aggregate()
        self.assertEqual(report["status"], "partial")
        self.assertTrue(any("duplicate" in p for p in report["problems"]))

    def test_extra_attempt_rejected_not_best_of_n(self):
        self.complete_pilot()
        self.trial("task-a", 1)
        report = self.aggregate()
        self.assertEqual(report["status"], "partial")
        self.assertIsNone(report["score_percent"])
        self.assertEqual(report["extra_trials"], 1)

    def test_unknown_task_and_mixed_agent_invalidate_full_run(self):
        self.complete_pilot()
        self.trial("unexpected", 1)
        self.trial("task-a", agent_info={"name": "other", "version": "TEST_ONLY", "model_info": {"name": "deepseek-flash"}})
        report = self.aggregate()
        self.assertEqual(report["status"], "partial")
        self.assertEqual(report["counts"]["metadata_mismatch"], 2)

    def canonical_pilot_fixture(self):
        inventory = json.loads((HERE / "deepswe-inventory.json").read_text(encoding="utf-8"))
        (self.root / "inventory.json").write_text(json.dumps(inventory), encoding="utf-8")
        self.manifest.update(task_names=["abs-module-cache-flags"], repetitions=1,
                             task_directory_root="/opt/coldx-benchmark/upstream/deep-swe/tasks")
        path, value = self.trial("abs-module-cache-flags", 1)
        value["task_name"] = "datacurve/abs-module-cache-flags"
        task_path = "/opt/coldx-benchmark/upstream/deep-swe/tasks/abs-module-cache-flags"
        value["task_id"]["path"] = task_path
        value["config"]["task"]["path"] = task_path
        path.write_text(json.dumps(value), encoding="utf-8")
        return path, value

    def test_pinned_official_task_name_maps_to_inventory_directory_without_changing_raw_name(self):
        path, value = self.canonical_pilot_fixture()
        before = path.read_bytes()
        report = self.aggregate()
        self.assertEqual(report["status"], "complete")
        self.assertEqual(report["score_percent"], 100)
        self.assertEqual(report["trial_details"][0]["task_name"], "datacurve/abs-module-cache-flags")
        self.assertEqual(report["trial_details"][0]["canonical_task_id"], "abs-module-cache-flags")
        self.assertEqual(report["per_task"][0]["task_name"], "abs-module-cache-flags")
        self.assertEqual(path.read_bytes(), before)

    def test_arbitrary_task_prefix_is_not_stripped(self):
        path, value = self.canonical_pilot_fixture()
        value["task_name"] = "unknown-provider/abs-module-cache-flags"
        path.write_text(json.dumps(value), encoding="utf-8")
        report = self.aggregate()
        self.assertEqual(report["counts"], {"metadata_mismatch": 1})
        self.assertEqual(report["scored_trials"], 0)
        self.assertEqual(report["trial_details"][0]["task_name"], value["task_name"])

    def test_both_recorded_task_paths_must_match_the_fixed_canonical_directory(self):
        path, original = self.canonical_pilot_fixture()
        for location in ("task_id", "config"):
            for changed in ("/tmp/copied/abs-module-cache-flags",
                            "/opt/coldx-benchmark/upstream/deep-swe/tasks/other-task",
                            "/opt/coldx-benchmark/upstream/deep-swe/tasks/../tasks/abs-module-cache-flags",
                            "/opt/coldx-benchmark/upstream/deep-swe/tasks//abs-module-cache-flags", None):
                with self.subTest(location=location, changed=changed):
                    value = json.loads(json.dumps(original))
                    target = value["task_id"] if location == "task_id" else value["config"]["task"]
                    target["path"] = changed
                    path.write_text(json.dumps(value), encoding="utf-8")
                    report = self.aggregate()
                    self.assertEqual(report["counts"], {"metadata_mismatch": 1})
                    self.assertIsNone(report["score_percent"])

    def test_canonical_inventory_hash_must_match_the_pinned_git_blob(self):
        self.canonical_pilot_fixture()
        path = self.root / "inventory.json"
        inventory = json.loads(path.read_text())
        row = next(row for row in inventory["tasks"] if row["task_id"] == "abs-module-cache-flags")
        row["task_toml_canonical_sha256"] = "0" * 64
        path.write_text(json.dumps(inventory))
        with self.assertRaisesRegex(ValueError, "canonical|blob"):
            self.aggregate()

    def test_unknown_inventory_schema_cannot_silently_downgrade_identity_checks(self):
        self.canonical_pilot_fixture()
        path = self.root / "inventory.json"
        inventory = json.loads(path.read_text())
        inventory["schema_version"] = 3
        path.write_text(json.dumps(inventory))
        with self.assertRaisesRegex(ValueError, "schema"):
            self.aggregate()

    def test_malformed_canonical_task_config_is_unscored_without_crashing_aggregation(self):
        path, original = self.canonical_pilot_fixture()
        for bad_config in (None, [], "bad", {"task": None}, {"task": []}):
            with self.subTest(config=bad_config):
                value = dict(original, config=bad_config)
                path.write_text(json.dumps(value), encoding="utf-8")
                report = self.aggregate()
                self.assertEqual(report["scored_trials"], 0)
                self.assertIsNone(report["score_percent"])

    def test_combined_copy_preserves_raw_bytes_source_uri_and_duplicate_detection(self):
        path, value = self.canonical_pilot_fixture()
        source_bytes = path.read_bytes()
        destination = self.root / "combined" / path.parent.name
        destination.mkdir(parents=True)
        shutil.copyfile(path, destination / "result.json")
        self.manifest["results_dir"] = "combined"
        report = self.aggregate()
        self.assertEqual(report["status"], "complete")
        self.assertEqual(hashlib.sha256((destination / "result.json").read_bytes()).digest(), hashlib.sha256(source_bytes).digest())
        self.assertEqual(json.loads((destination / "result.json").read_text())["trial_uri"], value["trial_uri"])
        duplicate = destination.parent / "copied-twice"
        duplicate.mkdir()
        shutil.copyfile(path, duplicate / "result.json")
        report = self.aggregate()
        self.assertEqual(report["status"], "partial")
        self.assertIn("duplicate_trial", report["counts"])
        self.assertIsNone(report["score_percent"])

    def test_job_summary_not_double_counted_and_malformed_trial_visible(self):
        self.complete_pilot()
        (self.root / "trials" / "result.json").write_text(json.dumps({"trial_results": [1, 2]}))
        self.assertEqual(self.aggregate()["scored_trials"], 4)
        bad = self.root / "trials" / "broken"
        bad.mkdir()
        (bad / "result.json").write_text("not-json")
        report = self.aggregate()
        self.assertEqual(report["status"], "partial")
        self.assertEqual(report["counts"]["invalid_result"], 1)

    def test_full_protocol_requires_exact_task_count_and_repetitions(self):
        self.manifest["scope"] = "full"
        target = module("aggregate")
        self.assertIsNotNone(target)
        with self.assertRaisesRegex(ValueError, "113|8"):
            self.aggregate()

    def test_task_checksum_changes_cannot_be_merged(self):
        self.complete_pilot()
        path = next((self.root / "trials").glob("*/result.json"))
        trial = json.loads(path.read_text())
        trial["task_checksum"] = "b" * 64
        path.write_text(json.dumps(trial))
        report = self.aggregate()
        self.assertEqual(report["status"], "partial")
        self.assertIsNone(report["score_percent"])
        self.assertTrue(any("checksum" in p for p in report["problems"]))

    def test_incorrect_inventory_or_pier_commit_rejected(self):
        self.manifest["pier_commit"] = "c" * 40
        with self.assertRaisesRegex(ValueError, "Pier"):
            self.aggregate()
        self.manifest["pier_commit"] = "0c802fc067a425345b24d1c69411aa98acf61a1d"
        self.manifest["task_names"] = ["task-a", "not-in-inventory"]
        with self.assertRaisesRegex(ValueError, "inventory"):
            self.aggregate()

    def test_multistep_not_guessed_from_aggregate_reward(self):
        self.trial("task-a", step_results=[{"step_name": "synthetic"}])
        report = self.aggregate()
        self.assertEqual(report["counts"]["unsupported_multistep"], 1)
        self.assertIsNone(report["score_percent"])

    def test_protocol_differences_visible_without_relabeling_official(self):
        self.manifest["protocol"]["top_p"] = 1.0
        report = self.aggregate()
        self.assertTrue(any("top_p" in note for note in report["protocol_differences"]))

    def test_symlink_trial_cannot_import_outside_data(self):
        outside = self.root / "OUTSIDE_TEST_ONLY"
        outside.mkdir()
        (outside / "result.json").write_text("{}")
        try:
            (self.root / "trials" / "linked").symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest("OS does not permit symlinks for this test account")
        report = self.aggregate()
        self.assertEqual(report["counts"]["invalid_result"], 1)
        self.assertEqual(report["scored_trials"], 0)

    def test_complete_full_deepswe_is_mean_of_904_not_best_of_eight(self):
        names = [f"task-{i:03}" for i in range(113)]
        self.inventory(names)
        self.manifest.update(scope="full", task_names=names, repetitions=8)
        for task in names:
            for repeat in range(8):
                self.trial(task, int(repeat == 0))
        report = self.aggregate()
        self.assertEqual(report["status"], "complete")
        self.assertEqual(report["scored_trials"], 904)
        self.assertEqual(report["score_percent"], 12.5)

    def test_complete_full_tb_is_mean_of_267(self):
        names = [f"task-{i:03}" for i in range(89)]
        self.manifest.update(benchmark="terminal-bench", benchmark_revision="b" * 40,
                             scope="full", task_names=names, repetitions=3)
        self.inventory(names)
        for task in names:
            for repeat in range(3):
                self.trial(task, int(repeat == 0))
        report = self.aggregate()
        self.assertEqual(report["scored_trials"], 267)
        self.assertAlmostEqual(report["score_percent"], 100 / 3)

    def test_cli_refuses_synthetic_report_output(self):
        self.complete_pilot()
        output = self.root / "should-not-exist.json"
        result = subprocess.run([sys.executable, str(HERE / "aggregate.py"), "--manifest", str(self.save_manifest()), "--output", str(output)], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output.exists())

    def test_plot_rejects_missing_partial_synthetic_and_wrong_scope(self):
        target = module("plot")
        self.assertIsNotNone(target, "plot.py must exist")
        empty = self.aggregate()
        for mode in ("full", "pilot"):
            with self.assertRaises(ValueError):
                target.validate_report(empty, mode)
        self.complete_pilot()
        fixture = self.aggregate()
        with self.assertRaisesRegex(ValueError, "synthetic"):
            target.validate_report(fixture, "pilot")
        fixture["evidence_kind"] = "local_measured"
        with self.assertRaisesRegex(ValueError, "scope"):
            target.validate_report(fixture, "full")

    def test_official_only_plot_has_eight_agents_and_no_coldx(self):
        target = module("plot")
        self.assertIsNotNone(target)
        reference = json.loads((HERE.parent / "data.json").read_text())
        series = target.comparison_series(reference, [])
        self.assertEqual(len(series["agents"]), 8)
        self.assertNotIn("ColdX", series["agents"])
        output = self.root / "OFFICIAL_REFERENCE_TEST_RENDER.png"
        target.render_comparison(reference, [], output)
        self.assertGreater(output.stat().st_size, 5000)


if __name__ == "__main__":
    unittest.main()
