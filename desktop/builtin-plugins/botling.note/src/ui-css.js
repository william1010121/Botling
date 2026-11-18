// botling.note, web part: the stylesheet and the page constants (moved out of ui.js, text unchanged).

const VIEW = "botling.note.tab";
const SAVE_MS = 700;
const POLL_MS = 3000;

// The app's mainTab frame is a bare page (data-theme only, no theme variables: var(--blue) etc. are undefined
// there), so every colour here is the note's own token with a concrete fallback: the app's value when a page
// does define it, else the app's light or dark value. Tokens sit on :root so the popups (outside .note) get them too.
const DARK_TOKENS = `--n-text: var(--text, #EDEDF0); --n-muted: var(--muted, #A0A0A8); --n-faint: var(--faint, #8E8E96);
  --n-line: var(--line, #2E2E35); --n-strong-line: var(--strong-line, #3A3A42); --n-border: var(--border, #3A3A42);
  --n-code: var(--code, #141417); --n-link: var(--link, #8DB5FF); --n-accent: var(--blue, #4C8DFF);
  --n-warn: var(--orange-text, #F7C27F); --n-warn-bg: var(--waiting-bg, #2A2116);
  --n-paper: var(--bubble, #1B1B1F); --n-pop: var(--popover, #26262C); --n-hover: var(--hover, #26262C); --n-selected: var(--selected, #2E2E35);
  --n-chip: var(--chip, #2A2A31); --n-accent-bg: var(--accent-bg, #1E2A44); --n-error: var(--error, #FF8A80);
  --n-cell-line: #34343C; --n-shadow: 0 14px 36px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.04);
  --n-c-text: #5B9BFF; --n-c-code: #4CC38A; --n-c-math: #F2A64A; --n-c-card: #E08A6A; --n-c-branch: #A88BF0; --n-c-image: #3FC1D0; --n-c-table: #E07BC4;
  --n-t-head: #24242A; --n-t-zebra: #1F1F24; --n-msel: rgba(76,141,255,.26);
  --n-board: #0E0E10; --n-board-dot: #26262C; --n-board-conn: #3A3A42; --n-board-fork: #6F5CA8; --n-board-branch: #1F1D26; --n-board-hover: #3E5C99; --n-board-ring: rgba(91,155,255,.18); --n-board-accent-line: #2F4F8F;`;
