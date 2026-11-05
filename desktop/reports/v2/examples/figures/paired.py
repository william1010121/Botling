"""Template for an experiment card: one comparison, each unit's gain (method - baseline) with the mean and its 95% interval.

usage: paired.py long.csv ROW COL MODEL [--range=LO:HI] [--unit=受試者]
long.csv has the columns row, col, unit, model, variant, value (the per_subject.py format); the first variant
is the baseline, the second the method. One dot per unit on a gain axis, sorted (largest gain on top):
blue = better, orange = worse. The thick bar is the mean with its 95% t interval, labelled on the plot.
The interval clear of 0 = a real gain. --range fixes the x axis so several cards share one scale.
"""
import csv
import math
import sys

import matplotlib.pyplot as plt

T95 = {1: 12.71, 2: 4.30, 3: 3.18, 4: 2.78, 5: 2.57, 6: 2.45, 7: 2.36, 8: 2.31, 9: 2.26, 10: 2.23, 12: 2.18, 15: 2.13, 20: 2.09, 30: 2.04}


def t95(df):
    return T95.get(df) or next((T95[k] for k in sorted(T95) if k >= df), 1.96)


TEXT, MUTED = plt.rcParams["text.color"], plt.rcParams["xtick.color"]
path, row, col, model = sys.argv[1:5]
opts = dict(a[2:].split("=", 1) for a in sys.argv[5:] if a.startswith("--") and "=" in a)
rows = [r for r in csv.DictReader(open(path, newline="", encoding="utf-8")) if (r["row"], r["col"], r["model"]) == (row, col, model)]
if not rows:
    raise SystemExit(f"no rows for {row} / {col} / {model} in {path}")
variants = list(dict.fromkeys(r["variant"] for r in rows))[:2]
val = {(r["unit"], r["variant"]): float(r["value"]) for r in rows}
gains = sorted(((u, val[(u, variants[1])] - val[(u, variants[0])]) for u in dict.fromkeys(r["unit"] for r in rows)
                if (u, variants[0]) in val and (u, variants[1]) in val), key=lambda g: g[1])
d = [g for _, g in gains]
n = len(d)
mean = sum(d) / n
half = t95(n - 1) * math.sqrt(sum((x - mean) ** 2 for x in d) / (n - 1)) / math.sqrt(n) if n > 1 else 0

fig, ax = plt.subplots(figsize=(9, 0.32 * n + 1.6))
ys = range(n)
ax.axvline(0, color=TEXT, lw=1, zorder=1)
ax.scatter(d, ys, s=46, c=["C0" if x > 0 else "C1" for x in d], zorder=3, edgecolors="none")
yb = n + 0.4
ax.plot([mean - half, mean + half], [yb, yb], color=TEXT, lw=5, solid_capstyle="round", zorder=3)
ax.plot([mean], [yb], marker="o", ms=10, color=TEXT, zorder=4)
unit = opts.get("unit", "")
ax.set_yticks(list(ys), [f"{unit} {u}".strip() for u, _ in gains] if n <= 20 else [""] * n)
ax.set_ylim(-0.7, yb + 0.9)
if "range" in opts:
    lo, hi = map(float, opts["range"].split(":"))
else:  # 0 always shown; room on the right for the label
    lo, hi = min(d + [0, mean - half]), max(d + [0, mean + half])
    lo, hi = lo - (hi - lo) * 0.06, hi + (hi - lo) * 0.5
ax.set_xlim(lo, hi)
# The label sits beside the bar, on the side with room, never across the 0 line.
x0, x1 = ax.get_xlim()
right = x1 - (mean + half) > (mean - half) - x0
ax.annotate(f"平均 {mean:+.1f}　95% 區間 {mean - half:+.1f} ～ {mean + half:+.1f}", xy=(mean + half if right else mean - half, yb),
            xytext=(10 if right else -10, 0), textcoords="offset points", ha="left" if right else "right", va="center",
            fontsize=12, fontweight="bold")
ax.set_xlabel(f"{variants[1]} − {variants[0]}（右 = 變好）")
ax.grid(axis="y", visible=False)
ax.spines["left"].set_visible(False)
ax.tick_params(axis="y", length=0)
fig.tight_layout()
