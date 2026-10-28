# Botling report blocks (ReportSpec v2)

> Generated from `desktop/reports/v2/blocks` by `node desktop/scripts/report.mjs --docs`. Do not edit by hand.

A report is JSON: header + `tldr` + `sections[] → blocks[]` + `asks`. You pick the blocks; layout, colours, fonts and the slide version are decided by the renderer. Write key points only.

## Rules

1. **Answer first.** `tldr` ≤ 3 sentences states the conclusion; `next` ≤ 3 one-line steps.
2. **Headline = takeaway.** Every section has `takeaway`: its conclusion as one sentence (≈ 22 CJK chars / 15 words). Reading only takeaways gives the argument. `title` is the short topic label.
3. **One idea per section, ≤ 2 charts per section, ≤ 8 in the report.** Visuals for data, prose for reasoning, bullets only for lists (≤ 6, ≤ 2 levels).
4. **Every chart has an action title** (`title`: what it shows, not what it is) and direct labels; never repeat a KPI as a chart.
5. **Evidence is short.** One line per claim (number + source); ≤ 4 `sources`; long logs stay out of the report. Never hide a risk or a decision in detail.
6. **Uncertainty with words + %:** almost certain 95–99, very likely 80–95, likely 55–80, roughly even 45–55, unlikely 20–45, very unlikely 5–20. Mark verified vs inferred vs not checked.
7. **End with `asks`** (what, who, by) — or `"asks": []` for "No action needed". `status.level` at_risk / off_track needs `status.reason` (cause + fix).
8. **Forbidden:** topic-only headings, narrating your process chronologically, the conclusion at the end, evidence dumps, decorative charts, one-sided options, vague hedging, mixing report kinds.

## Generate

```sh
node desktop/scripts/report.mjs spec.json /abs/.bot/artifacts/report.html          # document (no JavaScript)
node desktop/scripts/report.mjs spec.json /abs/.bot/artifacts/report-slides.html --slides  # 16:9 slides
```

The CLI prints one JSON line: `{"ok", "errors": [{path, message, example}], "warnings": [{path, message}], "htmlPath", "link"}`. Fix every error (the `example` is a valid block of that type); fix warnings when you can, then render again (≤ 2 retries). A block with errors renders as a visible placeholder; the rest of the report still renders. Put `link` in your reply.

## Spec

```json
{
  "version": 2,
  "lang": "zh-Hant",
  "kind": "status",
  "title": "今天的交付狀態",
  "asOf": "2026-10-28 18:00",
  "tldr": "任務面板 .11 已安裝；手機版 bot 清單受阻，今天修。",
  "sections": [
    {
      "title": "進度",
      "takeaway": "四條線裡一條受阻",
      "blocks": [
        {
          "type": "kpi",
          "items": [
            {
              "label": "完成",
              "value": 1,
              "status": "done"
            },
            {
              "label": "受阻",
              "value": 1,
              "status": "blocked"
            }
          ]
        }
      ]
    }
  ]
}
```

- `version`: 2
- `lang?`: "zh-Hant" | "en"
- `kind?`: "status" | "decision" | "investigation" | "comparison" | "plan" | "results" | "explainer" — One report type per report; picks the skeleton (see the prompt doc).
- `title`: string ≤40 — What this report is about, ≤ 22 CJK chars.
- `subtitle?`: string ≤80
- `asOf`: string ≤40 — When the evidence was taken, human readable.
- `status?`: { level, reason? }
  - `level`: "on_track" | "at_risk" | "off_track" | "done" | "info"
  - `reason?`: string ≤60 — Required for at_risk / off_track: cause and fix in one line.
- `tldr`: string ≤240 — The answer first: ≤ 3 sentences. Shown in the verdict card and on the cover slide.
- `next?`: string ≤24[] (≥1 ≤3) — ≤ 3 one-line next steps, shown as numbered chips under the verdict.
- `sections`: { id?, title, takeaway?, layout?, blocks }[] (≥1 ≤8)
  - `id?`: string ≤32
  - `title`: string ≤24 — Short topic label, shown small above the takeaway.
  - `takeaway?`: string ≤60 — The section's conclusion as one sentence; becomes the slide headline.
  - `layout?`: "auto" | "stack" | "split" | "grid"
  - `blocks`: { type, title?, note?, span?, text, slide? } | { type, title?, note?, span?, tone?, text } | { type, title?, note?, span?, items, stack? } | { type, title?, note?, span?, series, rows, stacked?, horizontal?, sort?, unit?, highlight? } | { type, title?, note?, span?, x?, series, area?, zero?, unit?, target?, marks? } | { type, title?, note?, span?, parts, unit?, center? } | { type, title?, note?, span?, labels?, rows } | { type, title?, note?, span?, rows, cols, cells, scale?, unit? } | { type, title?, note?, span?, x, y, quadrants?, best?, points } | { type, title?, note?, span?, items, today? } | { type, title?, note?, span?, columns } | { type, title?, note?, span?, dir?, nodes, edges } | { type, title?, note?, span?, actors, steps } | { type, title?, note?, span?, columns, rows, highlight? } | { type, title?, note?, span?, criteria, options, verdict? } | { type, title?, note?, span?, pros, cons, verdict? } | { type, title?, note?, span?, items } | { type, title?, note?, span?, items } | { type, title?, note?, span?, items } | { type, title?, note?, span?, text, source? } | { type, title?, note?, span?, src, alt, caption?, annotations? } | { type, title?, note?, span?, items }[] (≥1 ≤8)
