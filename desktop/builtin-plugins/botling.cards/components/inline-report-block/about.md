行內報告區塊: draws ONE report block (kpi, table, options, flowchart, timeline, steps…) inside a chat reply, looking the same as on a report page. Every bot has it; show it with `<show name="inline-report-block">{block JSON}</show>`.
Sizes: 2x2
Icon: chart.bar.doc.horizontal
Built-in: yes

Use it when the answer is mostly text and one block makes it clearer (a KPI row, a comparison table, the options with a recommendation, a flowchart of the cause). Several blocks = several `<show>` tags (one block each). When the result needs many charts or a verdict card, show them as several blocks; make a report page only when the user asked for one (or agreed after you asked in the chat). It does not call `ccb.answer`: the user does not answer it, and nothing comes back to the bot.

## Data format (window.ccb.data)

`ccb.data` is ONE block object (or a JSON string of it): the same JSON as one element of `sections[].blocks` in a report spec, field for field (see the report skill's `report-blocks.md`). The block `type` is required; every block also takes the optional `title` (action title: the point of the block), `note` (faint caption on the right of the title: unit, scope, source). `lang` is optional (`"zh-Hant"` or `"en"`): it picks the language of the built-in labels (完成 / Done, 建議 / Recommended…); without it the card uses Chinese when the block holds Chinese text, else English.

Statuses (`status`): `done | active | pending | blocked | risk | unverified | skipped`. Tones (`tone`): `good | warn | bad | info | neutral`.

Supported `type`s, with one example each (the whole JSON goes inside `<show>`):

- `kpi` (1–6 headline numbers; `value` number or string; `delta` + `deltaDir` `up_good | down_good | neutral` colours the change; `target`; `status` colours the number; `stack: true` draws a segmented bar of the items that have a status, first item = total):
  `{"type":"kpi","title":"冷啟動少了 42%","items":[{"label":"冷啟動","value":1.4,"unit":"s","delta":"-42%","deltaDir":"down_good"},{"label":"閒置 CPU","value":"2.1%","delta":"-7.7pt","deltaDir":"down_good","target":"目標 ≤ 3%"}]}`
- `table` (`columns` 2–6 strings; `rows` of strings, numbers or cell objects `{text, status?, tone?, strong?}`; numeric columns align right; `highlight` = row index):
  `{"type":"table","title":"四條工作線，一條受阻","columns":["工作線","狀態","下一步"],"rows":[["任務面板",{"text":"已安裝","status":"done"},"收集回饋"],["手機版",{"text":"受阻","status":"blocked"},"修 bot 清單"]]}`
- `options` (2–4 options × 2–7 criteria; each cell `{text, tone?}`; `recommended: true` marks one; `verdict`):
  `{"type":"options","title":"選方案 A","criteria":["成本","風險"],"options":[{"name":"方案 A","summary":"先上線","recommended":true,"cells":[{"text":"低","tone":"good"},{"text":"中","tone":"warn"}]},{"name":"不做","cells":[{"text":"0","tone":"good"},{"text":"高","tone":"bad"}]}],"verdict":"選 A：成本最低、可回退。"}`
- `proscons` (`pros`, `cons`: 1–5 short strings each; `verdict`):
  `{"type":"proscons","title":"快，但要多一個服務","pros":["啟動快","好測試"],"cons":["多一個程序"],"verdict":"值得。"}`
- `checklist` (`items`: `{label, status, note?}`; shows "n / m 完成" and a status bar):
  `{"type":"checklist","title":"4 項已過 2 項","items":[{"label":"安裝","status":"done"},{"label":"同步 bot 清單","status":"blocked","note":"等 API"}]}`
- `progress` (1–8 bars; `{label, value, max?, unit?, status?}`; without `max` the value is a percent, so at most 100; with `max`, `value` must be ≤ `max`: a bar shows a part of a whole, never a value above its total, so a number above its total is another kind of figure, not a progress bar):
  `{"type":"progress","items":[{"label":"Rust 後端指令","value":34,"max":52,"status":"active"},{"label":"卡片搬移","value":23,"max":23,"status":"done","unit":"張"}]}`
- `timeline`: an event log (items without `end`): `{"type":"timeline","title":"21:10 改版後出現","items":[{"start":"21:10","label":"上線","status":"done"},{"start":"21:40","label":"使用者回報","status":"blocked","text":"只看到 Main"}]}`; or a gantt (items with `end`, `YYYY-MM-DD`; optional `lane`, and `today` on the block): `{"type":"timeline","today":"2026-11-20","items":[{"label":"設計","start":"2026-11-10","end":"2026-11-18","status":"done","lane":"A"},{"label":"上線","start":"2026-12-01","status":"pending","lane":"A"}]}`
- `roadmap` (2–4 columns; items `{label, status?, note?}`):
  `{"type":"roadmap","columns":[{"title":"現在","items":[{"label":"Rust IPC","status":"active","note":"剩 3 個"}]},{"title":"下一步","items":[{"label":"安裝器簽章"}]},{"title":"之後","items":[{"label":"Windows 打包"}]}]}`
- `steps` (2–6 steps; `{title, text?, status?}`):
  `{"type":"steps","title":"分三步修","items":[{"title":"補 API","text":"手機改讀 /bots","status":"active"},{"title":"加測試"},{"title":"實機驗收"}]}`
- `callout` (`tone`, `title?`, `text`):
  `{"type":"callout","tone":"warn","title":"還沒在實機驗證","text":"數字來自開發機。"}`
- `matrix` (`rows`, `cols`: strings or `{label, status?}` — a column status colours the chips in it; `cells[row][col]` = array of ≤4 short names or null):
  `{"type":"matrix","title":"P0 只剩一項","rows":["P0","P1"],"cols":[{"label":"受阻","status":"blocked"},{"label":"完成","status":"done"}],"cells":[[["離線安裝"],null],[null,["任務面板"]]]}`
- `flowchart` (also `flow`; `dir` `LR` (default) or `TB`; `nodes` `{id, label, sub?, status?, kind?: step|decision|start|end}`; `edges` `{from, to, label?, kind?: solid|dashed}` by node id; laid out automatically, loops are drawn as a dashed return line; on a narrow card an LR chart turns top-down):
  `{"type":"flowchart","title":"卡在安裝","nodes":[{"id":"impl","label":"實作","status":"done"},{"id":"ok","label":"通過?","kind":"decision"},{"id":"inst","label":"安裝","sub":"退回 .1","status":"blocked"}],"edges":[{"from":"impl","to":"ok"},{"from":"ok","to":"inst","label":"是"},{"from":"ok","to":"impl","label":"否","kind":"dashed"}]}`
- `sequence` (2–5 `actors`; `steps` `{from, to, label, kind?: call|reply|note, status?}`):
  `{"type":"sequence","actors":["手機","Bridge","Core"],"steps":[{"from":"手機","to":"Bridge","label":"GET /bots"},{"from":"Bridge","to":"Core","label":"listBots()"},{"from":"Core","to":"Bridge","label":"3 個 bot","kind":"reply"},{"from":"Bridge","to":"手機","label":"只回傳第一個","kind":"reply","status":"blocked"}]}`
- `prose` (`text`: restricted Markdown — **bold**, *italic*, `code`, `- ` bullets, `1. ` numbers):
  `{"type":"prose","text":"CPU 從 **9.8%** 降到 *2.1%*。\n\n- 停掉背景輪詢"}`
- `quote`: `{"type":"quote","text":"只看得到 Main。","source":"使用者回報"}`
- `glossary`: `{"type":"glossary","items":[{"term":"SESS","plain":"先把每個人的腦波調到同一基準的前處理。"}]}`
- `sources`: `{"type":"sources","items":[{"ref":"a58c883","text":"任務面板已安裝"}]}`
- `image` (PNG / JPEG only: a `data:image/…` URI or a local file path; `alt`, `caption?`, `annotations` `{x,y,label}` with x and y 0–1): `{"type":"image","src":"data:image/png;base64,…","alt":"側欄只剩 Main","annotations":[{"x":0.2,"y":0.1,"label":"只剩 Main"}]}`

Not drawn here: `figure` and `experiment` (they need the report renderer's matplotlib run) and the retired native charts (`bar`, `trend`, `donut`, `beforeafter`, `quadrant`) — no block here draws those, and none is to be bent into them (a card worker describes the chart it wants in a `<component>` and Maintainer decides; a bot with no card worker draws a matplotlib PNG shown inline; a report page only when the user asked for one). LaTeX is not typeset (shown as text). A full report spec (with `sections`) is not accepted: pass one block.

## Wrong data

Invalid JSON, a missing `type`, an unknown `type`, or a block that breaks its schema (a missing field, a wrong status, an edge naming a node that does not exist…) draws a small red-dashed error card that says what is wrong, where (`items[1].label`) and a valid example for that type; it is never blank. Fix the JSON and `<show>` it again.

## From command

(none: the bot writes the block; there is no Command.)

## Optional (bot only)

Everything above is written by the bot. Optional fields: `title`, `note`, `lang` on any block, and the optional fields named in each type's line.

## Display rules

- It follows the report page's look and the app's light / dark theme (it uses the host's colour tokens and `<html data-theme>`, so it blends with the reply bubble, tile or panel; same block shapes), but draws no card frame or background of its own: in the chat the reply's bubble is the frame, on the Board and in a pin the tile or panel is. It is as tall as its content in the chat and in a pin; on a Board tile that is shorter it scrolls inside the tile.
- One responsive layout: wide cards use full columns; narrow ones stack (KPI two per row, options as cards, an LR flowchart top-down, one-column roadmap and steps).
- Tiny (about one Board cell, or very short): just the block's key value, big, with a one-line label — a KPI's first number, a checklist's "2/4", the recommended option, the blocked node, a callout's title…
- Pin chip: the icon with a short status of that key value (about 14 characters; the tone is red for blocked / bad, orange for warn, green for good / all done).
- Each new data (`<show … id="x">` again, or a refresh) redraws the card; nothing is kept in screen memory and nothing is saved.
