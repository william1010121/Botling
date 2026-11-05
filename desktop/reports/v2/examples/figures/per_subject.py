"""Template: the complete results of an experiment, every unit before -> after, as small multiples.

usage: per_subject.py DATA.csv [--ylabel=TEXT] [--chance=ROWPREFIX:VALUE ...]
DATA.csv columns: row, col, unit, model, variant, value
  row, col  the compared condition (e.g. dataset x evaluation setting): one row of panels per condition that has data
  model     one panel per model in that row (shared y axis, so panels compare directly)
  unit      the individual (subject, sample, task...): one thin line per unit
  variant   exactly two values; the first met is the baseline (left), the second the method (right)
  value     the score
Inside a panel each unit is a line from baseline to method: blue = better with the method, orange = worse.
The thick line is the mean, its two ends labelled with the value. No legend: the key is one line of
coloured words at the top. Conditions without data are not drawn (say so in the caption, never as an
empty panel). --chance draws a labelled reference line in the rows whose name starts with ROWPREFIX.
"""
import csv
import sys

import matplotlib.pyplot as plt

TEXT, MUTED = plt.rcParams["text.color"], plt.rcParams["xtick.color"]
path = sys.argv[1]
opts = [a for a in sys.argv[2:] if a.startswith("--")]
ylabel = next((a.split("=", 1)[1] for a in opts if a.startswith("--ylabel=")), "")
chance = [a.split("=", 1)[1].rsplit(":", 1) for a in opts if a.startswith("--chance=")]
rows = list(csv.DictReader(open(path, newline="", encoding="utf-8")))
groups = list(dict.fromkeys((r["row"], r["col"]) for r in rows))
models = list(dict.fromkeys(r["model"] for r in rows))
variants = list(dict.fromkeys(r["variant"] for r in rows))[:2]
val = {(r["row"], r["col"], r["model"], r["unit"], r["variant"]): float(r["value"]) for r in rows}
values = [float(r["value"]) for r in rows]
lo, hi = min(values), max(values)
pad = (hi - lo) * 0.08
levels = [float(v) for p, v in chance if any(r.startswith(p) for r, _ in groups)]
if levels and min(levels) - pad < lo:  # leave room under the lowest reference line for its label
    lo = min(levels) - pad * 1.2

fig, axes = plt.subplots(len(groups), len(models), figsize=(3.0 * len(models) + 0.6, 2.9 * len(groups) + 0.5),
                         sharey=True, squeeze=False)
for i, (row, col) in enumerate(groups):
    for j, model in enumerate(models):
        ax = axes[i][j]
        units = list(dict.fromkeys(u for (r, c, m, u, v) in val if (r, c, m) == (row, col, model)))
        pairs = [(val[(row, col, model, u, variants[0])], val[(row, col, model, u, variants[1])]) for u in units
                 if (row, col, model, u, variants[0]) in val and (row, col, model, u, variants[1]) in val]
        if not pairs:
            ax.axis("off")
            continue
        many = len(pairs) > 20
        for a, b in pairs:
            ax.plot([0, 1], [a, b], color="C0" if b > a else "C1", lw=0.9 if many else 1.3, alpha=0.35 if many else 0.6,
                    solid_capstyle="round", zorder=2)
        ma, mb = sum(a for a, _ in pairs) / len(pairs), sum(b for _, b in pairs) / len(pairs)
        ax.plot([0, 1], [ma, mb], color=TEXT, lw=3, marker="o", ms=6, zorder=4, solid_capstyle="round")
        ax.text(-0.07, ma, f"{ma:.1f}", ha="right", va="center", fontsize=12, fontweight="bold")
        ax.text(1.07, mb, f"{mb:.1f}", ha="left", va="center", fontsize=12, fontweight="bold")
        for prefix, level in chance:
            if row.startswith(prefix):
                ax.axhline(float(level), color=MUTED, lw=0.9, ls=(0, (4, 3)), zorder=1)
                if j == 0:
                    ax.text(-0.4, float(level), f"亂猜 {float(level):g}%", ha="left", va="top", fontsize=10.5, color=MUTED)
        up, down = sum(b > a for a, b in pairs), sum(b < a for a, b in pairs)
        ax.set_xlabel(f"{up} 變好 · {down} 變差", fontsize=11, color=MUTED, labelpad=4)
        ax.set_xlim(-0.42, 1.42)
        ax.set_xticks([0, 1], variants)
        ax.set_ylim(lo - pad, hi + pad)
        ax.grid(axis="x", visible=False)
        if i == 0:
            ax.set_title(model, fontsize=13)
        if j == 0:
            # Row heading: the condition, short (the part before a bracket); details belong in the caption.
            name = col if len({r for r, _ in groups}) == 1 else f"{row.split('（')[0].split('(')[0].strip()} · {col}"
            ax.set_ylabel(f"{name}\n{ylabel}" if ylabel else name, fontsize=12, fontweight="bold")
fig.tight_layout(h_pad=1.6, w_pad=1.2, rect=(0, 0, 1, 1 - 0.35 / fig.get_figheight()))
# The key: one line of coloured words above the panels, each placed right after the previous one.
# Text stays in ink; the coloured stroke in front of each word carries the identity.
prev = fig.text(0.01, 1 - 0.3 / fig.get_figheight(), "每條細線是一個個體：", ha="left", va="bottom", fontsize=12)
for glyph, colour, word in (("━━", "C0", "變好"), ("━━", "C1", "變差"), ("━━", TEXT, "平均（粗線）")):
    prev = axes[0][0].annotate(glyph, xy=(1, 0), xycoords=prev, xytext=(12, 0), textcoords="offset points",
                               ha="left", va="bottom", fontsize=12, color=colour, fontweight="bold")
    prev = axes[0][0].annotate(word, xy=(1, 0), xycoords=prev, xytext=(4, 0), textcoords="offset points",
                               ha="left", va="bottom", fontsize=12)