- `asks?`: { what, who?, by? }[] (≤3) — What the reader must do (owner, deadline). [] renders "No action needed".
  - `what`: string ≤60
  - `who?`: string ≤20
  - `by?`: string ≤20
- section: `{ id?, title, takeaway?, layout?: "auto"|"stack"|"split"|"grid", blocks[] (≤8) }` — keep `layout` on auto unless you have a reason.

## Report kinds

Pick one `kind`; use its skeleton as the default section order (skip what you have no evidence for).

### status

Where things stand and what needs attention.

1. tldr + status.level (at_risk/off_track need status.reason: cause + fix)
2. kpi (target vs actual, delta, spark) — stack:true for status counts
3. checklist or table (Done / Next / Blocked) or flow (where each item is stuck)
4. timeline (milestones) or roadmap (now/next/later) — optional
5. asks (owner, deadline) — or [] for "No action needed"

### decision

"Decision needed: X by date" with a recommendation.

1. tldr = the recommendation + the deadline
2. prose: context in SCQA, 2–3 sentences
3. options (2–4 incl. "do nothing", same criteria: cost, risk, time, reversibility) with recommended + verdict
4. proscons or quadrant (effort × impact) — why the others lose
5. callout tone=warn: the main risk / assumption
6. asks: who decides, by when

### investigation

What broke, why, and whether it is fixed.

1. tldr = impact + fixed now? + the cause in one sentence
2. timeline (events) — what happened when
3. flow or sequence — the causal chain, failing step status=blocked
4. beforeafter or trend — the metric before/after the fix
5. checklist — actions with owners (blameless)
6. sources ≤ 4

### comparison

Which one, and "pick X if…, Y if…".

1. tldr = the winner + when to pick the other
2. options or table with the winning cells toned good
3. bar (small multiples via one bar per criterion) — optional
4. callout: caveats

### plan

Goal, definition of done, path there.

1. tldr = goal + definition of done + date
2. timeline (gantt with lanes, today) or roadmap
3. flow — dependencies / critical path
4. callout tone=bad for the top risk
5. steps — the first step; asks — decision needed

### results

What the numbers say after a change.

1. tldr = headline number + what it means
2. kpi vs baseline (delta, target)
3. trend with marks at the change, target line
4. beforeafter or bar — segment breakdown
5. prose: interpretation with likelihood words + %
6. sources ≤ 4

### explainer

What it is and how it works.

1. tldr = one sentence what + why
2. flow or sequence — the mechanism
3. steps or table — 3–5 concepts
4. image — a worked example
5. callout — limits

## Blocks

Every block takes optional `title` (action title), `note` (faint caption: unit, scope, source) and `span: "full"`. Statuses everywhere: `done | active | pending | blocked | risk | unverified | skipped`. Tones: `good | warn | bad | info | neutral`.

| type | use for |
|---|---|
| `prose` | A short paragraph or bullet list in restricted Markdown (**bold**, *italic*, `code`, - bullets, 1. numbers). |
| `callout` | One highlighted message with a tone: info, warn, bad (risk), good (success) or neutral. |
| `kpi` | A row of 1–6 headline numbers, each with label and optional delta, target and sparkline. |
| `bar` | Bar chart for comparing categories: one or more series, grouped or stacked, vertical or horizontal (auto). |
| `trend` | Line or area chart over time (or any ordered x) for 1–4 series, with direct end labels, optional target line and up to 3 event marks. |
| `donut` | Parts of one whole, 2–4 slices, with a centre figure and a value legend. |
| `beforeafter` | Paired before/after bars per metric with the change in %, coloured by whether higher or lower is better. |
| `matrix` | A grid of rows × columns: a heatmap of numbers, or a placement grid where each cell lists short item names. |
| `quadrant` | 2×2 chart: items placed by two 0–1 scores (e.g. effort × impact), with the four quadrants named. |
| `timeline` | Either a vertical event log (items without end) or a gantt chart (items with start and end dates, optional lanes and a today line). |
| `roadmap` | Two to four columns (e.g. Now / Next / Later) of short items with optional status. |
| `flow` | Flowchart laid out automatically (elkjs): boxes with optional status colour, decisions, start/end pills, labelled arrows; left→right or top→bottom. |
| `sequence` | Sequence diagram: 2–5 actors as columns, numbered messages between them (call, dashed reply, or a note on one actor). |
| `table` | A compact table; cells can carry a status or tone dot. Numeric columns align right. |
| `options` | Options compared on the same criteria (2–4 options incl. "do nothing", 2–7 criteria), each cell rated good / warn / bad, with the recommended option marked. |
| `proscons` | Two lists, pros and cons of one option, with an optional one-line verdict. |
| `checklist` | A list of items with a status each, plus a done-count and a status bar. |
| `progress` | One to eight labelled progress bars (value of max). |
| `steps` | An ordered sequence of 2–6 steps, each a short title with an optional one-line detail. |
| `quote` | A short quotation with its source. |
| `image` | A screenshot or figure with up to 6 numbered annotations placed at relative positions (0–1). |
| `sources` | Up to four one-line sources: a short reference (commit, file, run id) and what it shows. |

