"""A metric over time with its target and the day of the change. Usage: line.py data.csv COLUMN TARGET CHANGE_X LABEL
data.csv: the first column is x (ordered labels such as dates), COLUMN the value."""
import csv
import sys

import matplotlib.pyplot as plt

path, col, target, change, label = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4], sys.argv[5]
rows = list(csv.DictReader(open(path, newline="", encoding="utf-8")))
xkey = list(rows[0].keys())[0]
xs, ys = [r[xkey] for r in rows], [float(r[col]) for r in rows]
fig, ax = plt.subplots(figsize=(7.2, 2.8))
ax.plot(xs, ys, color="C0", marker="o", ms=4)
ax.axhline(target, color="C2", ls="--", lw=1)
ax.text(len(xs) - 1, target, f"目標 {target:g}%", ha="right", va="bottom", fontsize=9, color="C2")
ax.axvline(xs.index(change), color="C5", lw=1)
ax.text(xs.index(change) + 0.08, max(ys), label, va="top", fontsize=9, color="C5")
ax.set_ylim(0, max(ys) * 1.15)
ax.set_ylabel("閒置 CPU（%）")
ax.grid(axis="x", visible=False)
