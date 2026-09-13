"""Aggregate completed single-step Pier trials; never run an agent or verifier.

Schema source: pier 0c802fc067a425345b24d1c69411aa98acf61a1d,
models/trial/{result,config,paths}.py and models/verifier/result.py.
The separate run manifest is our provenance/coverage contract, not a Pier model.
"""
import argparse
from collections import Counter
from datetime import datetime
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tomllib

PIER_COMMIT = "0c802fc067a425345b24d1c69411aa98acf61a1d"
DEEPSWE_COMMIT = "0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea"
BENCHMARKS = {
    "deepswe": {"tasks": 113, "repetitions": 8, "label": "DeepSWE v1.1 (Resolved)"},
    "terminal-bench": {"tasks": 89, "repetitions": 3, "label": "Terminal-Bench 2.1 (Pass@1)"},
}
PROTOCOL = {"reasoning_effort": 100, "temperature": 1.0, "top_p": 0.95,
            "context_limit": "1M", "max_steps": 500,
            "platform": "Linux containers", "terminal_network": False}


def read_json(path):
    if path.stat().st_size > 32 * 1024 * 1024:
        raise ValueError("JSON file exceeds 32 MiB bound")
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _required_text(value, field):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a nonempty string")
    return value


def _timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _finished(timing):
    if not isinstance(timing, dict):
        return False
    start = _timestamp(timing.get("started_at"))
    end = _timestamp(timing.get("finished_at"))
    try:
        return start is not None and end is not None and end >= start
    except TypeError:
        return False


def classify_trial(trial):
    """Classify a real TrialResult shape without interpreting agent prose.

    AgentTimeoutError is a task budget event if verification still completed.
    Other exceptions remain unscored; a nonzero agent exit alone cannot prove
    whether the task failed or the adapter/environment failed.
    """
    verdict = {"category": "invalid_result", "score": None, "observed_reward": None,
               "exception_type": None, "agent_timeout": False, "native_status": None,
               "transport_outcome": None, "transport_error_counts": None, "token_usage_complete": None}
    if not isinstance(trial, dict):
        return verdict
    exception = trial.get("exception_info")
    kind = exception.get("exception_type") if isinstance(exception, dict) else None
    verdict["exception_type"] = kind if isinstance(kind, str) else None
    agent_result = trial.get("agent_result")
    metadata = agent_result.get("metadata") if isinstance(agent_result, dict) else None
    coldx = metadata.get("coldx") if isinstance(metadata, dict) else None
    native_status = coldx.get("status") if isinstance(coldx, dict) else None
    verdict["native_status"] = native_status if isinstance(native_status, str) else None
    verdict["agent_timeout"] = kind == "AgentTimeoutError" or native_status == "timeout"
    session = coldx.get("session_report") if isinstance(coldx, dict) else None
    if isinstance(session, dict):
        transport = session.get("transport")
        outcome = session.get("transportOutcome")
        usage = session.get("tokenAccounting")
        if isinstance(outcome, dict) and outcome.get("state") in {"no-recorded-errors", "completed-after-errors", "budget-ended-after-errors", "failed-with-errors"}:
            verdict["transport_outcome"] = outcome["state"]
        if isinstance(transport, dict):
            fields = ("timedOutRequests", "transportErrors", "upstreamHttpErrors", "refusedRedirects")
            verdict["transport_error_counts"] = {name: transport.get(name) if type(transport.get(name)) is int and transport[name] >= 0 else None for name in fields}
            files = transport.get("files")
            file_failures = files.get("failures") if isinstance(files, dict) else None
            verdict["transport_error_counts"]["fileOperationFailures"] = file_failures if type(file_failures) is int and file_failures >= 0 else None
        if isinstance(usage, dict) and type(usage.get("complete")) is bool:
            verdict["token_usage_complete"] = usage["complete"]
    verifier_result = trial.get("verifier_result")
    rewards = verifier_result.get("rewards") if isinstance(verifier_result, dict) else None
    reward = rewards.get("reward") if isinstance(rewards, dict) else None
    numeric = type(reward) in (int, float) and math.isfinite(reward)
    if numeric:
        verdict["observed_reward"] = reward
    config = trial.get("config")
    if not isinstance(config, dict):
        return verdict
    if trial.get("step_results"):
        verdict["category"] = "unsupported_multistep"
    elif isinstance(config.get("verifier"), dict) and config["verifier"].get("disable"):
        verdict["category"] = "verifier_disabled"
    elif exception is not None and kind != "AgentTimeoutError":
        verdict["category"] = "infrastructure_failure"
    elif native_status is not None and native_status not in {"completed", "step-limit", "timeout", "request-budget-exhausted"}:
        # A present ColdX terminal status remains authoritative even if a
        # partial/exported Pier result omitted its exception_info. Historical
        # recovered transport errors do not change status='completed'.
        verdict["category"] = "infrastructure_failure"
    elif numeric and reward == -1:
        # DeepSWE test.sh's trap writes -1 when the grader never wrote a reward.
        verdict["category"] = "infrastructure_failure"
    elif not _finished(trial) or not _finished(trial.get("verifier")):
        verdict["category"] = "unfinished"
    elif not isinstance(rewards, dict) or "reward" not in rewards or reward is None:
        verdict["category"] = "missing_reward"
    elif not numeric or reward not in (0, 1):
        verdict["category"] = "invalid_reward"
    elif native_status == "request-budget-exhausted":
        # A global probe API cap is not the official per-agent 500-step limit.
        verdict["category"] = "protocol_limit"
    else:
        verdict["score"] = reward
        verdict["category"] = "scored_pass" if reward == 1 else "scored_task_failure"
    return verdict