### `prose`

A short paragraph or bullet list in restricted Markdown (**bold**, *italic*, `code`, - bullets, 1. numbers).

**When:** Reasoning that a chart cannot carry: why, so what, caveats. 2–4 sentences or ≤5 bullets. Not for data (use a chart) and not for a chronological log.

- `title?`: string ≤80 — Action title: the point of this block, not its topic ("啟動時間少了 42%", not "啟動時間").
- `note?`: string ≤60 — Faint caption on the right of the title: unit, scope or source.
- `text`: string ≤1200 — Restricted Markdown. No headings, links, images or HTML.
- `slide?`: string ≤160 — One-sentence version for slides; defaults to the first paragraph.

```json
{"type":"prose","text":"閒置 CPU 從 **9.8%** 降到 **2.1%**，主要來自停掉背景輪詢。\n\n- 只在視窗可見時更新側欄\n- 子程序改為事件喚醒"}
```

### `callout`

One highlighted message with a tone: info, warn, bad (risk), good (success) or neutral.

**When:** A risk, a caveat or a decision the reader must not miss. At most one per section; never hide a risk anywhere else.

- `title?`: string ≤80 — Action title: the point of this block, not its topic ("啟動時間少了 42%", not "啟動時間").
- `note?`: string ≤60 — Faint caption on the right of the title: unit, scope or source.
- `tone?`: "good" | "warn" | "bad" | "info" | "neutral"
- `text`: string ≤240

```json
{"type":"callout","tone":"warn","title":"還沒在實機驗證","text":"數字來自開發機；裝到使用者電腦後要再量一次才算完成。"}
```

### `kpi`

A row of 1–6 headline numbers, each with label and optional delta, target and sparkline.

**When:** The 3–5 numbers the reader should remember, at the top of status and results reports. Put the most important first. Do not repeat a KPI as a chart.

- `title?`: string ≤80 — Action title: the point of this block, not its topic ("啟動時間少了 42%", not "啟動時間").
- `note?`: string ≤60 — Faint caption on the right of the title: unit, scope or source.
- `items`: { label, value, unit?, delta?, deltaDir?, target?, spark?, status? }[] (≥1 ≤6)
  - `label`: string ≤16
  - `value`: number | string ≤10
  - `unit?`: string ≤6
  - `delta?`: string ≤12 — Signed change, e.g. "-42%" or "+3". Colour follows deltaDir.
  - `deltaDir?`: "up_good" | "down_good" | "neutral"
  - `target?`: string ≤20 — e.g. "目標 ≤ 3%"
  - `spark?`: number[] (≥2 ≤40)
  - `status?`: "done" | "active" | "pending" | "blocked" | "risk" | "unverified" | "skipped" — Colours the number (blocked = red, pending = orange…).
- `stack?`: boolean — Draw a segmented bar of the items that have a status (first item = total).

```json
{"type":"kpi","items":[{"label":"冷啟動","value":1.4,"unit":"s","delta":"-42%","deltaDir":"down_good","spark":[2.6,2.5,2.4,2.1,1.6,1.4]},{"label":"閒置 CPU","value":"2.1%","delta":"-7.7pt","deltaDir":"down_good","target":"目標 ≤ 3%"},{"label":"記憶體","value":412,"unit":"MB","delta":"+6%","deltaDir":"down_good"}]}
```

### `bar`

Bar chart for comparing categories: one or more series, grouped or stacked, vertical or horizontal (auto).

**When:** Comparing amounts across ≤15 categories. Use highlight to point at the bar the title talks about. Time series → trend; parts of one whole → donut.

