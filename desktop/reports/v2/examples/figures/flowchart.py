"""Clean flowchart for a report `figure` block (role: "flowchart"): rounded boxes, only horizontal and
vertical arrows, colour only where it means something. Usage: flowchart.py diagram.json

The diagram is data, not code: copy this script as is and write the JSON next to the spec.
  {
    "nodes":  [{"id": "raw", "x": 0, "y": 0, "w": 170, "h": 60, "text": "原始腦波\\n9 人", "color": "neutral"}],
    "edges":  [{"from": ["raw", "right"], "to": ["sess", "left"], "route": "auto", "label": "加", "dashed": false}],
    "texts":  [{"x": 0, "y": -30, "text": "1 前處理", "bold": true}],
    "legend": [{"color": "C0", "label": "只差這一步"}]
  }
Coordinates are pixels, y grows downward; put nodes of one row on the same y and of one column on
the same x, 40-60 px apart. Sides: left / right / top / bottom, with an optional third value 0..1
(position along the side). Routes: straight, hv, vh, vhv, hvh, auto (straight when aligned, else vhv
from top/bottom and hvh from left/right) or explicit corners in "via": [[x, y], ...]. A diagonal
segment is an error: fix the route. Colours: "neutral" (text colour, no fill) or C0..C5 (blue,
orange, green, purple, red, grey; they follow the page's light and dark theme). Give every colour
you use a legend entry. Box text uses the report's fonts (CJK included); \\n breaks a line.
"""
import json
import sys

import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import FancyBboxPatch

spec = json.load(open(sys.argv[1], encoding="utf-8"))
nodes = {n["id"]: n for n in spec["nodes"]}
TEXT = plt.rcParams["text.color"]
SCALE = 0.72  # px -> pt at figsize = px / 100 in


def text_width(s, size):
    """Rough drawn width in px: CJK characters are about one em wide, Latin about half."""
    return max(len(line) and sum(1.0 if ord(ch) > 0x2E80 else 0.56 for ch in line) for line in s.split("\n")) * size


def colour(key):
    return TEXT if key in (None, "neutral") else key


def port(ref):
    if not isinstance(ref[0], str):
        return tuple(ref)
    n = nodes[ref[0]]
    t = ref[2] if len(ref) > 2 else 0.5
    return {"left": (n["x"], n["y"] + t * n["h"]), "right": (n["x"] + n["w"], n["y"] + t * n["h"]),
            "top": (n["x"] + t * n["w"], n["y"]), "bottom": (n["x"] + t * n["w"], n["y"] + n["h"])}[ref[1]]


def route(e):
    p0, p1 = port(e["from"]), port(e["to"])
    if e.get("via"):
        pts = [p0, *[tuple(v) for v in e["via"]], p1]
    else:
        (x0, y0), (x1, y1) = p0, p1
        r = e.get("route", "auto")
        if r == "auto":
            vertical = isinstance(e["from"][0], str) and e["from"][1] in ("top", "bottom")
            r = "straight" if (x0 == x1 or y0 == y1) else ("vhv" if vertical else "hvh")
        pts = {"straight": lambda: [p0, p1], "hv": lambda: [p0, (x1, y0), p1], "vh": lambda: [p0, (x0, y1), p1],
               "vhv": lambda: [p0, (x0, (y0 + y1) / 2), (x1, (y0 + y1) / 2), p1],
               "hvh": lambda: [p0, ((x0 + x1) / 2, y0), ((x0 + x1) / 2, y1), p1]}[r]()
    for a, b in zip(pts, pts[1:]):
        if a[0] != b[0] and a[1] != b[1]:
            raise SystemExit(f"diagonal segment {a} -> {b} in edge {e['from']} -> {e['to']}: use route or via")
    return pts