def load_manifest(path):
    path = Path(path).resolve()
    manifest = read_json(path)
    if not isinstance(manifest, dict) or manifest.get("schema_version") != 1:
        raise ValueError("run manifest schema_version must be 1")
    benchmark = manifest.get("benchmark")
    if benchmark not in BENCHMARKS:
        raise ValueError("benchmark must be deepswe or terminal-bench")
    if manifest.get("scope") not in ("full", "pilot"):
        raise ValueError("scope must be full or pilot")
    if manifest.get("agent_label") != "ColdX":
        raise ValueError("this aggregator is for explicitly identified ColdX runs")
    _required_text(manifest.get("model"), "model")
    if manifest.get("pier_commit") != PIER_COMMIT:
        raise ValueError("manifest must identify the audited pinned Pier commit")
    revision = manifest.get("benchmark_revision")
    if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("benchmark_revision must be an explicit 40-character commit")
    if benchmark == "deepswe" and revision != DEEPSWE_COMMIT:
        raise ValueError("DeepSWE revision differs from the audited official revision")
    agent = manifest.get("agent")
    if not isinstance(agent, dict):
        raise ValueError("agent must identify Pier agent metadata")
    for key in ("name", "version", "model_name"):
        _required_text(agent.get(key), "agent." + key)
    notes = manifest.get("protocol_notes")
    if not isinstance(notes, list) or not all(isinstance(n, str) for n in notes):
        raise ValueError("protocol_notes must be a list, including known differences")
    if not isinstance(manifest.get("protocol"), dict):
        raise ValueError("protocol must record the declared runtime settings")
    inventory_path = (path.parent / _required_text(manifest.get("inventory"), "inventory")).resolve()
    inventory = read_json(inventory_path)
    if not isinstance(inventory, dict) or inventory.get("commit") != revision:
        raise ValueError("inventory commit must match benchmark_revision")
    entries = inventory.get("tasks")
    if not isinstance(entries, list):
        raise ValueError("inventory.tasks must be a list of task_id objects")
    names = [entry.get("task_id") if isinstance(entry, dict) else None for entry in entries]
    if not names or any(not isinstance(n, str) or not n for n in names) or len(set(names)) != len(names):
        raise ValueError("inventory requires unique nonempty task_id names")
    if inventory.get("task_count") != len(names):
        raise ValueError("inventory task_count does not match tasks")
    tasks = manifest.get("task_names", names)
    if not isinstance(tasks, list) or not tasks or any(not isinstance(n, str) for n in tasks) or len(set(tasks)) != len(tasks):
        raise ValueError("task_names must be a nonempty unique list")
    if not set(tasks) <= set(names):
        raise ValueError("task_names must be in the supplied pinned inventory")
    repetitions = manifest.get("repetitions")
    if type(repetitions) is not int or not 1 <= repetitions <= 100:
        raise ValueError("repetitions must be an integer between 1 and 100")
    expected = BENCHMARKS[benchmark]
    if manifest["scope"] == "full" and (len(names) != expected["tasks"] or set(tasks) != set(names) or repetitions != expected["repetitions"]):
        raise ValueError(f"full {benchmark} requires all {expected['tasks']} inventory tasks x {expected['repetitions']} repetitions")
    directory = (path.parent / _required_text(manifest.get("results_dir"), "results_dir")).resolve()
    if not directory.is_dir():
        raise ValueError("results_dir must be an existing dedicated Pier job directory")
    return manifest, sorted(tasks), directory, inventory_path