const CSS = `
:root { --n-text: var(--text, #1C1C1F); --n-muted: var(--muted, #5F5F68); --n-faint: var(--faint, #7A7A83);
  --n-line: var(--line, #E3E3E8); --n-strong-line: var(--strong-line, #CFCFD6); --n-border: var(--border, #DADADF);
  --n-code: var(--code, #F4F4F7); --n-link: var(--link, #2F6FE0); --n-accent: var(--blue, #2F6FE0);
  --n-warn: var(--orange-text, #9A5B00); --n-warn-bg: var(--waiting-bg, #FFF4E2);
  --n-paper: var(--bubble, #FFFFFF); --n-pop: var(--popover, #FFFFFF); --n-hover: var(--hover, #EAEAEE); --n-selected: var(--selected, #E2E2E8);
  --n-chip: var(--chip, #EEEEF2); --n-accent-bg: var(--accent-bg, #EAF1FF); --n-error: var(--error, #D0342C);
  --n-cell-line: #E2E2E8; --n-shadow: 0 14px 36px rgba(0,0,0,.16), 0 0 0 1px rgba(0,0,0,.05);
  --n-c-text: #2F6FE0; --n-c-code: #1E8A55; --n-c-math: #B26A00; --n-c-card: #C2603F; --n-c-branch: #7C5CD6; --n-c-image: #0E7C8A; --n-c-table: #A23E86;
  --n-t-head: #F3F3F6; --n-t-zebra: #FAFAFC; --n-msel: rgba(47,111,224,.17);
  --n-board: #F5F5F7; --n-board-dot: #D6D6DC; --n-board-conn: #C4C4CC; --n-board-fork: #B3A2E6; --n-board-branch: #F4F0FD; --n-board-hover: #9DB8EE; --n-board-ring: rgba(47,111,224,.14); --n-board-accent-line: #B9CEF5; }
:root[data-theme="dark"] { ${DARK_TOKENS} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${DARK_TOKENS} } }
.note { position: relative; box-sizing: border-box; height: 100vh; display: flex; flex-direction: column; color: var(--n-text);
  background: var(--n-paper); font: 14px/1.65 -apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang TC", sans-serif; }
.note * { box-sizing: border-box; }
.note-status { flex: none; display: flex; gap: 8px; align-items: center; justify-content: flex-end; min-height: 26px;
  padding: 2px 16px; color: var(--n-muted); font-size: 12px; }
.note-status button { font: inherit; color: var(--n-link); background: none; border: 0; cursor: pointer; padding: 0 4px; }
.note-warn { flex: none; margin: 0 16px 6px; padding: 6px 10px; border-radius: 8px; color: var(--n-warn); background: var(--n-warn-bg); font-size: 12.5px; }
.note-warn button { font: inherit; color: inherit; text-decoration: underline; background: none; border: 0; cursor: pointer; margin-left: 8px; }
.note-body { flex: 1; overflow: auto; padding: 14px 12px 40vh 58px; cursor: text; }
.note-page { position: relative; isolation: isolate; max-width: none; margin: 0; padding-left: 0; }
.note-doc { min-width: 0; }
.nl { min-height: 1.65em; padding: 0 2px; white-space: pre-wrap; overflow-wrap: anywhere; border-radius: 4px; }
.nl.nl-empty { min-height: .7em; line-height: .7; }
.nl.nl-active { padding: 0; }
.nl textarea { display: block; width: 100%; margin: 0; padding: 0 2px; border: 0; outline: 0; resize: none; overflow: hidden;
  background: var(--n-hover); color: inherit; font: 13px/1.65 ui-monospace, SFMono-Regular, Menlo, monospace; border-radius: 4px; white-space: pre-wrap; }
.nl-h1, .nl-h2, .nl-h3, .nl-h4, .nl-h5, .nl-h6 { font-weight: 650; line-height: 1.4; letter-spacing: -.005em; }
.nl-h1 { font-size: 1.35em; margin: .9em 0 .25em; }
.nl-h2 { font-size: 1.2em; margin: .8em 0 .2em; }
.nl-h3 { font-size: 1.08em; margin: .7em 0 .15em; }
.nl-h4, .nl-h5, .nl-h6 { font-size: 1em; margin: .6em 0 .1em; }
.nl-h5, .nl-h6 { color: var(--n-muted); }
.nl-doc-first { margin-top: 0; }
.nl-quote { position: relative; color: var(--n-muted); }
/* "> " lines: one bar per level, drawn on every line edge to edge, so consecutive quote lines read as one blockquote
   (joinQuotes rounds a bar only where its level starts / ends). */
.nq-bar { position: absolute; top: 0; bottom: 0; width: 3px; background: color-mix(in srgb, var(--n-muted) 45%, transparent); pointer-events: none; }
.nq-bar.nq-top { top: 3px; border-top-left-radius: 2px; border-top-right-radius: 2px; }
.nq-bar.nq-bot { bottom: 3px; border-bottom-left-radius: 2px; border-bottom-right-radius: 2px; }
.nl-li { display: flex; gap: 6px; line-height: 1.6; }
.nl-li > .mark { flex: none; min-width: 1.4em; text-align: right; color: var(--n-muted); font-variant-numeric: tabular-nums; }
.nl-li > .txt { white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
.nl-hr { height: 0; margin: .9em 0; border-bottom: 1px solid var(--n-line); min-height: 0; }
.nl-code { font: 12.5px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--n-code);
  padding: 0 14px; white-space: pre-wrap; border-left: 1px solid var(--n-line); border-right: 1px solid var(--n-line); border-radius: 0; }
.nl-fence { color: var(--n-faint); font: 11.5px/1.5 ui-monospace, monospace; background: var(--n-code); padding: 0 14px;
  min-height: 10px; border: 1px solid var(--n-line); border-bottom: 0; border-radius: 8px 8px 0 0; margin-top: .4em; }
.nl-fence.nl-fence-end { border: 1px solid var(--n-line); border-top: 0; border-radius: 0 0 8px 8px; margin: 0 0 .4em; min-height: 10px; }
.nl-fence.nl-fence-lang { padding-top: 6px; }
.nl-fence-hidden { display: none; }
.nl-raw { font: 13px/1.65 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--n-muted); }
.nl-done .txt { color: var(--n-muted); text-decoration: line-through; }
.note input.cb { margin: 2px 0 0; cursor: pointer; accent-color: var(--n-accent); }
.note code { font: .88em ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--n-code); border: 1px solid var(--n-line);
  padding: .08em .38em; border-radius: 5px; }
.note a { color: var(--n-link, var(--n-accent)); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; border-bottom: 0; }
.note a.n-bot { text-decoration: none; padding: 0 .35em; border-radius: 999px; background: color-mix(in srgb, var(--n-link, var(--n-accent)) 16%, transparent); font-weight: 500; white-space: nowrap; }
.note a.n-bot:hover { background: color-mix(in srgb, var(--n-link, var(--n-accent)) 28%, transparent); text-decoration: none; }
.note a:hover { text-decoration-thickness: 2px; filter: brightness(1.15); }
.note del { color: var(--n-muted); }
.note strong { font-weight: 650; }
.n-img { display: inline-block; max-width: 100%; vertical-align: top; margin: .25em 0; }
.n-img img { display: block; max-width: 100%; max-height: 520px; border-radius: 8px; border: 1px solid var(--n-line); }
.n-img-ph { padding: 8px 12px; border: 1px dashed var(--n-border); border-radius: 8px; color: var(--n-muted); font-size: 12.5px; background: var(--n-code); }
.n-math-block { display: block; text-align: center; margin: .7em 0; padding: .25em 4px; overflow-x: auto; overflow-y: hidden; white-space: normal; }
.n-math-block .katex-display { margin: 0; overflow: visible; }
.n-math-block .katex-display > .katex { white-space: nowrap; }
.n-math-err { color: var(--n-muted); font: .88em ui-monospace, SFMono-Regular, Menlo, monospace; opacity: .85; border-bottom: 1px dotted var(--n-faint); }
.n-math-block.n-math-err { white-space: pre-wrap; text-align: left; border: 0; padding: 6px 10px; background: var(--n-code); border-radius: 8px; }
.note .katex { font-size: 1.1em; color: var(--n-text); text-indent: 0; overflow-wrap: normal; word-break: normal; line-height: 1.3; }
.note .n-math-block .katex { font-size: 1.2em; }
.note .katex .mord, .note .katex .mbin, .note .katex .mrel { color: inherit; }
.nl-math { padding: 0 2px; }

/* A cell is a whole chunk of Markdown. Inside it every blank line (spaces only too) takes a whole line, as typed, so Enter
   always shows a new line; only the one blank line right next to the cell's top / bottom boundary takes no room.
   Cells are 8px apart: that gap is where the \`<!-- cell -->\` line is. */
.note-doc > .nl.nl-empty { display: none; }
.cell .nl.nl-empty { min-height: 1.65em; line-height: 1.65; }
.cell .nl.nl-edge { display: none; }
.cell .nl.nl-empty.nl-only { height: 1.65em; }
/* Every cell: a light frame and a type-coloured left bar, always visible; hover stronger; the active cell strongest. */
.cell { --cc: var(--n-c-text); position: relative; margin: 8px 0; padding: 6px 12px 6px 14px; min-height: 2.2em; border: 1px solid var(--n-cell-line);
  border-left: 3px solid color-mix(in srgb, var(--cc) 65%, var(--n-paper)); border-radius: 6px; background: var(--n-paper); }
.cell-markdown { --cc: var(--n-c-text); }
.cell-code { --cc: var(--n-c-code); background: var(--n-code); }
.cell-math { --cc: var(--n-c-math); }
.cell-card { --cc: var(--n-c-card); }
.cell-table { --cc: var(--n-c-table); }
.cell-branch { --cc: var(--n-c-branch); min-height: 0; padding: 0 10px 0 12px; background: color-mix(in srgb, var(--cc) 5%, var(--n-paper)); }
.cell:hover, .cell.nc-hover { border-color: var(--n-strong-line); border-left-color: color-mix(in srgb, var(--cc) 85%, var(--n-paper)); }
.cell.cell-active { border-color: color-mix(in srgb, var(--cc) 45%, var(--n-paper)); border-left: 4px solid var(--cc); padding-left: 13px;
  background: color-mix(in srgb, var(--cc) 6%, var(--n-paper)); box-shadow: 0 0 0 2px color-mix(in srgb, var(--cc) 14%, transparent); }
.cell-code.cell-active { background: var(--n-code); }
.cell .nl-h1 { margin: .55em 0 .2em; }
.cell .nl-h2 { margin: .5em 0 .15em; }
.cell .nl-h3, .cell .nl-h4, .cell .nl-h5, .cell .nl-h6 { margin: .4em 0 .1em; }
.cell .nl-first, .cell .nl-edge + .nl-first { margin-top: 0; }
.note .nl.nl-quote { margin-top: 0; margin-bottom: 0; border-radius: 0; }
.note .nl.nl-quote.nq-start:not(.nl-first) { margin-top: .15em; }
.note .nl.nl-quote.nq-end { margin-bottom: .15em; }
.cell-code .nl-fence, .cell-code .nl-fence.nl-fence-end { border: 0; border-radius: 0; margin: 0; padding: 0 4px; }
.cell-code .nl-code { border: 0; padding: 0 4px; }
.cell-branch .nb-fork { margin: 5px 0; padding-bottom: 0; border-bottom: 0; }
.cell .nl-active textarea { background: transparent; }
/* The cell's toolbar straddles its top border at the right (as in Jupyter); opaque, above the neighbouring cell. */
.cell-bar { position: absolute; top: -11px; right: 8px; height: 20px; display: none; align-items: center; gap: 1px; z-index: 6; padding: 0 2px;
  border-radius: 6px; background: var(--n-pop); box-shadow: 0 0 0 1px var(--n-strong-line), 0 2px 6px rgba(0,0,0,.08); }
.cell:hover > .cell-bar, .cell.nc-hover > .cell-bar, .cell.cell-active > .cell-bar, .cell-bar:focus-within { display: flex; }
.cell-bar button { height: 16px; min-width: 20px; padding: 0 5px; border: 0; border-radius: 4px; background: transparent; color: var(--n-muted);
  font: 600 11px/16px -apple-system, BlinkMacSystemFont, "PingFang TC", sans-serif; cursor: pointer; white-space: nowrap; }
.cell-bar button:hover { background: var(--n-selected); color: var(--n-text); }
.cell-bar button.cb-type { color: var(--cc); }
.cell-bar button.cb-del:hover { color: var(--n-error); }
.cell-bar .cb-sep { width: 1px; height: 10px; margin: 0 2px; background: var(--n-line); }
/* Multi-line selection: whole lines (a table / math block as one piece), drawn as a highlight; copied as Markdown. */
.note.msel-on .note-body { user-select: none; -webkit-user-select: none; }
.nl.nl-msel, .nt-box.nl-msel .nt th, .nt-box.nl-msel .nt td, .nl-msel .nt tbody tr:nth-child(even) td { background: var(--n-msel); }
.nl.nl-msel { box-shadow: -6px 0 0 var(--n-msel), 6px 0 0 var(--n-msel); }
.cell-branch.nl-msel, [data-fork-end].nl-msel { box-shadow: inset 0 0 0 999px var(--n-msel); }
.nsel-sink { position: fixed; left: 0; top: 0; width: 1px; height: 1px; opacity: 0; padding: 0; border: 0; resize: none; overflow: hidden; pointer-events: none; }
/* Tables (GFM pipe tables): drawn as real tables; a clicked cell is edited in place (its Markdown shown raw). */
.nl.nl-table { white-space: normal; padding: 0; }
.nt-box { position: relative; margin: .3em 0 .7em; }
.nt-scroll { overflow-x: auto; padding-bottom: 2px; }
.nt { border-collapse: collapse; min-width: 50%; font-size: 13.5px; line-height: 1.55; color: var(--n-text); }
.nt th, .nt td { border: 1px solid var(--n-strong-line); padding: 5px 11px; min-width: 4.5em; height: calc(1.55em + 10px); vertical-align: top; text-align: left;
  white-space: pre-wrap; overflow-wrap: anywhere; cursor: text; }
.nt th { background: var(--n-t-head); font-weight: 650; }
.nt tbody tr:nth-child(even) td { background: var(--n-t-zebra); }
.nt th[data-align=center], .nt td[data-align=center] { text-align: center; }
.nt th[data-align=right], .nt td[data-align=right] { text-align: right; }
.nt .nt-on, .nt tbody tr:nth-child(even) td.nt-on { background: var(--n-paper); box-shadow: inset 0 0 0 2px var(--n-accent); }
.nt .nt-ed { display: inline-block; min-width: 2em; width: 100%; outline: 0; font: 12.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; }
.nt-bar { position: absolute; left: 2px; top: calc(100% + 3px); height: 22px; display: none; align-items: center; gap: 1px; z-index: 5; padding: 0 3px;
  border-radius: 6px; background: var(--n-pop); box-shadow: 0 0 0 1px var(--n-strong-line), 0 2px 6px rgba(0,0,0,.08); }
.nt-box:hover > .nt-bar, .nt-box.nt-editing > .nt-bar { display: flex; }
.nt-bar button { height: 18px; padding: 0 7px; border: 0; border-radius: 4px; background: transparent; color: var(--n-muted); cursor: pointer;
  font: 600 11px/18px -apple-system, BlinkMacSystemFont, "PingFang TC", sans-serif; white-space: nowrap; }
.nt-bar button:hover { background: var(--n-selected); color: var(--n-text); }

/* Live cards (<show> blocks): a head (name, status, run / freeze / source) over a slot that keeps the card's room; the card's
   own page is a frame in .nc-layer laid over the slot (never moved, so it is never reloaded). */
.nl.nc-box { white-space: normal; padding: 0; margin: .25em 0 .5em; }
.nc-head { display: flex; align-items: center; gap: 6px; min-height: 24px; margin-bottom: 4px; font-size: 12px; color: var(--n-muted); cursor: default; user-select: none; -webkit-user-select: none; }
.nc-title { font-weight: 650; color: var(--n-c-card); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
.nc-status { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nc-status[data-state=failed] { color: var(--n-error); }
.nc-status[data-state=approve] { color: var(--n-warn); }
.nc-btn { height: 20px; padding: 0 7px; border: 0; border-radius: 5px; background: transparent; color: var(--n-muted); cursor: pointer;
  font: 600 11px/20px -apple-system, BlinkMacSystemFont, "PingFang TC", sans-serif; white-space: nowrap; opacity: 0; transition: opacity .12s; }
.nc-btn:disabled { cursor: default; color: var(--n-faint); }
.nc-btn:not(:disabled):hover { background: var(--n-selected); color: var(--n-text); }
.nc-btn[hidden] { display: none; }
.cell:hover .nc-btn, .cell.nc-hover .nc-btn, .nc-btn:focus-visible, .nc-btn.nc-allow { opacity: 1; }
.nc-btn.nc-allow { color: #fff; background: var(--n-accent); }
.nc-btn.nc-allow:hover { color: #fff; background: var(--n-accent); filter: brightness(1.08); }
.nc-slot { position: relative; border-radius: 10px; min-height: 24px; }
.nc-slot.nc-empty { height: auto !important; min-height: 64px; display: flex; align-items: center; justify-content: center; padding: 14px;
  border: 1px dashed var(--n-strong-line); color: var(--n-faint); font-size: 12.5px; text-align: center; }
.nc-slot.nc-empty::after { content: attr(data-msg); }
.nc-layer { position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 1; }
.nc-frame { position: absolute; display: none; border: 0; border-radius: 10px; background: transparent; color-scheme: normal; }
.note.nd-ghost .nc-slot { height: 44px !important; background: var(--n-chip); }
.note.nc-freezing .cell-bar, .note.nc-freezing .cell-grip, .note.nc-freezing .cell-ask, .note.nc-freezing .nc-head { visibility: hidden; }
/* Drag a cell by its grip in the left margin (as in Jupyter). While dragging: the cell dims, a copy follows the pointer,
   a line shows where it lands, and the route it lands in is outlined (its tab too). */
.cell-grip { position: absolute; left: -29px; top: 3px; width: 22px; height: 24px; display: flex; align-items: center; justify-content: center;
  border-radius: 5px; color: var(--n-faint); opacity: 0; cursor: grab; touch-action: none; transition: opacity .12s; }
.cell:hover > .cell-grip, .cell.nc-hover > .cell-grip, .cell.cell-active > .cell-grip, .cell-grip:focus-visible { opacity: 1; }
.cell-grip:hover { background: var(--n-hover); color: var(--n-text); }
/* 問 (a speech-bubble icon), right beside the grip: quote this cell into the bot's chat. Shown on hover, like the grip. */
.cell-ask { position: absolute; left: -52px; top: 3px; width: 22px; height: 24px; display: flex; align-items: center; justify-content: center;
  margin: 0; padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--n-faint); opacity: 0; cursor: pointer; transition: opacity .12s; }
.cell-ask svg { display: block; flex: none; }
.cell-branch > .cell-ask { top: 8px; }
.cell:hover > .cell-ask, .cell.nc-hover > .cell-ask, .cell.cell-active > .cell-ask, .cell-ask:focus-visible { opacity: 1; }
.cell-ask:hover { background: var(--n-hover); color: var(--n-muted); }
.note.nd-on .cell-ask { visibility: hidden; }
.note.nd-on, .note.nd-on * { cursor: grabbing !important; user-select: none; -webkit-user-select: none; }
.note.nd-on .cell-bar { display: none !important; }
.cell.cell-dragging { opacity: .35; }
.cell.cell-dragging > .cell-grip { opacity: 1; }
.nd-line { --nd-c: var(--n-accent); position: absolute; left: -12px; right: -4px; height: 3px; margin-top: -1.5px; border-radius: 2px;
  background: var(--nd-c); z-index: 8; pointer-events: none; }
.nd-line::before { content: ""; position: absolute; left: -5px; top: -4px; width: 11px; height: 11px; box-sizing: border-box; border-radius: 50%;
  background: var(--n-paper); border: 2.5px solid var(--nd-c); }
.nd-tag { position: absolute; right: 10px; bottom: 6px; padding: 0 9px; border-radius: 10px; background: var(--nd-c); color: #fff;
  font: 600 11.5px/20px -apple-system, BlinkMacSystemFont, "PingFang TC", sans-serif; white-space: nowrap; box-shadow: 0 2px 6px rgba(0,0,0,.15); }
.nd-zone { position: absolute; left: -16px; right: -8px; z-index: -1; pointer-events: none; border: 2px dashed var(--n-c-branch); border-radius: 12px;
  background: color-mix(in srgb, var(--n-c-branch) 9%, var(--n-paper)); }
.nd-line[hidden], .nd-zone[hidden] { display: none; }
.nb-tab.nb-tab-drop { color: var(--n-c-branch); background: color-mix(in srgb, var(--n-c-branch) 16%, var(--n-paper)); box-shadow: inset 0 0 0 2px var(--n-c-branch); font-weight: 600; }
.nb-empty.nd-into { color: var(--n-c-branch); }
.note.nd-ghost { position: fixed; z-index: 2147483001; height: auto; max-height: 160px; overflow: hidden; pointer-events: none; display: block;
  background: transparent; opacity: .93; transform: rotate(.7deg); border-radius: 7px; box-shadow: var(--n-shadow); }
.nd-ghost .cell { margin: 0; }
.nd-ghost .cell-bar, .nd-ghost .cell-grip, .nd-ghost .cell-ask { display: none; }
.cell.cell-dropped { animation: nd-drop 1.6s ease-out; }
@keyframes nd-drop { 0%, 30% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--cc) 40%, transparent); background: color-mix(in srgb, var(--cc) 12%, var(--n-paper)); } }

.note-status .nb-crumb { display: inline-flex; align-items: center; gap: 5px; max-width: 70%; height: 22px; padding: 0 8px; border: 1px solid var(--n-strong-line); border-radius: 6px;
  background: var(--n-paper); color: var(--n-muted); font: inherit; font-size: 12px; cursor: pointer; }
.note-status .nb-crumb:hover, .note-status .nb-crumb[aria-expanded=true] { background: var(--n-selected); color: var(--n-text); }
.nb-crumb span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nb-crumb[hidden] { display: none; }
/* The whiteboard toggle (right end of the status bar) and, while the board is open, its title on the left. */
.note-status .nb-board { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; border: 1px solid var(--n-strong-line); border-radius: 6px;
  background: var(--n-paper); color: var(--n-text); font-size: 12px; cursor: pointer; }
.note-status .nb-board:hover { background: var(--n-selected); }
.note-status .nb-board.on { border-color: var(--n-board-accent-line); background: var(--n-accent-bg); color: var(--n-accent); font-weight: 600; }
.nb-board kbd { display: none; margin-left: 2px; padding: 0 4px; border-radius: 4px; border: 1px solid var(--n-board-accent-line); font: 500 10.5px -apple-system, sans-serif; }
.nb-board.on kbd { display: inline; }
.nb-sep { width: 1px; height: 14px; background: var(--n-line); }
.nb-btitle { display: none; align-items: center; gap: 8px; margin-right: auto; }
.note.nw-on .nb-btitle { display: inline-flex; }
.note.nw-on .nb-crumb { display: none; }
.nb-btitle b { font-weight: 600; color: var(--n-text); }
.nb-btitle span { padding: 1px 8px; border-radius: 999px; background: var(--n-chip); color: var(--n-muted); font-size: 11.5px; }
.note.nw-on .note-body { display: none; }
.note.nw-on .note-status { border-bottom: 1px solid var(--n-line); }
.nb-st { margin-left: auto; }
.nb-fork { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 16px 0 6px; padding-bottom: 8px; border-bottom: 1px solid var(--n-line); }
.nb-fl { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; color: var(--n-muted); cursor: pointer; border: 0; background: none; font-family: inherit; padding: 0; }
.nb-fl:hover { color: var(--n-text); }
.nb-tabs { display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 2px; border: 1px solid var(--n-line); border-radius: 8px; background: var(--n-hover); }
.nb-tab { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent;
  color: var(--n-muted); font: inherit; font-size: 12.5px; cursor: pointer; }
.nb-tab:hover { color: var(--n-text); }
.nb-tab[aria-selected=true] { background: var(--n-selected); color: var(--n-text); font-weight: 600; }
.nb-cnt { font-size: 11px; color: var(--n-faint); }
.nb-add { width: 28px; height: 28px; border: 1px dashed var(--n-border); border-radius: 6px; background: transparent; color: var(--n-muted); font-size: 15px; cursor: pointer; }
.nb-add:hover { background: var(--n-hover); color: var(--n-text); }
.nb-input { height: 24px; min-width: 60px; border: 1px solid var(--n-accent); border-radius: 5px; background: var(--n-paper); color: var(--n-text);
  font: inherit; font-size: 12.5px; padding: 0 6px; outline: 0; }
.nb-empty { display: block; width: 100%; text-align: left; padding: 4px 2px; border: 0; background: none; color: var(--n-faint); font: inherit; font-size: 12.5px; cursor: text; }
.nb-end { display: block; position: static; float: none; width: auto; max-width: 100%; margin: 4px 0 10px; padding: 2px 0 2px 12px; border: 0; border-left: 3px dashed var(--n-line); background: none; color: var(--n-faint);
  font: inherit; font-size: 11.5px; text-align: left; white-space: normal; overflow-wrap: anywhere; cursor: pointer; }
.nb-end:hover { color: var(--n-text); }
/* Popups live outside .note (appended to the panel root), fixed to the frame's viewport, opaque, on top of everything. */
.nb-menu, .nb-map { position: fixed; z-index: 2147483000; isolation: isolate; box-sizing: border-box; overflow: auto; padding: 6px;
  border: 1px solid var(--n-strong-line); border-radius: 12px; background: var(--n-pop); background-color: var(--n-pop); background-clip: padding-box;
  box-shadow: var(--n-shadow); color: var(--n-text); font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang TC", sans-serif; text-align: left; }
.nb-menu *, .nb-map * { box-sizing: border-box; }
.nb-menu { min-width: 260px; max-width: 340px; max-height: 60vh; }
.nb-mi { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 34px; padding: 0 10px; border: 0; border-radius: 7px; background: transparent;
  color: var(--n-text); font: inherit; text-align: left; cursor: pointer; }
.nb-mi:hover, .nb-mi[aria-selected=true] { background: var(--n-selected); }
.nb-mi[disabled] { color: var(--n-faint); cursor: default; }
.nb-mi[disabled]:hover { background: transparent; }
.nb-mi.danger { color: var(--n-error); }
.nb-mi .ic { flex: none; width: 24px; height: 24px; border-radius: 6px; background: var(--n-chip); display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; color: var(--n-muted); }
.nb-mi .lb { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nb-mi .k { flex: none; font-size: 11.5px; color: var(--n-faint); }
.nb-mh { padding: 6px 10px 2px; font-size: 11.5px; font-weight: 600; color: var(--n-faint); }
.nb-sep { height: 1px; margin: 6px 4px; background: var(--n-line); }
.nb-map { width: min(440px, calc(100vw - 24px)); max-height: 70vh; }
.nb-node { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 34px; padding: 0 10px; border: 0; border-radius: 7px; background: transparent;
  color: var(--n-text); font: inherit; text-align: left; cursor: pointer; }
.nb-node:hover { background: var(--n-selected); }
.nb-node.on { background: var(--n-accent-bg); font-weight: 600; }
.nb-node .dot { flex: none; width: 7px; height: 7px; border-radius: 4px; border: 1px solid var(--n-faint); }
.nb-node.on .dot { background: var(--n-accent); border-color: var(--n-accent); }
.nb-node .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nb-node .meta { margin-left: auto; flex: none; padding-left: 8px; font-size: 11.5px; font-weight: 400; color: var(--n-faint); white-space: nowrap; }
.nb-node.on .meta { color: var(--n-accent); }
.nb-fk { display: flex; align-items: center; gap: 6px; min-height: 26px; padding: 0 10px; font-size: 11.5px; font-weight: 600; color: var(--n-faint); }
.nb-kids { margin-left: 14px; padding-left: 6px; border-left: 1px solid var(--n-line); }
.nb-maphint { padding: 8px 10px 4px; margin-top: 6px; border-top: 1px solid var(--n-line); font-size: 12px; color: var(--n-muted); }
`;

export { VIEW, SAVE_MS, POLL_MS, DARK_TOKENS, CSS };