- `title?`: string ≤80 — Action title: the point of this block, not its topic ("啟動時間少了 42%", not "啟動時間").
- `note?`: string ≤60 — Faint caption on the right of the title: unit, scope or source.
- `series`: { name }[] (≥1 ≤4)
  - `name`: string ≤20
- `rows`: { label, values }[] (≥1 ≤15)
  - `label`: string ≤24
  - `values`: number ≥0[] (≥1 ≤4)
- `stacked?`: boolean
- `horizontal?`: boolean — Omit to choose automatically (horizontal for many or long labels).
- `sort?`: boolean — Sort rows by size, largest first.
- `unit?`: string ≤8
- `highlight?`: string ≤24 — Row label to emphasise; other bars turn grey.

```json
{"type":"bar","title":"啟動時間主要花在載入聊天紀錄","unit":"ms","series":[{"name":"耗時"}],"highlight":"聊天紀錄","rows":[{"label":"主程序","values":[180]},{"label":"聊天紀錄","values":[620]},{"label":"外掛","values":[140]},{"label":"側欄","values":[90]}]}
```

### `trend`

Line or area chart over time (or any ordered x) for 1–4 series, with direct end labels, optional target line and up to 3 event marks.

**When:** Change over time, especially before/after an event (mark it). Title says the trend ("閒置 CPU 降了七成"). For two numbers only, use kpi or beforeafter.

- `title?`: string ≤80 — Action title: the point of this block, not its topic ("啟動時間少了 42%", not "啟動時間").
- `note?`: string ≤60 — Faint caption on the right of the title: unit, scope or source.
- `x?`: "date" | "num" | "cat" — date = "YYYY-MM-DD", "YYYY-MM-DD HH:MM" or "HH:MM"; num = numbers; cat = ordered labels.
- `series`: { name, points }[] (≥1 ≤4)
  - `name`: string ≤20
  - `points`: [string ≤20 | number, number][] (≥2 ≤60)
- `area?`: boolean
- `zero?`: boolean — Start the y axis at zero.
- `unit?`: string ≤8
- `target?`: { value, label }
  - `value`: number
  - `label`: string ≤16
- `marks?`: { x, label }[] (≤3)
  - `x`: string ≤20 | number
  - `label`: string ≤16

```json
{"type":"trend","title":"閒置 CPU 在 10/24 改版後降到 2%","unit":"%","x":"date","area":true,"target":{"value":3,"label":"目標 3%"},"marks":[{"x":"2026-10-24","label":"停掉背景輪詢"}],"series":[{"name":"閒置 CPU","points":[["2026-10-20",9.6],["2026-10-21",9.9],["2026-10-22",9.2],["2026-10-23",8.8],["2026-10-24",4.1],["2026-10-25",2.6],["2026-10-26",2.2],["2026-10-27",2.1]]}]}
```

### `donut`

Parts of one whole, 2–4 slices, with a centre figure and a value legend.

**When:** Only when the parts add up to a meaningful whole (time spent, share of crashes). More than 4 parts or comparing amounts → bar.

- `title?`: string ≤80 — Action title: the point of this block, not its topic ("啟動時間少了 42%", not "啟動時間").
- `note?`: string ≤60 — Faint caption on the right of the title: unit, scope or source.
- `parts`: { label, value }[] (≥2 ≤4)
  - `label`: string ≤20
  - `value`: number
- `unit?`: string ≤8
- `center?`: { value, label }
  - `value`: string ≤8
  - `label`: string ≤12

```json
{"type":"donut","title":"啟動時間一半花在聊天紀錄","unit":"ms","center":{"value":"1.4s","label":"冷啟動"},"parts":[{"label":"聊天紀錄","value":620},{"label":"主程序","value":380},{"label":"外掛與側欄","value":230},{"label":"其他","value":170}]}
```

### `beforeafter`

Paired before/after bars per metric with the change in %, coloured by whether higher or lower is better.

**When:** Results of a change: 1–6 metrics measured the same way before and after. Each row has its own scale, so mixed units are fine.

- `title?`: string ≤80 — Action title: the point of this block, not its topic ("啟動時間少了 42%", not "啟動時間").
- `note?`: string ≤60 — Faint caption on the right of the title: unit, scope or source.
- `labels?`: { before, after } — Defaults to 之前 / 之後.
  - `before`: string ≤12
  - `after`: string ≤12
- `rows`: { label, before, after, unit?, better }[] (≥1 ≤6)
  - `label`: string ≤20
  - `before`: number ≥0
  - `after`: number ≥0
  - `unit?`: string ≤8
  - `better`: "higher" | "lower"

```json
{"type":"beforeafter","title":"三項效能指標都變好","labels":{"before":".10","after":".11"},"rows":[{"label":"冷啟動","before":2.4,"after":1.4,"unit":"s","better":"lower"},{"label":"閒置 CPU","before":9.8,"after":2.1,"unit":"%","better":"lower"},{"label":"每秒訊息","before":140,"after":210,"better":"higher"}]}
```