def load_task_identities(manifest, tasks, inventory_path):
    """Resolve exact official names from pinned blobs, never strip prefixes."""
    inventory = read_json(inventory_path)
    records = {entry["task_id"]: entry for entry in inventory["tasks"]}
    if inventory.get("schema_version") not in (None, 1, 2):
        raise ValueError("Unsupported task inventory schema; refusing to downgrade identity validation")
    if manifest["benchmark"] != "deepswe" or inventory.get("schema_version") != 2:
        # Legacy inventories have no attested aliases. Keep exact-name support.
        return {task: {"task_name": task, "task_directory": None} for task in tasks}
    repository = Path(__file__).resolve().parent.parent / "upstream" / "deep-swe"

    def git(*arguments):
        try:
            return subprocess.check_output(["git", *arguments], cwd=repository, stderr=subprocess.DEVNULL)
        except (OSError, subprocess.CalledProcessError) as error:
            raise ValueError("Cannot verify task identity against the pinned canonical Git blob checkout") from error

    if git("rev-parse", "HEAD").decode().strip() != manifest["benchmark_revision"]:
        raise ValueError("Task identity checkout must use the pinned canonical Git revision")
    root = manifest.get("task_directory_root", (repository / "tasks").as_posix())
    if (not isinstance(root, str) or "\\" in root or "\x00" in root or ".." in root.split("/")
            or str(PurePosixPath(root)) != root
            or root.startswith("//") or not PurePosixPath(root).is_absolute()):
        raise ValueError("task_directory_root must be an explicit canonical absolute POSIX path; declare the Linux task root when analyzing on Windows")
    identities, names = {}, set()
    for task in tasks:
        if not re.fullmatch(r"[a-z0-9-]+", task):
            raise ValueError("Canonical task identity requires a fixed inventory directory name")
        entry = records[task]
        blob = git("cat-file", "blob", f"{manifest['benchmark_revision']}:tasks/{task}/task.toml")
        digest = hashlib.sha256(blob).hexdigest()
        oid = hashlib.sha1(f"blob {len(blob)}\0".encode() + blob).hexdigest()
        if digest != entry.get("task_toml_canonical_sha256") or oid != entry.get("task_toml_git_blob_oid"):
            raise ValueError("Inventory canonical task hash or object ID differs from the pinned Git blob")
        local = repository / "tasks" / task / "task.toml"
        if local.is_symlink() or local.resolve() != local or not local.is_file():
            raise ValueError("Canonical task input must be a regular file in the fixed checkout")
        current = local.read_bytes()
        if current != blob and not (b"\r" not in blob and current == blob.replace(b"\n", b"\r\n")):
            raise ValueError("Local canonical task input differs from the pinned Git blob")
        config = tomllib.loads(blob.decode("utf-8"))
        raw_name = (config.get("task") or {}).get("name", task)
        _required_text(raw_name, "official task name")
        if config.get("metadata", {}).get("task_id") != task or raw_name in names:
            raise ValueError("Ambiguous or mismatched canonical task identity")
        names.add(raw_name)
        identities[task] = {"task_name": raw_name, "task_directory": str(PurePosixPath(root) / task),
                            "task_toml_canonical_sha256": digest, "task_toml_git_blob_oid": oid}
    return identities


