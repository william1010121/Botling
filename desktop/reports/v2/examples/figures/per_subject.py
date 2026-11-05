"""Template: the complete results of an experiment, the first chart of an experiment report.

usage: per_subject.py DATA.csv [ROW/COL ...] [--ylabel=TEXT]
DATA.csv columns: row, col, unit, model, variant, value
  row, col  the compared conditions (e.g. dataset × evaluation setting): one panel per row × col
  unit      the individual (subject, sample, task…): the x axis, one position per unit
  model     one colour per model
  variant   optional; the first variant met is drawn hollow (the baseline), the second filled (the method)
  value     the score
Extra ROW/COL arguments force panels that have no data; every empty panel says 未跑.
Units are categories, so marks are dots, never lines between units or between variants.
The panel title gives each model's mean (baseline → method).
"""
import csv, sys
from collections import defaultdict
import matplotlib.pyplot as plt

args = [a for a in sys.argv[2:] if not a.startswith("--")]
ylabel = next((a.split("=", 1)[1] for a in sys.argv[2:] if a.startswith("--ylabel=")), "")
rows = list(csv.DictReader(open(sys.argv[1], newline="", encoding="utf-8")))
R = list(dict.fromkeys(r["row"] for r in rows))
C = list(dict.fromkeys(r["col"] for r in rows))
for extra in args:
    r, c = extra.split("/", 1)
    R += [r] if r not in R else []
    C += [c] if c not in C else []
models = list(dict.fromkeys(r["model"] for r in rows))
variants = list(dict.fromkeys(r.get("variant") or "" for r in rows))
colour = {m: f"C{i % 6}" for i, m in enumerate(models)}

fig, axes = plt.subplots(len(R), len(C), figsize=(4.8 * len(C), 3.6 * len(R)), squeeze=False)
for i, r in enumerate(R):
    for j, c in enumerate(C):
        ax = axes[i][j]
        cell = [x for x in rows if x["row"] == r and x["col"] == c]
        if not cell:
            ax.set_title(f"{r} · {c}", loc="left")
            ax.text(0.5, 0.5, "未跑", transform=ax.transAxes, ha="center", va="center", fontsize=18, fontweight="bold", color="C5")
            ax.set_xticks([]); ax.set_yticks([])
            continue
        units = list(dict.fromkeys(x["unit"] for x in cell))
        pos = {u: k for k, u in enumerate(units)}
        width = 0.8 / max(len(models), 1)
        means = []
        for mi, m in enumerate(models):
            vals = defaultdict(list)
            for x in cell:
                if x["model"] == m:
                    vals[x.get("variant") or ""].append((pos[x["unit"]], float(x["value"])))
            if not vals:
                continue
            off = -0.4 + width * (mi + 0.5)
            parts = []
            for vi, v in enumerate(variants):
                if not vals.get(v):
                    continue
                xs, ys = zip(*vals[v])
                filled = vi > 0 or len(variants) == 1
                ax.scatter([x + off for x in xs], ys, s=34 if len(units) <= 20 else 14, color=colour[m] if filled else "none",
                           edgecolors=colour[m], linewidths=1.2, zorder=3, label=f"{m}{' · ' + v if v else ''}")
                parts.append(f"{sum(ys) / len(ys):.1f}")
            means.append(f"{m} {' → '.join(parts)}")
        ax.set_title(f"{r} · {c}\n" + ("\n" if len(means) > 2 else "　").join(means), loc="left", fontsize=10)
        step = 1 if len(units) <= 20 else 5
        ax.set_xticks(range(0, len(units), step), [units[k] for k in range(0, len(units), step)])
        ax.set_xlim(-0.6, len(units) - 0.4)
        ax.grid(axis="x", visible=False)
        if ylabel and j == 0:
            ax.set_ylabel(ylabel)
handles, labels = [], []
for ax in axes.flat:
    for h, l in zip(*ax.get_legend_handles_labels()):
        if l not in labels:
            handles.append(h); labels.append(l)
fig.legend(handles, labels, loc="lower center", ncol=min(len(labels), 3), bbox_to_anchor=(0.5, -0.01))
fig.tight_layout(rect=(0, 0.07, 1, 1))