### `matrix`

A grid of rows × columns: a heatmap of numbers, or a placement grid where each cell lists short item names.

**When:** Two dimensions at once: priority × status, module × platform failures, hour × weekday load. Cells hold numbers (heatmap) or arrays of ≤4 short names (placement). ≤30×30.

- `title?`: string ≤80 — Action title: the point of this block, not its topic ("啟動時間少了 42%", not "啟動時間").
- `note?`: string ≤60 — Faint caption on the right of the title: unit, scope or source.
- `rows`: string ≤16 | { label, status? }[] (≥1 ≤30)
- `cols`: string ≤16 | { label, status? }[] (≥1 ≤30) — A column with a status colours the item chips placed in it.
- `cells`: number | any | string ≤14[] (≤4)[][]
- `scale?`: "seq" | "div" — seq = low→high; div = negative↔positive around 0.
- `unit?`: string ≤8

```json
{"type":"matrix","title":"P0 只剩一項，卡在安裝","rows":["P0","P1","P2"],"cols":[{"label":"受阻","status":"blocked"},{"label":"進行中","status":"active"},{"label":"完成","status":"done"}],"cells":[[["離線安裝"],null,null],[null,["Rust 後端","手機同步"],["任務面板"]],[null,["報告改版"],["CPU 降低"]]]}
```

### `quadrant`

2×2 chart: items placed by two 0–1 scores (e.g. effort × impact), with the four quadrants named.

**When:** Prioritising ≤12 items on two judgements. Scores are estimates, so say so in the note. Name quadrants by the action ("先做", "別做").

- `title?`: string ≤80 — Action title: the point of this block, not its topic ("啟動時間少了 42%", not "啟動時間").
- `note?`: string ≤60 — Faint caption on the right of the title: unit, scope or source.
- `x`: string ≤16 — X axis name, low → high (left → right).
- `y`: string ≤16 — Y axis name, low → high (bottom → top).
- `quadrants?`: [string ≤12, string ≤12, string ≤12, string ≤12] — [top-left, top-right, bottom-left, bottom-right]
- `best?`: integer ≥0 ≤3 — Index of the quadrant to highlight as the good one (0=top-left…3=bottom-right).
- `points`: { label, x, y, status? }[] (≥1 ≤12)
  - `label`: string ≤16
  - `x`: number ≥0 ≤1
  - `y`: number ≥0 ≤1
  - `status?`: "done" | "active" | "pending" | "blocked" | "risk" | "unverified" | "skipped" — done=完成(green) active=進行中(blue) pending=待處理(orange) blocked=受阻(red) risk=有風險(red) unverified=未驗證(grey) skipped=略過(faint)

```json
{"type":"quadrant","title":"先修手機清單：影響大又便宜","note":"估計值","x":"工作量","y":"影響","quadrants":["先做","排進計畫","順手做","別做"],"best":0,"points":[{"label":"手機 bot 清單","x":0.2,"y":0.9,"status":"blocked"},{"label":"Rust IPC","x":0.75,"y":0.8,"status":"active"},{"label":"報告動畫","x":0.6,"y":0.2},{"label":"側欄字距","x":0.15,"y":0.25}]}
```

### `timeline`

Either a vertical event log (items without end) or a gantt chart (items with start and end dates, optional lanes and a today line).

**When:** Investigations (what happened when) and plans (phases with dates). ≤12 events in a report body; keep each label to the event, not the narration.

- `title?`: string ≤80 — Action title: the point of this block, not its topic ("啟動時間少了 42%", not "啟動時間").
- `note?`: string ≤60 — Faint caption on the right of the title: unit, scope or source.
- `items`: { label, start, end?, status?, lane?, text? }[] (≥1 ≤20)
  - `label`: string ≤40
  - `start`: string ≤20 — Event: any short time text ("10/27 21:40"). Gantt: "YYYY-MM-DD".
  - `end?`: string ≤20 — Gantt only, "YYYY-MM-DD". Omit for milestones/events.
  - `status?`: "done" | "active" | "pending" | "blocked" | "risk" | "unverified" | "skipped" — done=完成(green) active=進行中(blue) pending=待處理(orange) blocked=受阻(red) risk=有風險(red) unverified=未驗證(grey) skipped=略過(faint)
  - `lane?`: string ≤16
  - `text?`: string ≤80 — Event mode only: one line of detail.
- `today?`: string ≤20 — Gantt only, "YYYY-MM-DD".

```json
{"type":"timeline","title":"問題在 21:10 的改版後出現","items":[{"start":"10/27 21:10","label":"手機版 .4 上線","status":"done"},{"start":"21:40","label":"使用者回報只看到 Main","status":"blocked","text":"iPhone 與 Android 都一樣"},{"start":"22:05","label":"確認 /bots 回傳被截斷","status":"risk"},{"start":"22:30","label":"暫時退回 .3","status":"done"}]}
```