def aggregate_run(manifest_path):
    manifest, tasks, directory, inventory_path = load_manifest(manifest_path)
    identities = load_task_identities(manifest, tasks, inventory_path)
    by_raw_name = {identity["task_name"]: task for task, identity in identities.items()}
    repetitions = manifest["repetitions"]
    details, problems = [], []
    seen_ids, seen_names = set(), set()
    checksums = {task: set() for task in tasks}
    synthetic = False
    # A dedicated collection has one child directory per original Pier trial.
    # Byte-identical copies from separate jobs retain their raw identity/URI.
    # A root JobResult must never be mixed with TrialResult objects.
    for path in sorted(directory.glob("*/result.json")):
        detail = {"file": path.relative_to(directory).as_posix(), "task_name": None, "canonical_task_id": None,
                  "trial_name": None, "id": None, "category": "invalid_result",
                  "score": None, "observed_reward": None, "exception_type": None,
                  "agent_timeout": False, "native_status": None}
        try:
            if path.is_symlink() or path.parent.is_symlink() or not path.resolve().is_relative_to(directory):
                raise ValueError("symlink or path outside the selected results directory")
            trial = read_json(path)
            if not isinstance(trial, dict):
                raise ValueError("trial result must be an object")
            synthetic |= bool(trial.get("_synthetic_test_fixture"))
            for key in ("id", "task_name", "trial_name", "task_checksum"):
                _required_text(trial.get(key), key)
            detail.update({key: trial[key] for key in ("id", "task_name", "trial_name")})
            canonical_task = by_raw_name.get(trial["task_name"])
            detail["canonical_task_id"] = canonical_task
            detail.update(classify_trial(trial))
            if trial["id"] in seen_ids or trial["trial_name"] in seen_names:
                problems.append("duplicate trial identity: " + detail["file"])
                detail.update(category="duplicate_trial", score=None)
            seen_ids.add(trial["id"])
            seen_names.add(trial["trial_name"])
            info = trial.get("agent_info") or {}
            model_info = info.get("model_info") or {} if isinstance(info, dict) else {}
            expected = manifest["agent"]
            metadata_ok = (isinstance(info, dict) and isinstance(model_info, dict)
                           and info.get("name") == expected["name"]
                           and info.get("version") == expected["version"]
                           and model_info.get("name") == expected["model_name"])
            task_id = trial.get("task_id")
            if not isinstance(task_id, dict):
                metadata_ok = False
            elif task_id.get("git_commit_id") not in (None, manifest["benchmark_revision"]):
                metadata_ok = False
            if canonical_task is not None:
                trial_config = trial.get("config")
                recorded_task = trial_config.get("task") if isinstance(trial_config, dict) else None
                expected_directory = identities[canonical_task]["task_directory"]
                if expected_directory is not None:
                    metadata_ok &= (isinstance(recorded_task, dict) and isinstance(task_id, dict)
                                    and recorded_task.get("path") == expected_directory
                                    and task_id.get("path") == expected_directory
                                    and recorded_task.get("git_commit_id") in (None, manifest["benchmark_revision"]))
            if canonical_task is None or not metadata_ok:
                detail.update(category="metadata_mismatch", score=None)
            elif detail["category"] != "duplicate_trial":
                checksums[canonical_task].add(trial["task_checksum"])
        except (OSError, ValueError, TypeError):
            # Do not copy raw JSON, env, exception messages or agent content.
            detail.update(category="invalid_result", score=None)
            problems.append("unreadable or malformed trial: " + detail["file"])
        details.append(detail)
    for task, values in checksums.items():
        if len(values) > 1:
            problems.append("task checksum changed across repetitions: " + task)
    per_task = []
    for task in tasks:
        trials = [d for d in details if d["canonical_task_id"] == task]
        scored = [d["score"] for d in trials if d["score"] is not None]
        per_task.append({"task_name": task, "observed_trials": len(trials),
                         "scored_trials": len(scored), "required_trials": repetitions,
                         "passed_trials": sum(scored),
                         "mean_reward": sum(scored) / repetitions if len(trials) == repetitions and len(scored) == repetitions else None})
    counts = Counter(d["category"] for d in details)
    missing = sum(max(0, repetitions - t["observed_trials"]) for t in per_task)
    extra = sum(max(0, t["observed_trials"] - repetitions) for t in per_task)
    scored_total = sum(t["scored_trials"] for t in per_task)
    required = len(tasks) * repetitions
    complete = (not problems and not missing and not extra and len(details) == required
                and all(t["mean_reward"] is not None for t in per_task))
    differences = [f"{key}: declared {manifest['protocol'].get(key)!r}; reference {value!r}"
                   for key, value in PROTOCOL.items() if manifest["protocol"].get(key) != value]
    differences.extend(f"additional local setting {key}: {value!r}"
                       for key, value in manifest["protocol"].items() if key not in PROTOCOL)
    limitations = ["Settings and source identity come from the run manifest; result JSON alone does not independently attest wire settings or source integrity.",
                   "The task inventory must be generated from the pinned benchmark, not chosen after seeing rewards.",
                   "No best-of-N, retry replacement, missing-reward zero fill, or partial overall score is performed."]
    if manifest["benchmark"] == "terminal-bench":
        limitations.append("The official table does not disclose the original TB2.1 revision and environment modifications; this is not an exact reproduction claim.")
    return {
        "schema_version": 1, "evidence_kind": "synthetic_test_fixture" if synthetic else "local_measured",
        "status": "complete" if complete else ("no_data" if not details else "partial"),
        "benchmark": manifest["benchmark"], "metric": BENCHMARKS[manifest["benchmark"]]["label"],
        "scope": manifest["scope"], "agent_label": manifest["agent_label"], "agent": manifest["agent"],
        "model": manifest["model"], "pier_commit": manifest["pier_commit"],
        "benchmark_revision": manifest["benchmark_revision"],
        "run_manifest_sha256": hashlib.sha256(Path(manifest_path).read_bytes()).hexdigest(),
        "inventory_sha256": hashlib.sha256(inventory_path.read_bytes()).hexdigest(),
        "task_count": len(tasks), "repetitions": repetitions, "required_trials": required,
        "observed_trials": len(details), "scored_trials": scored_total,
        "missing_trials": missing, "extra_trials": extra,
        "unscored_trials": sum(d["score"] is None for d in details),
        "agent_timeouts": sum(d["agent_timeout"] for d in details),
        "scored_agent_timeouts": sum(d["agent_timeout"] and d["score"] is not None for d in details),
        "agent_step_limits": sum(d["native_status"] == "step-limit" for d in details),
        "request_budget_exhaustions": sum(d["native_status"] == "request-budget-exhausted" for d in details),
        "completed_after_transport_errors": sum(d.get("transport_outcome") == "completed-after-errors" for d in details),
        "trials_with_complete_token_usage": sum(d.get("token_usage_complete") is True for d in details),
        "score_percent": 100 * sum(t["mean_reward"] for t in per_task) / len(tasks) if complete else None,
        "aggregation": "mean of per-task arithmetic means; equal fixed repetitions; never best-of-N",
        "counts": dict(sorted(counts.items())), "per_task": per_task, "trial_details": details,
        "task_identity_mapping": identities,
        "problems": problems, "declared_protocol": manifest["protocol"],
        "protocol_differences": differences, "protocol_notes": manifest["protocol_notes"],
        "limitations": limitations,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        report = aggregate_run(args.manifest)
        if report["evidence_kind"] == "synthetic_test_fixture":
            raise ValueError("synthetic test fixtures cannot be exported as an evaluation report")
        if args.output.resolve() == args.manifest.resolve():
            raise ValueError("output cannot overwrite the input manifest")
        serialized = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        with args.output.open("x", encoding="utf-8") as handle:
            handle.write(serialized)
        score = "unavailable" if report["score_percent"] is None else f"{report['score_percent']:.3f}%"
        print(f"{report['scope']} {report['status']}: {report['scored_trials']}/{report['required_trials']} scored; score {score}")
        return 0
    except (OSError, ValueError) as error:
        print(f"Refused: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