edges = [(e, route(e)) for e in spec.get("edges", [])]
texts, legend = spec.get("texts", []), spec.get("legend", [])
xs = [v for n in nodes.values() for v in (n["x"], n["x"] + n["w"])] + [p[0] for _, P in edges for p in P]
ys = [v for n in nodes.values() for v in (n["y"], n["y"] + n["h"])] + [p[1] for _, P in edges for p in P]
for t in texts:
    w = text_width(t["text"], t.get("size", 16))
    xs += [t["x"] - (w if t.get("ha") == "right" else w / 2 if t.get("ha") == "center" else 0), t["x"] + (w if t.get("ha", "left") == "left" else w / 2 if t.get("ha") == "center" else 0)]
    ys.append(t["y"])
legend_y = max(ys) + 44
if legend:
    ys.append(legend_y + 26)
    xs.append(min(xs) + sum(40 + text_width(i["label"], 15) + 30 for i in legend))
m = 14
x0, x1, y0, y1 = min(xs) - m, max(xs) + m, min(ys) - m, max(ys) + m
fig = plt.figure(figsize=((x1 - x0) / 100, (y1 - y0) / 100))
ax = fig.add_axes([0, 0, 1, 1])
ax.set_xlim(x0, x1)
ax.set_ylim(y1, y0)
ax.axis("off")

for n in nodes.values():
    c = colour(n.get("color"))
    box = dict(boxstyle="round,pad=0,rounding_size=10")
    if c != TEXT:  # a light wash of the category colour behind the text
        ax.add_patch(FancyBboxPatch((n["x"], n["y"]), n["w"], n["h"], fc=c, ec="none", alpha=0.13, zorder=1, **box))
    ax.add_patch(FancyBboxPatch((n["x"], n["y"]), n["w"], n["h"], fc="none", ec=c, lw=1.5, zorder=2, **box))
    ax.text(n["x"] + n["w"] / 2, n["y"] + n["h"] / 2, n["text"], ha="center", va="center",
            fontsize=n.get("size", 17) * SCALE, zorder=3, linespacing=1.3, fontweight=n.get("weight", "normal"))

for e, P in edges:
    c, ls = colour(e.get("color")), ((0, (5, 3)) if e.get("dashed") else "-")
    if len(P) > 2:
        ax.add_line(Line2D(*zip(*P[:-1]), color=c, lw=1.4, ls=ls, zorder=4))
    ax.annotate("", xy=P[-1], xytext=P[-2], zorder=4, arrowprops=dict(
        arrowstyle="-|>,head_length=0.5,head_width=0.28", color=c, lw=1.4, ls=ls, shrinkA=0, shrinkB=0))
    if e.get("label"):
        a, b = max(zip(P, P[1:]), key=lambda s: abs(s[0][0] - s[1][0]) + abs(s[0][1] - s[1][1]))
        # beside the longest segment, never on it: above a horizontal one, right of a vertical one
        flat = a[1] == b[1]
        ax.text((a[0] + b[0]) / 2 + (0 if flat else 6), (a[1] + b[1]) / 2 - (5 if flat else 0), e["label"], ha="center" if flat else "left",
                va="bottom" if flat else "center", fontsize=13 * SCALE, color=c, zorder=5)

for t in texts:
    ax.text(t["x"], t["y"], t["text"], ha=t.get("ha", "left"), va="center", fontsize=t.get("size", 16) * SCALE,
            color=colour(t.get("color")), fontweight="bold" if t.get("bold") else "normal", zorder=3)

lx = min(xs)
for item in legend:
    c = colour(item["color"])
    ax.add_patch(FancyBboxPatch((lx, legend_y), 30, 20, boxstyle="round,pad=0,rounding_size=5", fc=c, ec="none", alpha=0.13))
    ax.add_patch(FancyBboxPatch((lx, legend_y), 30, 20, boxstyle="round,pad=0,rounding_size=5", fc="none", ec=c, lw=1.3))
    ax.text(lx + 40, legend_y + 10, item["label"], va="center", fontsize=15 * SCALE)
    lx += 40 + text_width(item["label"], 15) + 30
