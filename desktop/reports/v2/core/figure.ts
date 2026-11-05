// Runs a matplotlib script for a `figure` block and returns the image to embed. Synchronous, like
// the rest of the report command: the app runs it and exits.
//
// The script runs as `python3 -I -c BOOTSTRAP script.py args…` (BOTLING_PYTHON picks another
// interpreter): isolated from the environment, the working directory and the script's folder on
// sys.path; the user's site-packages is added back explicitly so a `pip install --user matplotlib`
// works. The bootstrap selects the Agg backend, applies the Botling theme (CJK fonts, transparent
// background, text/grid/series colours), runs the script as __main__ with cwd = the spec's folder,
// and saves the current figure to $BOTLING_FIGURE_OUT unless the script saved it there itself.
//
// SVG (default) runs once with sentinel colours that are rewritten to the page's CSS variables, so
// one inline SVG follows the light and dark themes. PNG cannot be recoloured: it runs twice, once
// per theme, and the stylesheet shows the matching copy.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export type FigureFormat = 'svg' | 'png';
export type FigureInput = { script: string; args?: string[]; format?: FigureFormat; timeout?: number };
/** `width`: the widest the figure is shown, in CSS px (its drawn size × 1.25), so a small figure is not blown up to the column. */
export type FigureOutput = { svg?: string; png?: { light: string; dark: string }; width?: number };

/** Theme colours, mirrored from theme/tokens.css (light, dark). Index = matplotlib C0…C5. */
const PALETTE = {
  light: { text: '#1C1C1F', muted: '#5F5F68', line: '#DADADF', c: ['#2F6FE0', '#B26A00', '#1E8A55', '#7A4FD6', '#D0342C', '#8A8A93'] },
  dark: { text: '#EDEDF0', muted: '#A0A0A8', line: '#2E2E35', c: ['#4C8DFF', '#C97A1E', '#4CC38A', '#B18CFF', '#FF8A80', '#6C6C75'] },
};
/** SVG runs draw with these unlikely colours; each becomes a CSS variable afterwards. */
const SENTINEL: Record<string, string> = {
  '#0b0b01': 'var(--text)', '#0b0b02': 'var(--muted)', '#0b0b03': 'var(--border)',
  '#0b0b11': 'var(--blue)', '#0b0b12': 'var(--orange)', '#0b0b13': 'var(--green)', '#0b0b14': 'var(--purple)', '#0b0b15': 'var(--error)', '#0b0b16': 'var(--unv)',
};
const SENTINEL_PALETTE = { text: '#0b0b01', muted: '#0b0b02', line: '#0b0b03', c: ['#0b0b11', '#0b0b12', '#0b0b13', '#0b0b14', '#0b0b15', '#0b0b16'] };

export const BOOTSTRAP = String.raw`
import os, sys, json, runpy, site
try:
    site.addsitedir(site.getusersitepackages())
except Exception:
    pass
out, fmt = os.environ["BOTLING_FIGURE_OUT"], os.environ["BOTLING_FIGURE_FORMAT"]
pal = json.loads(os.environ["BOTLING_FIGURE_PALETTE"])
try:
    import matplotlib
except ImportError:
    sys.stderr.write("matplotlib is not installed for " + sys.executable + " (pip3 install --user matplotlib, or set BOTLING_PYTHON)\n"); sys.exit(3)
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from cycler import cycler
plt.rcParams.update({
    "font.family": "sans-serif",
    "font.sans-serif": ["PingFang TC", "PingFang HK", "Heiti TC", "Hiragino Sans CNS", "Noto Sans CJK TC", "Microsoft JhengHei", "Arial Unicode MS", "DejaVu Sans"],
    "axes.unicode_minus": False, "svg.fonttype": "none", "svg.hashsalt": os.environ.get("BOTLING_FIGURE_SALT", "botling"),
    "figure.facecolor": "none", "axes.facecolor": "none", "savefig.facecolor": "none", "savefig.transparent": True,
    "text.color": pal["text"], "axes.labelcolor": pal["text"], "axes.titlecolor": pal["text"], "xtick.color": pal["muted"], "ytick.color": pal["muted"],
    "xtick.labelcolor": pal["text"], "ytick.labelcolor": pal["text"], "axes.edgecolor": pal["line"], "grid.color": pal["line"], "legend.labelcolor": pal["text"],
    "legend.frameon": False, "axes.axisbelow": True, "axes.spines.top": False, "axes.spines.right": False, "axes.grid": True, "grid.linewidth": 0.6,
    "axes.prop_cycle": cycler(color=pal["c"]), "patch.edgecolor": "none", "lines.linewidth": 1.6, "font.size": 12, "axes.titlesize": 12.5, "axes.titleweight": "bold", "axes.labelsize": 12, "xtick.labelsize": 11.5, "ytick.labelsize": 11.5, "legend.fontsize": 11.5,
})
script = sys.argv[1]
sys.argv = sys.argv[1:]
try:
    runpy.run_path(script, run_name="__main__")
except SystemExit as e:
    if e.code not in (None, 0):
        raise
if not (os.path.exists(out) and os.path.getsize(out) > 0):
    fig = plt.gcf()
    if not fig.axes:
        sys.stderr.write("the script drew no figure: draw with matplotlib (the current figure is saved) or save to $BOTLING_FIGURE_OUT\n"); sys.exit(4)
    fig.savefig(out, format=fmt, bbox_inches="tight", dpi=200 if fmt == "png" else 100, metadata={"Date": None} if fmt == "svg" else None)
`;

