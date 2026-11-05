"""One comparison, every unit: baseline (hollow) -> method (filled) per unit, as dots joined by a short
vertical segment (green = better, red = worse). For an experiment card's `figure`.
Usage: paired.py long.csv ROW COL MODEL [CHANCE]
long.csv has the columns row, col, unit, model, variant, value (the per_subject.py format); the first
variant in the file is the baseline, the second the method. Units are categories on the x axis.
"""
import csv
import sys

import matplotlib.pyplot as plt

path, row, col, model = sys.argv[1:5]
chance = float(sys.argv[5]) if len(sys.argv) > 5 else None
rows = [r for r in csv.DictReader(open(path, newline="", encoding="utf-8")) if r["row"] == row and r["col"] == col and r["model"] == model]
if not rows:
    raise SystemExit(f"no rows for {row} / {col} / {model} in {path}")
variants = list(dict.fromkeys(r["variant"] for r in rows))[:2]
units = list(dict.fromkeys(r["unit"] for r in rows))
val = {(r["unit"], r["variant"]): float(r["value"]) for r in rows}
pairs = [(u, val[(u, variants[0])], val[(u, variants[1])]) for u in units if (u, variants[0]) in val and (u, variants[1]) in val]

fig, ax = plt.subplots(figsize=(max(6.4, 0.32 * len(pairs) + 2), 2.8))
xs = range(len(pairs))
for x, (_, a, b) in zip(xs, pairs):
    ax.plot([x, x], [a, b], color="C2" if b >= a else "C4", lw=1.6, zorder=2)
small = len(pairs) > 20
ax.scatter(xs, [a for _, a, _ in pairs], s=14 if small else 30, facecolors="none", edgecolors="C0", linewidths=1.1, zorder=3, label=variants[0])
ax.scatter(xs, [b for _, _, b in pairs], s=14 if small else 30, color="C0", zorder=3, label=variants[1])
if chance is not None:
    ax.axhline(chance, color="C5", ls="--", lw=1)
ma = sum(a for _, a, _ in pairs) / len(pairs)
mb = sum(b for _, _, b in pairs) / len(pairs)
up = sum(b > a for _, a, b in pairs)
ax.set_title(f"平均 {ma:.1f} → {mb:.1f}（{mb - ma:+.1f}），{up}/{len(pairs)} 變好", loc="left", fontsize=10)
step = 1 if len(pairs) <= 20 else 6
ax.set_xticks(list(xs)[::step], [u for u, _, _ in pairs][::step])
ax.grid(axis="x", visible=False)
ax.legend(loc="lower right", bbox_to_anchor=(1, 1.0), ncol=2, fontsize=8.5)
