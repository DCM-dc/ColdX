"""Local-only tariff scenarios from final external transport metadata; no model calls."""
import argparse
from datetime import datetime
from decimal import Decimal
import hashlib
import json
import math
from pathlib import Path

TASKS = ("abs-module-cache-flags", "adaptix-name-mapping-aliases", "arktype-json-schema-refs-dependencies")
RATES = {"offpeak": {"cachedInputTokens": "0.02", "uncachedInputTokens": "1", "completionTokens": "4"},
         "peak": {"cachedInputTokens": "0.04", "uncachedInputTokens": "2", "completionTokens": "8"}}
PRICE_SOURCE = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/"


def integer(value, optional=False):
    if optional and value is None:
        return None
    if type(value) is not int or value < 0:
        raise ValueError("Usage and request counts must be nonnegative integers or explicitly unknown")
    return value


def estimate_transport(report):
    if report.get("schema") != "coldx-external-evaluation-proxy-v1" or report.get("status") != "stopped":
        raise ValueError("Use a final stopped external transport report, never the second session-proxy ledger")
    stats = report["stats"]
    usage = stats["tokenAccounting"]
    forwarded = integer(stats["forwardedRequests"])
    totals, counts = usage["totals"], usage["knownRequestCounts"]
    coverage = {}
    for field in ("promptTokens", "cachedInputTokens", "uncachedInputTokens", "completionTokens", "reasoningTokens"):
        value, known = integer(totals.get(field), True), integer(counts.get(field), True)
        if known is not None and known > forwarded:
            raise ValueError("Known usage count exceeds forwarded requests")
        if value is not None and not known:
            raise ValueError("Reported tokens have no corresponding observed requests")
        coverage[field] = {"reported_tokens": value, "requests_with_value": known,
                           "forwarded_requests": forwarded,
                           "request_coverage_fraction": known / forwarded if forwarded and known is not None else None,
                           "fully_covered": forwarded > 0 and known == forwarded and value is not None}
    cost_fields = ("promptTokens", "cachedInputTokens", "uncachedInputTokens", "completionTokens")
    fully_counted = all(coverage[field]["fully_covered"] for field in cost_fields)
    if fully_counted and totals["promptTokens"] != totals["cachedInputTokens"] + totals["uncachedInputTokens"]:
        raise ValueError("Complete prompt/cache split has inconsistent arithmetic")
    complete = usage.get("complete") is True and fully_counted
    # Completion usage already includes reasoning. totalTokens and reasoningTokens
    # are retained for coverage context, never added as separate billable outputs.
    tariffs = {}
    for tariff, rates in RATES.items():
        components = {field: None if totals.get(field) is None else Decimal(totals[field]) * Decimal(rate) / Decimal(1_000_000)
                      for field, rate in rates.items()}
        known = [value for value in components.values() if value is not None]
        subtotal = sum(known) if known else None
        tariffs[tariff] = {"components_cny": {key: float(value) if value is not None else None for key, value in components.items()},
                           "reported_component_sum_cny": float(subtotal) if subtotal is not None else None,
                           "complete_estimate_cny": float(subtotal) if complete and subtotal is not None else None}
    start, end = (datetime.fromisoformat(report[key].replace("Z", "+00:00")) for key in ("startedAt", "updatedAt"))
    if start.tzinfo is None or end.tzinfo is None or end < start:
        raise ValueError("Proxy lifetime requires valid ordered timezone-aware timestamps")
    return {"coverage": coverage, "cost_coverage_complete": complete,
            "forwarded_requests": forwarded,
            "response_coverage": {field: usage.get(field) for field in ("observedRequests", "accountedRequests", "missingUsageRequests", "pendingRequests", "incompleteResponseRequests", "oversizedEvents", "malformedEvents", "complete")},
            "error_counts": {field: stats.get(field) for field in ("timedOutRequests", "transportErrors", "upstreamHttpErrors", "refusedRedirects")},
            "tariffs": tariffs, "proxy_lifetime_seconds": (end - start).total_seconds(),
            "time_scope": "External proxy lifetime; may include setup, waiting and verification. Not isolated model inference or agent CPU time.",
            "model_response_counts": usage.get("modelResponseCounts"), "provider_invoice_verified": False}