/** The python that runs figure scripts. */
export const python = () => process.env.BOTLING_PYTHON || 'python3';

function runOnce(file: string, input: FigureInput, cwd: string, palette: object, format: FigureFormat, salt: string): Buffer {
  const temp = mkdtempSync(join(tmpdir(), 'botling-figure-'));
  try {
    const out = join(temp, `figure.${format}`);
    const r = spawnSync(python(), ['-I', '-c', BOOTSTRAP, file, ...(input.args ?? [])], {
      cwd, timeout: (input.timeout ?? 60) * 1000, maxBuffer: 16 << 20, encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', LANG: 'en_US.UTF-8', MPLBACKEND: 'Agg', MPLCONFIGDIR: join(tmpdir(), 'botling-matplotlib'),
        BOTLING_FIGURE_OUT: out, BOTLING_FIGURE_FORMAT: format, BOTLING_FIGURE_PALETTE: JSON.stringify(palette), BOTLING_FIGURE_SALT: salt },
    });
    const tail = (r.stderr || '').trim().split('\n').slice(-6).join(' | ').slice(-600);
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') throw Error(`figure script timed out after ${input.timeout ?? 60} s: ${input.script}`);
    if (r.error) throw Error(`could not run ${python()}: ${r.error.message}`);
    if (r.status !== 0) throw Error(`figure script failed (exit ${r.status ?? r.signal}): ${tail || 'no error output'}`);
    if (!existsSync(out) || statSync(out).size === 0) throw Error('figure script wrote no image');
    return readFileSync(out);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

/** Make the SVG safe to inline and theme-aware: no scripts or handlers, sentinel colours → CSS variables. */
export function cleanSvg(raw: string): string {
  const at = raw.indexOf('<svg');
  if (at < 0) throw Error('figure output is not an SVG');
  let svg = raw.slice(at);
  if (/<script|<foreignObject|\son[a-z]+\s*=|javascript:/i.test(svg)) throw Error('figure SVG contains scripts or event handlers');
  svg = svg.replace(/#0b0b(0[1-3]|1[1-6])\b/gi, m => SENTINEL[m.toLowerCase()]);
  // Size comes from the viewBox; the page decides the width.
  return svg.replace(/^<svg([^>]*?)\swidth="[^"]*"/, '<svg$1').replace(/^<svg([^>]*?)\sheight="[^"]*"/, '<svg$1');
}

export function runFigure(input: FigureInput, baseDir: string, salt: string): FigureOutput {
  const file = isAbsolute(input.script) ? input.script : resolve(baseDir, input.script);
  if (!/\.py$/i.test(file)) throw Error(`script must be a .py file: ${input.script}`);
  if (!existsSync(file)) throw Error(`figure script not found: ${file}`);
  const format = input.format ?? 'svg';
  if (format === 'svg') {
    const raw = runOnce(file, input, baseDir, SENTINEL_PALETTE, 'svg', salt).toString('utf8');
    const pt = /<svg[^>]*\swidth="([\d.]+)pt"/.exec(raw);
    return { svg: cleanSvg(raw), ...(pt ? { width: Math.round(+pt[1] * 4 / 3 * 1.25) } : {}) };
  }
  const png = (theme: 'light' | 'dark') => `data:image/png;base64,${runOnce(file, input, baseDir, PALETTE[theme], 'png', salt).toString('base64')}`;
  return { png: { light: png('light'), dark: png('dark') } };
}