### `roadmap`

Two to four columns (e.g. Now / Next / Later) of short items with optional status.

**When:** Plans without exact dates, or "what is in flight vs queued". Dated work with durations → timeline.

- `title?`: string ≤80 — Action title: the point of this block, not its topic ("啟動時間少了 42%", not "啟動時間").
- `note?`: string ≤60 — Faint caption on the right of the title: unit, scope or source.
- `columns`: { title, items }[] (≥2 ≤4)
  - `title`: string ≤12
  - `items`: { label, status?, note? }[] (≤6)

```json
{"type":"roadmap","title":"這週收尾兩條線，下週開始 Windows","columns":[{"title":"現在","items":[{"label":"Rust 後端 IPC","status":"active","note":"剩 3 個指令"},{"label":"手機版 bot 清單","status":"blocked"}]},{"title":"下一步","items":[{"label":"報告區塊定稿"},{"label":"安裝器簽章"}]},{"title":"之後","items":[{"label":"Windows / Linux 打包"}]}]}
```

### `flow`

Flowchart laid out automatically (elkjs): boxes with optional status colour, decisions, start/end pills, labelled arrows; left→right or top→bottom.

**When:** A process, pipeline, causal chain or state change where the arrows are the point (where it is stuck, what caused what). ≤12 nodes in a report; mark the bottleneck with status blocked.

- `title?`: string ≤80 — Action title: the point of this block, not its topic ("啟動時間少了 42%", not "啟動時間").
- `note?`: string ≤60 — Faint caption on the right of the title: unit, scope or source.
- `dir?`: "LR" | "TB"
- `nodes`: { id, label, sub?, status?, kind? }[] (≥2 ≤25)
  - `id`: string ≤24
  - `label`: string ≤30
  - `sub?`: string ≤24
  - `status?`: "done" | "active" | "pending" | "blocked" | "risk" | "unverified" | "skipped" — done=完成(green) active=進行中(blue) pending=待處理(orange) blocked=受阻(red) risk=有風險(red) unverified=未驗證(grey) skipped=略過(faint)
  - `kind?`: "step" | "decision" | "start" | "end"
- `edges`: { from, to, label?, kind? }[] (≤40)
  - `from`: string
  - `to`: string
  - `label?`: string ≤16
  - `kind?`: "solid" | "dashed"

```json
{"type":"flow","title":"卡在安裝：新版 .2 裝上後退回 .1","nodes":[{"id":"impl","label":"實作","status":"done"},{"id":"review","label":"複審","status":"done"},{"id":"pack","label":"打包","status":"done"},{"id":"install","label":"安裝","sub":"退回 .1","status":"blocked"},{"id":"accept","label":"驗收","status":"pending"}],"edges":[{"from":"impl","to":"review"},{"from":"review","to":"pack"},{"from":"pack","to":"install"},{"from":"install","to":"accept"}]}
```

### `sequence`

Sequence diagram: 2–5 actors as columns, numbered messages between them (call, dashed reply, or a note on one actor).

**When:** Who talks to whom in what order: request paths, handoffs, where a message got lost. Mark the failing step with status blocked/risk.

- `title?`: string ≤80 — Action title: the point of this block, not its topic ("啟動時間少了 42%", not "啟動時間").
- `note?`: string ≤60 — Faint caption on the right of the title: unit, scope or source.
- `actors`: string ≤14[] (≥2 ≤5)
- `steps`: { from, to, label, kind?, status? }[] (≥1 ≤14)
  - `from`: string
  - `to`: string
  - `label`: string ≤40
  - `kind?`: "call" | "reply" | "note"
  - `status?`: "done" | "active" | "pending" | "blocked" | "risk" | "unverified" | "skipped" — done=完成(green) active=進行中(blue) pending=待處理(orange) blocked=受阻(red) risk=有風險(red) unverified=未驗證(grey) skipped=略過(faint)

```json
{"type":"sequence","title":"手機端拿到的清單在 Bridge 被截斷","actors":["手機","Bridge","Core"],"steps":[{"from":"手機","to":"Bridge","label":"GET /bots"},{"from":"Bridge","to":"Core","label":"listBots()"},{"from":"Core","to":"Bridge","label":"3 個 bot","kind":"reply"},{"from":"Bridge","to":"手機","label":"只回傳第一個","kind":"reply","status":"blocked"}]}
```

### `table`

A compact table; cells can carry a status or tone dot. Numeric columns align right.

**When:** Exact values the reader will look up, or a few rows × few attributes. ≤8 rows in the body of a report; larger data goes to an appendix file.

