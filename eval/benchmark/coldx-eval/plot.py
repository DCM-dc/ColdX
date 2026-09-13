"""Plot official references, completed full ColdX runs, or separate pilot data."""
import argparse
import json
import math
from pathlib import Path
import sys
import textwrap

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from aggregate import BENCHMARKS, aggregate_run


def validate_report(report, scope):
    if report.get("evidence_kind") != "local_measured":
        raise ValueError("synthetic or unknown evidence cannot be plotted as a ColdX score")
    if report.get("scope") != scope:
        raise ValueError("pilot and full scope must use separate charts")
    score = report.get("score_percent")
    if (report.get("status") != "complete" or type(score) not in (int, float)
            or not math.isfinite(score) or not 0 <= score <= 100):
        raise ValueError("missing or partial ColdX data has no eligible aggregate score")
    benchmark = report.get("benchmark")
    if benchmark not in BENCHMARKS or report.get("agent_label") != "ColdX":
        raise ValueError("unexpected benchmark or agent")
    if report.get("scored_trials") != report.get("required_trials"):
        raise ValueError("not all required trials were scored")
    if scope == "full":
        expected = BENCHMARKS[benchmark]
        if (report.get("task_count") != expected["tasks"] or report.get("repetitions") != expected["repetitions"]):
            raise ValueError("full chart requires the complete official task and repetition counts")


def comparison_series(reference, reports):
    agents = reference.get("agents")
    if not isinstance(agents, list) or len(agents) != 8 or len(set(agents)) != 8 or "ColdX" in agents:
        raise ValueError("reference must contain the original eight official agents")
    series = {"agents": list(agents), "values": {}, "local_index": None}
    for key, benchmark in BENCHMARKS.items():
        values = reference.get(benchmark["label"])
        if (not isinstance(values, list) or len(values) != 8
                or any(type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 100 for v in values)):
            raise ValueError("invalid official reference values")
        series["values"][key] = list(values)
    if reports:
        if len(reports) != 2 or {r.get("benchmark") for r in reports} != set(BENCHMARKS):
            raise ValueError("append ColdX only after both complete full benchmark runs exist")
        if reports[0].get("agent") != reports[1].get("agent"):
            raise ValueError("both ColdX runs must identify the same agent version and model")
        for report in reports:
            validate_report(report, "full")
            if report.get("model") != reference.get("model"):
                raise ValueError("local and official model identities differ")
            series["values"][report["benchmark"]].append(report["score_percent"])
        series["local_index"] = len(agents)
        series["agents"].append("ColdX")
    return series


def pyplot():
    deps = HERE.parent / ".deps"
    if deps.is_dir():
        sys.path.insert(0, str(deps))
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    return plt


def _save(fig, output):
    output = Path(output)
    if output.exists():
        raise ValueError("chart output already exists; choose a new output path")
    fig.savefig(output, dpi=180, facecolor="white")


def render_comparison(reference, reports, output):
    series = comparison_series(reference, reports)
    plt = pyplot()
    fig, axes = plt.subplots(1, 2, figsize=(14, 8.7), sharey=True)
    try:
        y = list(range(len(series["agents"])))
        local = series["local_index"]
        labels = [name + ("  [local measured]" if i == local else "  [official]")
                  for i, name in enumerate(series["agents"])]
        for ax, (key, benchmark) in zip(axes, BENCHMARKS.items()):
            values = series["values"][key]
            bars = ax.barh(y, values, color=["#d67520" if i == local else "#477dab" for i in y], height=0.62)
            if local is not None:
                bars[local].set_hatch("///")
                ax.axhline(local - 0.5, color="#a0a0a0", linewidth=1)
            ax.set_yticks(y, labels)
            ax.set_xlim(0, 100)
            ax.set_title(benchmark["label"], loc="left", fontsize=13)
            ax.set_xlabel("Score (%) - arithmetic mean")
            ax.grid(axis="x", alpha=0.18)
            ax.set_axisbelow(True)
            for bar, value in zip(bars, values):
                ax.text(value + 0.7, bar.get_y() + bar.get_height() / 2, f"{value:.1f}", va="center", fontsize=10)
            for side in ("top", "right", "left"):
                ax.spines[side].set_visible(False)
        axes[0].invert_yaxis()
        fig.suptitle(reference["model"] + " - agent scaffold comparison", x=0.03, ha="left", fontsize=19, fontweight="bold")
        note = "Blue: official reported reference (redrawn). Orange/hatch: complete local ColdX measurements. " if reports else "Official reported reference only (redrawn). No ColdX measurements are available in this chart. "
        note += "DeepSWE: 113 tasks x 8; Terminal-Bench: 89 x 3. Repeats are averaged, never best-of-N."
        if reports:
            note += " Local source/environment may differ; this is not an exact reproduction claim."
        fig.text(0.03, 0.13, textwrap.fill(note, 150), fontsize=9, va="top")
        source = str(reference.get("source", "")).split("#")[0]
        fig.text(0.03, 0.065, "Official source: " + source, fontsize=8)
        if reports:
            short = "; ".join(f"{r['benchmark']}: {r['benchmark_revision'][:12]}" for r in reports)
            fig.text(0.03, 0.037, "Local benchmark revisions: " + short + "; see aggregate reports for declared settings and differences.", fontsize=8)
        fig.tight_layout(rect=(0.02, 0.19, 0.98, 0.92), w_pad=3)
        _save(fig, output)
    finally:
        plt.close(fig)


def render_pilot(report, output):
    validate_report(report, "pilot")
    plt = pyplot()
    tasks = report["per_task"]
    fig, ax = plt.subplots(figsize=(11, max(5, 0.35 * len(tasks) + 3)))
    try:
        names = [t["task_name"] for t in tasks]
        values = [100 * t["mean_reward"] for t in tasks]
        bars = ax.barh(names, values, color="#d67520", hatch="///")
        ax.invert_yaxis()
        ax.set_xlim(0, 108)
        ax.set_xlabel("Per-task mean reward (%)")
        ax.set_title(f"ColdX PILOT ONLY - {report['metric']}\n{report['task_count']} selected tasks x {report['repetitions']} trials; pilot mean {report['score_percent']:.1f}%", loc="left")
        for bar, value in zip(bars, values):
            ax.text(value + 1, bar.get_y() + bar.get_height() / 2, f"{value:.1f}", va="center")
        fig.text(0.02, 0.04, "Local measured pilot; not a full benchmark score and not comparable to the official full-set leaderboard.\nModel: " + report["model"] + "; no official reference scores are included.", fontsize=9)
        fig.tight_layout(rect=(0.01, 0.12, 0.99, 0.98))
        _save(fig, output)
    finally:
        plt.close(fig)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("official", "full", "pilot"), required=True)
    parser.add_argument("--manifest", type=Path, action="append", default=[])
    parser.add_argument("--reference", type=Path, default=HERE.parent / "data.json")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        reports = [aggregate_run(path) for path in args.manifest]
        if args.mode == "pilot":
            if len(reports) != 1:
                raise ValueError("pilot mode requires exactly one pilot manifest")
            render_pilot(reports[0], args.output)
        else:
            if args.mode == "official" and reports:
                raise ValueError("official mode does not accept local manifests")
            if args.mode == "full" and not reports:
                raise ValueError("full mode requires completed real ColdX manifests")
            reference = json.loads(args.reference.read_text(encoding="utf-8-sig"))
            render_comparison(reference, reports, args.output)
        print(f"Created {args.mode} chart: {args.output}")
        return 0
    except (OSError, ValueError) as error:
        print(f"Refused: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
