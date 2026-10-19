"""flowdiag: clean flowcharts -> vector PDF/PNG (rounded boxes, straight/orthogonal arrows)."""
import glob, os, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager as fm
from matplotlib.patches import FancyBboxPatch
from matplotlib.lines import Line2D

# Semantic palette: (fill, stroke). Only use a color when it carries meaning.
PALETTE = {
    "neutral": ("#ffffff", "#1e1e1e"),
    "blue":    ("#a5d8ff", "#4a9eed"),
    "orange":  ("#ffd8a8", "#f59e0b"),
    "red":     ("#ffc9c9", "#ef4444"),
    "gray":    ("#e9ecef", "#868e96"),
    "purple":  ("#d0bfff", "#8b5cf6"),
    "green":   ("#b2f2bb", "#22c55e"),
}

def _font():
    # Labels are English; prefer Arial (ships with macOS), fall back to DejaVu Sans elsewhere.
    cands = ["/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf"]
    for path in cands:
        if os.path.exists(path):
            fm.fontManager.addfont(path)
            bold = path.replace("Arial.ttf", "Arial Bold.ttf")
            if os.path.exists(bold): fm.fontManager.addfont(bold)
            return fm.FontProperties(fname=path).get_name()
    return "DejaVu Sans"

class Diagram:
    def __init__(self):
        self.nodes, self.edges, self.texts, self.legend = {}, [], [], []

    def node(self, id, x, y, w, h, text, color="neutral", fontsize=18):
        self.nodes[id] = dict(x=x, y=y, w=w, h=h, text=text, color=color, fs=fontsize)

    def text(self, x, y, s, fontsize=18, color="#1e1e1e", bold=False, ha="left"):
        self.texts.append(dict(x=x, y=y, s=s, fs=fontsize, c=color, bold=bold, ha=ha))

    def port(self, id, side, t=0.5):
        n = self.nodes[id]
        return {"left": (n["x"], n["y"] + t * n["h"]), "right": (n["x"] + n["w"], n["y"] + t * n["h"]),
                "top": (n["x"] + t * n["w"], n["y"]), "bottom": (n["x"] + t * n["w"], n["y"] + n["h"])}[side]

    def edge(self, src, dst, route="auto", via=None, label=None, color="#1e1e1e", dashed=False):
        """src/dst: (node_id, side[, t]) or (x, y). route: 'auto' | 'hv' | 'vh' | 'vhv' | 'hvh' | 'straight'."""
        p0 = self.port(*src) if isinstance(src[0], str) else src
        p1 = self.port(*dst) if isinstance(dst[0], str) else dst
        if via: pts = [p0, *via, p1]
        else:
            (x0, y0), (x1, y1) = p0, p1
            if route == "auto":
                route = "straight" if (x0 == x1 or y0 == y1) else ("vhv" if src[1:2] in [("top",), ("bottom",)] else "hvh")
            if route == "straight": pts = [p0, p1]
            elif route == "hv": pts = [p0, (x1, y0), p1]
            elif route == "vh": pts = [p0, (x0, y1), p1]
            elif route == "vhv": m = (y0 + y1) / 2; pts = [p0, (x0, m), (x1, m), p1]
            elif route == "hvh": m = (x0 + x1) / 2; pts = [p0, (m, y0), (m, y1), p1]
        for a, b in zip(pts, pts[1:]):
            assert a[0] == b[0] or a[1] == b[1], f"diagonal segment {a}->{b}: use route/via"
        self.edges.append(dict(pts=pts, label=label, c=color, dashed=dashed))

    def legend_item(self, color, label):
        self.legend.append((color, label))

    def render(self, out, margin=20, scale=0.72):
        plt.rcParams.update({"font.family": _font(), "mathtext.fontset": "cm"})
        xs = [n["x"] for n in self.nodes.values()] + [n["x"] + n["w"] for n in self.nodes.values()]
        ys = [n["y"] for n in self.nodes.values()] + [n["y"] + n["h"] for n in self.nodes.values()]
        for e in self.edges: xs += [p[0] for p in e["pts"]]; ys += [p[1] for p in e["pts"]]
        for t in self.texts: xs.append(t["x"]); ys.append(t["y"])
        ly = max(ys) + 50
        if self.legend: ys.append(ly + 30)
        x0, x1, y0, y1 = min(xs) - margin, max(xs) + margin, min(ys) - margin, max(ys) + margin
        if self.texts: x1 = max(x1, max(t["x"] + len(t["s"]) * t["fs"] * 0.5 for t in self.texts if t["ha"] == "left") + margin
                               if any(t["ha"] == "left" for t in self.texts) else x1)
        if self.legend: x1 = max(x1, min(xs) + sum(80 + len(l) * 9.5 for _, l in self.legend))
        W, H = x1 - x0, y1 - y0
        fig = plt.figure(figsize=(W / 100, H / 100), dpi=200)
        ax = fig.add_axes([0, 0, 1, 1]); ax.set_xlim(x0, x1); ax.set_ylim(y1, y0); ax.axis("off")
        pt = lambda px: px * scale
        for n in self.nodes.values():
            f, s = PALETTE[n["color"]]
            ax.add_patch(FancyBboxPatch((n["x"], n["y"]), n["w"], n["h"], boxstyle="round,pad=0,rounding_size=10",
                                        fc=f, ec=s, lw=1.6, zorder=2))
            ax.text(n["x"] + n["w"] / 2, n["y"] + n["h"] / 2, n["text"], ha="center", va="center",
                    fontsize=pt(n["fs"]), color="#1e1e1e", zorder=3, linespacing=1.3)
        for e in self.edges:
            P, ls = e["pts"], ((0, (5, 3)) if e["dashed"] else "-")
            if len(P) > 2:
                ax.add_line(Line2D(*zip(*P[:-1]), color=e["c"], lw=1.5, ls=ls, zorder=4))
            ax.annotate("", xy=P[-1], xytext=P[-2], zorder=4, arrowprops=dict(
                arrowstyle="-|>,head_length=0.55,head_width=0.3", color=e["c"], lw=1.5, ls=ls, shrinkA=0, shrinkB=0))
            if e["label"]:
                seg = max(zip(P, P[1:]), key=lambda s: abs(s[0][0] - s[1][0]) + abs(s[0][1] - s[1][1]))
                ax.text((seg[0][0] + seg[1][0]) / 2, (seg[0][1] + seg[1][1]) / 2, e["label"], ha="center", va="center",
                        fontsize=pt(15), color=e["c"], zorder=5, bbox=dict(fc="white", ec="none", pad=1.5))
        for t in self.texts:
            ax.text(t["x"], t["y"], t["s"], ha=t["ha"], va="center", fontsize=pt(t["fs"]), color=t["c"],
                    fontweight="bold" if t["bold"] else "normal", zorder=3)
        lx = min(xs)
        for color, label in self.legend:
            f, s = PALETTE[color]
            ax.add_patch(FancyBboxPatch((lx, ly), 34, 24, boxstyle="round,pad=0,rounding_size=5", fc=f, ec=s, lw=1.4))
            ax.text(lx + 44, ly + 12, label, va="center", fontsize=pt(17))
            lx += 44 + len(label) * 9.5 + 36
        fig.savefig(out + ".pdf"); fig.savefig(out + ".png"); plt.close(fig)
        return out + ".pdf"