- `title?`: string ≤80 — Action title: the point of this block, not its topic ("啟動時間少了 42%", not "啟動時間").
- `note?`: string ≤60 — Faint caption on the right of the title: unit, scope or source.
- `columns`: string ≤24[] (≥2 ≤6)
- `rows`: string ≤60 | number | { text, status?, tone?, strong? }[][] (≥1 ≤20)
- `highlight?`: integer ≥0 ≤9007199254740991 — Index of the row to emphasise.

```json
{"type":"table","title":"四條工作線，一條受阻","columns":["工作線","狀態","下一步"],"rows":[["任務面板 .11",{"text":"已安裝","status":"done"},"收集回饋"],["Rust 遷移",{"text":"進行中","status":"active"},"補完 IPC"],["手機版對齊",{"text":"受阻","status":"blocked"},"修 bot 清單"],["報告改版",{"text":"進行中","status":"active"},"定稿區塊"]]}
```

### `options`

Options compared on the same criteria (2–4 options incl. "do nothing", 2–7 criteria), each cell rated good / warn / bad, with the recommended option marked.

**When:** Every decision or comparison report. Same criteria for every option (cost, risk, time, reversibility…). Put the recommendation in verdict and in the section takeaway.

- `title?`: string ≤80 — Action title: the point of this block, not its topic ("啟動時間少了 42%", not "啟動時間").
- `note?`: string ≤60 — Faint caption on the right of the title: unit, scope or source.
- `criteria`: string ≤16[] (≥2 ≤7)
- `options`: { name, summary?, recommended?, cells }[] (≥2 ≤4)
  - `name`: string ≤20
  - `summary?`: string ≤40
  - `recommended?`: boolean
  - `cells`: { text, tone? }[]
- `verdict?`: string ≤120

```json
{"type":"options","title":"自己畫 SVG 最划算","criteria":["離線輸出","套件大小"],"options":[{"name":"自己畫 SVG","recommended":true,"cells":[{"text":"可以","tone":"good"},{"text":"+40 KB","tone":"good"}]},{"name":"Recharts","cells":[{"text":"輸出空白","tone":"bad"},{"text":"+450 KB","tone":"warn"}]}],"verdict":"選自己畫：唯一能在產生時就畫好、不需要瀏覽器執行的方案。"}
```

### `proscons`

Two lists, pros and cons of one option, with an optional one-line verdict.

**When:** Weighing a single option. For several options use options. ≤5 points per side, one line each.

- `title?`: string ≤80 — Action title: the point of this block, not its topic ("啟動時間少了 42%", not "啟動時間").
- `note?`: string ≤60 — Faint caption on the right of the title: unit, scope or source.
- `pros`: string ≤50[] (≥1 ≤5)
- `cons`: string ≤50[] (≥1 ≤5)
- `verdict?`: string ≤100

```json
{"type":"proscons","title":"Vega-Lite 功能強，但要瀏覽器才畫得出來","pros":["圖表種類齊全","宣告式規格，bot 容易寫"],"cons":["產生時需要 headless 瀏覽器","輸出要帶 400 KB 執行檔"],"verdict":"留作進階選項，不當預設。"}
```

### `checklist`

A list of items with a status each, plus a done-count and a status bar.

**When:** Acceptance criteria, a release checklist, Done/Next/Blocked lists. ≤12 items; each label is a noun phrase, the note one line.

- `title?`: string ≤80 — Action title: the point of this block, not its topic ("啟動時間少了 42%", not "啟動時間").
- `note?`: string ≤60 — Faint caption on the right of the title: unit, scope or source.
- `items`: { label, status, note? }[] (≥1 ≤12)
  - `label`: string ≤40
  - `status`: "done" | "active" | "pending" | "blocked" | "risk" | "unverified" | "skipped" — done=完成(green) active=進行中(blue) pending=待處理(orange) blocked=受阻(red) risk=有風險(red) unverified=未驗證(grey) skipped=略過(faint)
  - `note?`: string ≤60

```json
{"type":"checklist","title":"4 項驗收已過 2 項，1 項受阻","items":[{"label":"任務面板 .11 安裝","status":"done"},{"label":"舊資料自動搬移","status":"done"},{"label":"Rust 後端接上 IPC","status":"active","note":"剩 3 個指令"},{"label":"手機版同步 bot 清單","status":"blocked","note":"等 API 修好"}]}
```

### `progress`

One to eight labelled progress bars (value of max).

**When:** How far each workstream has come (12 / 23 cards migrated). Use kpi for a single headline number, checklist for yes/no items.