def extrapolate(rows, tb_ratios):
    if not rows:
        raise ValueError("At least one finished pilot transport report is required")
    if any(not math.isfinite(ratio) or ratio < 0 for ratio in tb_ratios):
        raise ValueError("Explicit TB cost ratios must be finite and nonnegative")
    tariffs = {}
    for tariff in RATES:
        values = [row["tariffs"][tariff]["reported_component_sum_cny"] for row in rows]
        mean = sum(values) / len(rows) if all(value is not None for value in values) else None
        tariffs[tariff] = {"mean_reported_components_per_observed_trial_cny": mean,
                           "reported_usage_projection_cny": mean * 904 if mean is not None else None,
                           "complete_usage_projection_cny": mean * 904 if mean is not None and all(row["cost_coverage_complete"] for row in rows) else None}
    mean_duration = sum(row["proxy_lifetime_seconds"] for row in rows) / len(rows)
    tb = []
    for ratio in tb_ratios:
        item = {"assumed_tb_to_deepswe_per_trial_cost_ratio": ratio, "tariffs": {}}
        for tariff, values in tariffs.items():
            mean = values["mean_reported_components_per_observed_trial_cny"]
            item["tariffs"][tariff] = {"tb_267_reported_usage_scenario_cny": mean * ratio * 267 if mean is not None else None,
                                       "deepswe_904_plus_tb_267_scenario_cny": mean * (904 + ratio * 267) if mean is not None else None}
        tb.append(item)
    return {"kind": "Conditional repeat-the-observed-usage scenarios; not a confidence interval or validated cost forecast",
            "observed_pilot_tasks": len(rows), "pre_registered_pilot_tasks": 3,
            "missing_pilot_tasks_are_not_zero_filled": True,
            "deepswe": {"full_trials": 904, "tariffs": tariffs,
                         "repeat_mean_proxy_lifetime_serial_hours": mean_duration * 904 / 3600},
            "terminal_bench": {"full_trials": 267, "measured_cost_cny": None,
                               "assumed_cost_ratio_scenarios": tb, "measured_duration_seconds": None},
            "limitations": ["The small fixed language sample is not random or representative enough to produce confidence claims.",
                            "Reported-component projections retain incomplete usage; they do not become complete bills or rigorous upper/lower bounds.",
                            "DeepSWE costs and durations are not Terminal-Bench measurements. TB numbers require an explicit hypothetical ratio.",
                            "All-offpeak and all-peak are tariff scenarios. Aggregate usage cannot identify each request's billing period.",
                            "Serial hours repeat observed proxy lifetime; actual concurrency, task variation, retries and verification can change elapsed time."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task-report", action="append", required=True, metavar="TASK_ID=TRANSPORT_REPORT")
    parser.add_argument("--additional-report", action="append", default=[], metavar="LABEL=TRANSPORT_REPORT")
    parser.add_argument("--tb-cost-ratio", action="append", type=float, default=[])
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    rows, additional, seen_paths, seen_hashes, task_ids = [], [], set(), set(), set()
    for definitions, target, is_task in ((args.task_report, rows, True), (args.additional_report, additional, False)):
        for definition in definitions:
            label, separator, value = definition.partition("=")
            if not separator or not label:
                parser.error("Each report must have an explicit label=path")
            if is_task and (label not in TASKS or label in task_ids):
                parser.error("Task labels must be unique members of the three fixed pilot tasks")
            path = Path(value)
            if not (path.name == "transport-report.json" or path.name.endswith(".transport-report.json")) or path.is_symlink():
                parser.error("Only explicitly named safe transport-report JSON files are accepted")
            path = path.resolve(strict=True)
            if path in seen_paths or path.stat().st_size > 32 * 1024 * 1024:
                parser.error("Duplicate report or oversized metadata")
            raw = path.read_bytes();digest = hashlib.sha256(raw).hexdigest()
            if digest in seen_hashes:
                parser.error("Byte-identical duplicate ledgers would double-count expenses")
            seen_paths.add(path);seen_hashes.add(digest)
            row = estimate_transport(json.loads(raw))
            row.update(label=label, source=str(path), source_sha256=digest)
            target.append(row)
            if is_task:
                task_ids.add(label)
    all_expenses = {}
    for tariff in RATES:
        values = [row["tariffs"][tariff]["reported_component_sum_cny"] for row in rows + additional]
        known = [value for value in values if value is not None]
        all_expenses[tariff] = {"reported_component_sum_cny": sum(known) if known else None,
                               "complete_estimate_cny": sum(known) if len(known) == len(values) and all(row["cost_coverage_complete"] for row in rows + additional) else None,
                               "ledgers_with_no_priced_components": len(values) - len(known)}
    result = {"schema": "coldx-local-cost-scenarios-v1", "currency": "CNY", "rates_per_million_tokens": RATES,
              "pricing_source": PRICE_SOURCE, "pricing_checked_on": "2026-09-13",
              "billing_formula": "(cached_input*cache_rate + uncached_input*input_rate + completion_tokens*output_rate)/1000000; reasoning is included in completion_tokens",
              "pilot_tasks": rows, "additional_attempt_expenses": additional,
              "all_supplied_attempt_expenses": all_expenses, "scenarios": extrapolate(rows, args.tb_cost_ratio),
              "notes": ["External host ledger only: session proxy usage is the same traffic and must not be added again.",
                        "No reward-based filtering. Every forwarded call remains, including failed requests, auxiliary calls and failed tasks.",
                        "Supply prior interrupted or discarded-attempt host ledgers via --additional-report; they remain in actual expenses but do not become successful pilot samples.",
                        "Unknown usage/components stay null. A stopped report can still contain incomplete responses and unobserved billable usage.",
                        "Rates are the verified official reference tariff, not a gateway quote or reconciled account invoice.",
                        "Only explicitly supplied ledgers are covered; omitted runs, files/storage or other non-token charges are not assumed zero."]}
    with args.output.open("x", encoding="utf-8") as file:
        json.dump(result, file, ensure_ascii=False, indent=2, allow_nan=False)
        file.write("\n")
    print(json.dumps({"output": str(args.output), "observed_pilot_tasks": len(rows), "additional_attempts": len(additional),
                      "all_cost_coverage_complete": all(row["cost_coverage_complete"] for row in rows + additional)}))


if __name__ == "__main__":
    main()
