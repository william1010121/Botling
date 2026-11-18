// botling.note, margin comments (旁註): the stylesheet. The same tokens as the rest of the note (--n-*), so light / dark follow the app.
// Layout: with a comment (or an ask box) the page gets `nm-on` and room on its right; the cards sit in `.nm-rail` (absolute, tops set
// by ui-margin.js so they line up with their passage and never overlap) and thin elbow lines in `.nm-links` join them to the text.
// A frame narrower than 760 px has no margin: the cards sit under the note and the ask box under the cell.
export const MARGIN_CSS = `
.note-page.nm-on { padding-right: 372px; }
.nm-links { position: absolute; left: 0; top: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; z-index: 1; }
.nm-links path { fill: none; stroke: var(--n-accent); stroke-width: 1; }
.nm-links path.nm-dim { stroke: var(--n-faint); stroke-dasharray: 3 3; }
.nm-links path.nm-draft { stroke-dasharray: 4 3; }
.nm-links circle { fill: var(--n-accent); }
.nm-rail { position: absolute; top: 0; right: 0; width: 340px; pointer-events: none; z-index: 2; }
.nm-rail.nm-narrow { position: static; width: auto; margin: 22px 0 0; display: flex; flex-direction: column; gap: 10px; }
.nm-rail-head { display: flex; align-items: baseline; gap: 8px; font-size: 12px; color: var(--n-muted); padding: 0 2px 6px; pointer-events: none; }
.nm-rail-head b { color: var(--n-text); font-weight: 600; font-size: 13px; }
.nm-rail-head .nm-n { background: var(--n-chip); border-radius: 999px; padding: 0 7px; font-size: 11px; }
.nm-rail-head small { margin-left: auto; color: var(--n-faint); font-size: 11px; }
.nm-card { position: absolute; left: 0; right: 0; pointer-events: auto; background: var(--n-paper); color: var(--n-text); border: 1px solid var(--n-border);
  border-radius: 10px; box-shadow: var(--n-shadow); overflow: hidden; font-size: 13px; line-height: 1.65; }
.nm-rail.nm-narrow .nm-card { position: static; border-left: 3px solid var(--n-accent); }
.nm-card.nm-active { border-color: color-mix(in srgb, var(--n-accent) 60%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--n-accent) 12%, transparent), var(--n-shadow); }
.nm-card.nm-draft { border-style: dashed; border-color: color-mix(in srgb, var(--n-accent) 65%, transparent); background: var(--n-pop); }
.nm-card.nm-stale .nm-chip.nm-st { color: var(--n-warn); background: var(--n-warn-bg); }
.nm-head { height: 34px; display: flex; align-items: center; gap: 8px; padding: 0 6px 0 12px; border-bottom: 1px solid var(--n-line); font-size: 12px; color: var(--n-muted); }
.nm-head b { color: var(--n-text); font-weight: 600; }
.nm-head .nm-sum { display: none; color: var(--n-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.nm-sp { flex: 1; }
.nm-ask-hint { flex-wrap: wrap; align-items: center; }
.nm-ask-hint small { flex: 1 1 140px; min-width: 0; }
.nm-card.nm-folded .nm-head { border-bottom: 0; cursor: pointer; }
.nm-card.nm-folded .nm-head .nm-sum { display: inline; }
.nm-card.nm-folded .nm-head .nm-full { display: none; }
.nm-card.nm-folded .nm-body, .nm-card.nm-folded .nm-foot { display: none; }
.nm-card.nm-folded .nm-fold svg { transform: rotate(180deg); }
.nm-ib { width: 24px; height: 24px; border-radius: 6px; border: 0; background: none; color: var(--n-faint); display: grid; place-items: center; cursor: pointer; flex: none; padding: 0; }
.nm-ib:hover { background: var(--n-hover); color: var(--n-text); }
.nm-ui svg.nm-i { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; flex: none; }
.nm-chip { font-size: 11px; border-radius: 999px; padding: 0 8px; line-height: 18px; background: var(--n-chip); color: var(--n-muted); display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.nm-chip.nm-run { background: color-mix(in srgb, var(--n-accent) 16%, transparent); color: var(--n-link); }
.nm-chip.nm-done { background: color-mix(in srgb, var(--n-c-code) 16%, transparent); color: var(--n-c-code); }
.nm-spin { width: 11px; height: 11px; border: 2px solid color-mix(in srgb, var(--n-accent) 30%, transparent); border-top-color: var(--n-accent); border-radius: 50%; animation: nm-rot .8s linear infinite; flex: none; }
@keyframes nm-rot { to { transform: rotate(360deg); } }
.nm-body { padding: 12px 14px; }
.nm-q { margin: 0 0 10px; padding: 2px 0 2px 10px; border-left: 2px solid var(--n-accent); color: var(--n-muted); font-size: 13px; line-height: 1.65;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.nm-turn { display: flex; gap: 9px; margin-top: 10px; }
.nm-turn:first-of-type { margin-top: 0; }
.nm-av { width: 22px; height: 22px; border-radius: 50%; background: var(--n-chip); display: grid; place-items: center; font-size: 11px; color: var(--n-text); flex: none; margin-top: 1px; }
.nm-av.nm-bot { border-radius: 7px; background: linear-gradient(140deg, #4C8DFF, #B18CFF); color: #fff; font-weight: 700; }
.nm-msg { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.nm-md p, .nm-md ul, .nm-md ol, .nm-md pre { margin: 0 0 8px; }
.nm-md p { white-space: pre-wrap; }
.nm-md > :last-child { margin-bottom: 0; }
.nm-md ul, .nm-md ol { padding-left: 20px; }
.nm-md strong { color: var(--n-text); font-weight: 650; }
.nm-md pre { background: var(--n-code); border: 1px solid var(--n-line); border-radius: 6px; padding: 6px 9px; overflow: auto; font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
.nm-wait { color: var(--n-muted); display: flex; align-items: center; gap: 8px; }
.nm-stamp { font-size: 11px; color: var(--n-faint); margin-top: 8px; }
.nm-more { font-size: 11px; color: var(--n-faint); margin-top: 8px; }
.nm-foot { display: flex; flex-wrap: wrap; gap: 2px; padding: 6px 8px; border-top: 1px solid var(--n-line); }
.nm-gb { white-space: nowrap; display: inline-flex; align-items: center; gap: 5px; font: inherit; font-size: 12px; color: var(--n-muted); padding: 4px 7px; border-radius: 6px; border: 0; background: none; cursor: pointer; }
.nm-gb:hover { background: var(--n-hover); color: var(--n-text); }
.nm-gb.nm-pri { color: var(--n-link); }
.nm-gb.nm-bad { color: var(--n-error); }
.nm-gb[disabled] { opacity: .45; cursor: default; }
.nm-stub { padding: 10px 14px 12px; color: var(--n-muted); font-size: 12.5px; }
.nm-btn { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 12px; padding: 5px 11px; border-radius: 7px; border: 1px solid var(--n-border); background: var(--n-chip); color: var(--n-text); cursor: pointer; }
.nm-btn.nm-go { background: var(--n-accent); border-color: var(--n-accent); color: #fff; font-weight: 600; }
.nm-btn.nm-ghost { background: none; color: var(--n-muted); }
.nm-btn[disabled] { opacity: .5; cursor: default; }
.nm-btn kbd, .nm-win kbd, .nm-draft kbd { font: 10px ui-monospace, Menlo, monospace; border: 1px solid var(--n-border); border-radius: 4px; padding: 0 4px; color: var(--n-faint); }
.nm-btn.nm-go kbd { color: #fff; border-color: rgba(255,255,255,.4); }
.nm-card.nm-draft.nm-inline { position: relative; left: auto; right: auto; overflow: visible; margin: -2px 0 12px 14px; border-style: solid;
  border-color: color-mix(in srgb, var(--n-accent) 50%, var(--n-border)); border-left: 3px solid var(--n-accent); background: var(--n-pop); animation: nm-drop .16s ease-out; }
.nm-card.nm-draft.nm-inline::before { content: ""; position: absolute; left: 16px; top: -7px; width: 10px; height: 10px; background: var(--n-pop); transform: rotate(45deg);
  border-top: 1px solid color-mix(in srgb, var(--n-accent) 50%, var(--n-border)); border-left: 1px solid color-mix(in srgb, var(--n-accent) 50%, var(--n-border)); }
@keyframes nm-drop { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
.nm-ask-ctl { flex-wrap: wrap; margin-top: 8px; }
.nm-ask-ctl .nm-scope { margin-top: 0; flex: 0 0 auto; }
.nm-ask-ctl .nm-scope button { padding: 3px 12px; white-space: nowrap; }
.nm-draft-body { padding: 10px 12px; }
.nm-draft-top { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 12px; color: var(--n-muted); }
.nm-draft-top b { color: var(--n-text); }
.nm-draft-top .nm-qc { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-left: 2px solid var(--n-accent); padding-left: 8px; color: var(--n-faint); }
.nm-ui textarea { display: block; width: 100%; resize: none; background: var(--n-code); color: var(--n-text); border: 1px solid var(--n-border); border-radius: 8px; padding: 8px 10px;
  font: 13px/1.6 -apple-system, BlinkMacSystemFont, "PingFang TC", sans-serif; outline: none; }
.nm-ui textarea:focus { border-color: var(--n-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--n-accent) 15%, transparent); }
.nm-scope { display: flex; gap: 2px; background: var(--n-code); border: 1px solid var(--n-line); border-radius: 8px; padding: 2px; font-size: 11px; margin-top: 8px; }
.nm-scope button { flex: 1; font: inherit; padding: 3px 0; border: 0; border-radius: 6px; background: none; color: var(--n-faint); cursor: pointer; }
.nm-scope button.nm-on { background: var(--n-selected); color: var(--n-text); }
.nm-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.nm-row small { color: var(--n-faint); font-size: 11px; line-height: 1.4; }
.nm-err { color: var(--n-error); font-size: 12px; margin-top: 8px; }
.nm-pop { position: absolute; z-index: 6; display: flex; align-items: center; background: var(--n-pop); border: 1px solid var(--n-border); border-radius: 9px; padding: 3px; box-shadow: var(--n-shadow); font-size: 12px; white-space: nowrap; }
.nm-pop button { display: flex; gap: 6px; align-items: center; font: inherit; border: 0; border-radius: 6px; background: var(--n-accent); color: #fff; font-weight: 600; padding: 4px 10px; cursor: pointer; }
.nm-float { position: absolute; z-index: 7; width: min(470px, calc(100% - 20px)); }
.nm-float.nm-card { position: absolute; }
.nm-hl { background: color-mix(in srgb, var(--n-accent) 14%, transparent); box-shadow: -6px 0 0 color-mix(in srgb, var(--n-accent) 14%, transparent), 6px 0 0 color-mix(in srgb, var(--n-accent) 14%, transparent); border-radius: 2px; }
.nm-cellhl { box-shadow: 0 0 0 1px color-mix(in srgb, var(--n-accent) 45%, transparent); }
.nm-hl.nm-focus, .nm-cellhl.nm-focus { background: color-mix(in srgb, var(--n-accent) 24%, transparent); }
::highlight(nm-anchor) { background-color: rgba(76,141,255,.22); text-decoration: underline; text-decoration-color: rgba(76,141,255,.9); text-decoration-thickness: 2px; }
::highlight(nm-focus) { background-color: rgba(76,141,255,.42); }
.nm-win { position: fixed; z-index: 40; width: 540px; max-width: calc(100vw - 24px); background: var(--n-pop); color: var(--n-text); border: 1px solid color-mix(in srgb, var(--n-accent) 55%, transparent);
  border-radius: 14px; box-shadow: var(--n-shadow); overflow: hidden; font-size: 13px; }
.nm-wbar { height: 40px; display: flex; align-items: center; gap: 8px; padding: 0 6px 0 12px; background: var(--n-selected); border-bottom: 1px solid var(--n-border); cursor: grab;
  user-select: none; -webkit-user-select: none; touch-action: none; color: var(--n-muted); font-size: 12px; }
.nm-wbar b { color: var(--n-text); font-size: 13px; }
.nm-grip { width: 10px; height: 16px; background: radial-gradient(circle, var(--n-faint) 1.2px, transparent 1.5px) 0 0 / 5px 5px; flex: none; opacity: .8; }
.nm-wbody { padding: 14px 16px 12px; max-height: min(520px, 70vh); overflow: auto; }
.nm-win.nm-min .nm-wbody, .nm-win.nm-min .nm-wfoot { display: none; }
.nm-wbody .nm-turn { margin-top: 12px; }
.nm-wbody .nm-q { -webkit-line-clamp: 1; }
.nm-prev { margin: 10px 0 0; border: 1px solid var(--n-line); border-radius: 8px; background: var(--n-code); }
.nm-prev summary { cursor: pointer; padding: 6px 10px; font-size: 12px; color: var(--n-muted); }
.nm-prev .nm-in { padding: 0 10px 10px; font-size: 12px; color: var(--n-muted); }
.nm-winin { display: flex; gap: 8px; align-items: flex-end; margin-top: 12px; }
.nm-winin textarea { flex: 1; }
.nm-wfoot { display: flex; align-items: center; gap: 4px; padding: 8px 10px; border-top: 1px solid var(--n-line); }
.nm-wfoot small { color: var(--n-faint); font-size: 11px; padding-left: 6px; }
@media (max-width: 759px) { .nm-win { left: 12px !important; right: 12px; top: auto !important; bottom: 12px; width: auto; max-width: none; } }
@media (prefers-reduced-motion: reduce) { .nm-spin { animation: none; } }
`;