- `title?`: string ≤80 — Action title: the point of this block, not its topic ("啟動時間少了 42%", not "啟動時間").
- `note?`: string ≤60 — Faint caption on the right of the title: unit, scope or source.
- `items`: { label, value, max?, unit?, status? }[] (≥1 ≤8)
  - `label`: string ≤30
  - `value`: number ≥0
  - `max?`: number
  - `unit?`: string ≤8
  - `status?`: "done" | "active" | "pending" | "blocked" | "risk" | "unverified" | "skipped" — done=完成(green) active=進行中(blue) pending=待處理(orange) blocked=受阻(red) risk=有風險(red) unverified=未驗證(grey) skipped=略過(faint)

```json
{"type":"progress","title":"Rust 遷移過半，手機版追上七成","items":[{"label":"Rust 後端指令","value":34,"max":52,"status":"active"},{"label":"手機版功能對齊","value":7,"max":10,"status":"active"},{"label":"元件卡片搬移","value":23,"max":23,"status":"done"}]}
```

### `steps`

An ordered sequence of 2–6 steps, each a short title with an optional one-line detail.

**When:** A procedure, a fix plan or "what happens next" in order. If the steps branch, use flow instead.

- `title?`: string ≤80 — Action title: the point of this block, not its topic ("啟動時間少了 42%", not "啟動時間").
- `note?`: string ≤60 — Faint caption on the right of the title: unit, scope or source.
- `items`: { title, text?, status? }[] (≥2 ≤6)
  - `title`: string ≤24
  - `text?`: string ≤70
  - `status?`: "done" | "active" | "pending" | "blocked" | "risk" | "unverified" | "skipped" — done=完成(green) active=進行中(blue) pending=待處理(orange) blocked=受阻(red) risk=有風險(red) unverified=未驗證(grey) skipped=略過(faint)

```json
{"type":"steps","title":"修復分三步，今天先做第一步","items":[{"title":"補回 bot 清單 API","text":"手機端改讀 /bots，不再只讀 Main","status":"active"},{"title":"加上回歸測試","text":"三個 bot 都要出現在側欄"},{"title":"實機驗收","text":"iPhone 與 Android 各跑一次"}]}
```

### `quote`

A short quotation with its source.

**When:** The user's own words or a log line that is the evidence itself. One sentence; never as decoration.

- `title?`: string ≤80 — Action title: the point of this block, not its topic ("啟動時間少了 42%", not "啟動時間").
- `note?`: string ≤60 — Faint caption on the right of the title: unit, scope or source.
- `text`: string ≤200
- `source?`: string ≤60

```json
{"type":"quote","text":"手機上只看得到 Main bot，其他 bot 都不見了。","source":"使用者回報 · 10/27 21:40"}
```

### `image`

A screenshot or figure with up to 6 numbered annotations placed at relative positions (0–1).

**When:** Showing the actual UI or output the text refers to. Annotate what to look at; alt text says what the image proves. src must be a data: URI or a path next to the spec file (inlined by the CLI).

- `title?`: string ≤80 — Action title: the point of this block, not its topic ("啟動時間少了 42%", not "啟動時間").
- `note?`: string ≤60 — Faint caption on the right of the title: unit, scope or source.
- `src`: string ≤4000000
- `alt`: string ≤160
- `caption?`: string ≤100
- `annotations?`: { x, y, label }[] (≤6)
  - `x`: number ≥0 ≤1
  - `y`: number ≥0 ≤1
  - `label`: string ≤40

```json
{"type":"image","title":"側欄只剩 Main bot","alt":"手機版側欄只列出一個 bot","src":"data:image/svg+xml;base64,…","annotations":[{"x":0.16,"y":0.13,"label":"只剩 Main"},{"x":0.6,"y":0.88,"label":"輸入框仍可用"}]}
```

### `sources`

Up to four one-line sources: a short reference (commit, file, run id) and what it shows.

**When:** At the end of a report, for the evidence that carries the conclusion. Four lines maximum; long logs stay out of the report.

- `title?`: string ≤80 — Action title: the point of this block, not its topic ("啟動時間少了 42%", not "啟動時間").
- `note?`: string ≤60 — Faint caption on the right of the title: unit, scope or source.
- `items`: { ref, text }[] (≥1 ≤4)
  - `ref`: string ≤40 — Commit, file, run or ticket id; shown as code.
  - `text`: string ≤60 — What this source establishes, in one line.

```json
{"type":"sources","items":[{"ref":"a58c883","text":"任務面板 .11 已安裝並開啟"},{"ref":"perf-run:1028","text":"同機同條件量測 5 次取中位數"}]}
```

## Lint budgets

- `takeawayUnits`: 30
- `tldrSentences`: 3
- `bullets`: 6
- `bulletDepth`: 2
- `proseUnits`: 300
- `calloutPerSection`: 1
- `visualsPerSection`: 2
- `visualsPerReport`: 8
- `tableRows`: 8
- `timelineItems`: 12
- `flowNodes`: 12
- `slidesPerSection`: 2
