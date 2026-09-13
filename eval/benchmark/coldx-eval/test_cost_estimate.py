"""Synthetic numerical accounting fixtures only; no models or benchmark scores."""
import copy
import importlib.util
from pathlib import Path
import unittest


class CostTests(unittest.TestCase):
    def module(self):
        path = Path(__file__).with_name("cost_estimate.py")
        self.assertTrue(path.exists(), "Cost estimator must exist")
        spec = importlib.util.spec_from_file_location("cost_estimate", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def report(self, complete=True):
        totals = dict(promptTokens=18780265, cachedInputTokens=18674688,
                      uncachedInputTokens=105577, completionTokens=81884, reasoningTokens=28690)
        return {"schema": "coldx-external-evaluation-proxy-v1", "status": "stopped",
                "startedAt": "2026-09-13T06:56:46.367Z", "updatedAt": "2026-09-13T07:08:30.592Z",
                "stats": {"forwardedRequests": 175, "upstreamHttpErrors": 2,
                          "tokenAccounting": {"complete": complete, "observedRequests": 175,
                                              "accountedRequests": 175, "pendingRequests": 0,
                                              "incompleteResponseRequests": 0 if complete else 1,
                                              "totals": totals, "knownRequestCounts": {key: 175 for key in totals}}}}

    def test_cached_input_charged_and_reasoning_not_added_twice(self):
        row = self.module().estimate_transport(self.report())
        self.assertEqual(row["tariffs"]["offpeak"]["complete_estimate_cny"], 0.80660676)
        self.assertEqual(row["tariffs"]["peak"]["complete_estimate_cny"], 1.61321352)
        self.assertEqual(row["error_counts"]["upstreamHttpErrors"], 2)
        self.assertEqual(row["proxy_lifetime_seconds"], 704.225)

    def test_incomplete_response_keeps_known_charges_without_claiming_complete_cost(self):
        row = self.module().estimate_transport(self.report(False))
        self.assertFalse(row["cost_coverage_complete"])
        self.assertIsNone(row["tariffs"]["offpeak"]["complete_estimate_cny"])
        self.assertEqual(row["tariffs"]["offpeak"]["reported_component_sum_cny"], 0.80660676)

    def test_unknown_cache_usage_stays_null_instead_of_zero(self):
        raw = self.report(False)
        raw["stats"]["tokenAccounting"]["totals"]["cachedInputTokens"] = None
        raw["stats"]["tokenAccounting"]["knownRequestCounts"]["cachedInputTokens"] = 0
        row = self.module().estimate_transport(raw)
        self.assertIsNone(row["tariffs"]["offpeak"]["components_cny"]["cachedInputTokens"])
        self.assertIsNone(row["tariffs"]["offpeak"]["complete_estimate_cny"])
        self.assertEqual(row["coverage"]["cachedInputTokens"]["requests_with_value"], 0)

    def test_session_proxy_and_running_reports_are_rejected(self):
        for field, value in [("schema", "coldx-evaluation-session-v1"), ("status", "running")]:
            raw = self.report();raw[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.module().estimate_transport(raw)

    def test_one_observed_task_is_not_three_samples_or_a_measured_tb_cost(self):
        module = self.module()
        row = module.estimate_transport(self.report(False))
        scenarios = module.extrapolate([row], [])
        self.assertEqual(scenarios["observed_pilot_tasks"], 1)
        self.assertEqual(scenarios["pre_registered_pilot_tasks"], 3)
        self.assertIsNone(scenarios["terminal_bench"]["measured_cost_cny"])
        self.assertEqual(scenarios["terminal_bench"]["assumed_cost_ratio_scenarios"], [])
        self.assertEqual(scenarios["deepswe"]["full_trials"], 904)
        self.assertEqual(scenarios["terminal_bench"]["full_trials"], 267)
        self.assertIsNone(scenarios["deepswe"]["tariffs"]["offpeak"]["complete_usage_projection_cny"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
