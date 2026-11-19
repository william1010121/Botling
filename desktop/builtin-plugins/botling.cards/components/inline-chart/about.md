圖表卡片: draws ONE small chart inside a normal chat reply from a few lines of JSON (no Python, no chart library, same look in light and dark); use `stacked` for progress per group (done / remaining / cancelled, ETA in the label), `targets` for several items against one shared target or cap (e.g. spent and forecast vs a CCU cap), `bars` to compare values (with low/high ranges or groups), `line` for a trend, `waterfall` for steps adding up to a total, `dumbbell` for before → after. Show it with `<show name="inline-chart">JSON</show>`.
Sizes: 2x2
Icon: chart.bar.xaxis
Built-in: yes

Use it when a number comparison is clearer than a sentence: model speed (bars), values that span several orders of magnitude such as cost per run (bars with `log: true`, or `kind: "bars-log"`), where the time went (waterfall), before / after (dumbbell), a trend over a few points (line, optional), several measurements against one goal (targets: median and p90 per row vs a target line), progress split into parts per group (stacked: done / remaining / cancelled per row on one axis). Several charts = several `<show>` tags. Interactive: hovering, tapping or tabbing to a bar / row / point shows a small tooltip with the full label, the exact value with its unit and the change against the base (others dim). The user does not answer it: it never calls `ccb.answer`, nothing comes back to the bot. A pinned copy keeps its icon and a short key value in the chip.

## Data format (window.ccb.data)

Example: `{"kind":"bars","title":"Haiku 5.5 比 Opus 5.5 快 3.1 倍","unit":"tokens/s","better":"higher","base":"Opus 5.5","items":[{"label":"Haiku 5.5","value":182},{"label":"Sonnet 5.5","value":96},{"label":"Opus 5.5","value":58}]}`

One JSON object (or a string of it). Common fields:

- `kind` (required): `bars` | `waterfall` | `dumbbell` | `line` | `targets` | `stacked`; `bars-log` is an alias for `bars` with `log: true`.
- `title`: the CONCLUSION in one sentence ("Haiku 比 Opus 快 3.1 倍", not "速度比較"). It is what a one-cell Board tile shows.
- `unit`: shown once in the sub line, in the value labels of a waterfall and on the key number (`"tokens/s"`, `"ms"`, `"s"`, `"MB"`).
- `better`: `"higher"` or `"lower"`. Decides which bar is highlighted, the ×N direction and which dumbbell dots are blue (better) or orange (worse). Default: `higher` for bars and line, `lower` for waterfall and dumbbell. Not used by targets (over the target is always worse).
- `note`: one short caption under the chart (what the numbers are: "範例數字" / source / how to read). Optional.
- `items`: works as the main array on EVERY kind, as an alias for that kind's own field (`steps` for waterfall, `rows` for dumbbell and stacked, `series` for line; bars also accept `rows` as an alias of `items`); when both are given the kind's own field wins. For line, `items` is used only when every element has the series shape `{name, values[]}` (a line needs `x[]` plus per-line value arrays, so `{label, value}` items do not fit it). Error messages name the field you actually used (`items[1].value`).

Rules: values are plain numbers ≥ 0 (no strings, no "1,200"); keep labels short when you can, but long ones are fine: the label column grows to the longest label (up to about 40% of the width, 34% for dumbbell), longer labels wrap to two lines and only then end with …, and the full label is always in the tooltip (every bar is labelled directly; a legend only names bars groups / ranges, dumbbell dots, targets marks and stacked segments); at most 12 items per chart (more → the first 12 are drawn plus a small "+N more"; a line keeps the LAST 12 points and says how many earlier ones were left out). Order the items the way they should be read (or let bars sort them with `sort`).

### bars (compare several things on one number)

`items[]` (or `rows[]`): `{label, value, n?, hl?, low?, high?, group?}`. `n` (optional, a number ≥ 0): the sample size behind the value, shown small after it (`$0.0025 n=60`) and in the tooltip. `hl: true` forces the highlighted (blue) bar; without any `hl` the best item by `better` is highlighted, and when several items tie for the best value ALL of them are blue (the tooltip says 並列 N 項). `base` (optional, an item's `label`): that item is marked 基準 and every other item gets a ×N label against it (for `better: "lower"` the ratio is base ÷ item, so ×N always means "N times better").
```
<show name="inline-chart">{"kind":"bars","title":"Haiku 5.5 比 Opus 5.5 快 3.1 倍","unit":"tokens/s","better":"higher","base":"Opus 5.5","items":[{"label":"Haiku 5.5","value":182},{"label":"Sonnet 5.5","value":96},{"label":"Opus 5.5","value":58},{"label":"Fable 5.2","value":41}],"note":"1,000 token 輸出的平均速度；越長越快。"}</show>
```

Ranges, groups and sort for bars (all optional; without them bars look exactly as above):
- `low` / `high` per item (numbers ≥ 0, or null): an asymmetric range whisker (thin line with end caps) is drawn over the bar from `low` to `high`; the axis reaches the largest `high`, so no whisker is clipped, and the value label sits just past the whisker's high end. Both null (or missing) = no range, just the bar; only one given = that side only (the other side stops at the value). `low` must not exceed `high`. The tooltip adds `範圍 37.7–112 card-hours`. Works with `log: true` (then `low` must be > 0).
- `group` per item (a string): when any item has one, bars are coloured by group instead of the best-item highlight (blue for the first group, orange for the second, then green, grey, red-hatched) and a small legend names the groups (plus a 範圍 key when any item has a range; with ranges and no groups the legend is just 範圍). Group order: top-level `groups: [{key, label, tone}]` first (`label` is the name shown in the legend and tooltip, e.g. `{"key":"current","label":"現有模型"}`; `tone` one of `accent` (blue) | `warn` (orange) | `good` (green) | `neutral` (grey) | `bad` (red hatch)), then other group strings in order of appearance, shown as given. An item without `group` is grey. `hl: true` still marks an item (a ring around its bar, bold label) and `base` still adds ×N labels; the tooltip names the item's group.
- `sort` (top-level): `"desc"` (largest value first) or `"asc"`; default keeps the given order. Sorting happens before the 12-item cut.
```
<show name="inline-chart">{"kind":"bars","title":"GBWAtt 最花時間（約 58 card-hours），候選模型都在 10 以下","unit":"card-hours","better":"lower","sort":"desc","groups":[{"key":"current","label":"現有模型"},{"key":"candidate","label":"候選模型"}],"rows":[{"label":"EEGNeX","value":46.4,"low":22.9,"high":129,"group":"current"},{"label":"GBWAtt","value":57.7,"low":37.7,"high":112,"group":"current"},{"label":"MAtt","value":31.2,"low":18.5,"high":64,"group":"current"},{"label":"TSMNet","value":12.8,"low":8.1,"high":21.4,"group":"current"},{"label":"MF","value":19.5,"low":null,"high":null,"group":"current"},{"label":"ShallowConvNet","value":6.0,"low":null,"high":null,"group":"candidate"},{"label":"EEGNet","value":8.3,"low":4.2,"high":15.6,"group":"candidate"}],"note":"card-hours = 2080 Ti 等效卡時；條長是中心估計，細線是低–高範圍。"}</show>
```

Log scale for bars: `"log": true` (or `"kind": "bars-log"`) draws the bar length on a log axis with one gridline per decade (×10 per gridline: $0.001 / $0.01 / $0.1 under the last bar); the axis starts at the decade below the smallest value and the largest value's bar is full length, so 0.0025 and 0.1372 are both readable. Every value must be > 0. Bars never switch to log by themselves: only with `log: true` (or the alias). The sub line says 對數刻度（每格 ×10）.

Number format for bars: `decimals` (optional, an integer 0–8) fixes the digits after the point for every value. A `unit` of `"USD"` or `"$"` adds a `$` prefix (the unit is then not repeated after each value) and, without `decimals`, uses enough digits that the smallest value keeps two significant digits, the same for the whole chart (smallest 0.0025 → 4 decimals: `$0.0025`, `$0.0340`, `$0.1372`; smallest ≥ 0.1 → 2 decimals). Other units keep the default (integers with thousands separators, otherwise up to 2 decimals). For costs give `"better": "lower"` so the cheapest bar is the blue one (without it the highest is highlighted).
```
<show name="inline-chart">{"kind":"bars-log","title":"每列中位數花費（美元）","unit":"USD","better":"lower","log":true,"items":[{"label":"card haiku low","value":0.0025,"n":60},{"label":"card haiku high","value":0.003,"n":60},{"label":"card sonnet medium","value":0.034,"n":60},{"label":"card opus medium","value":0.0676,"n":60},{"label":"direct opus medium","value":0.1372,"n":30}]}</show>
```

### waterfall (where the time went, step by step)

`steps[]` (or `items[]`): `{label, value, hot?, start?}`. Each bar starts where the previous one ended; give `start` only for steps that overlap (run in parallel). `hot: true` marks the orange step; without any `hot` the largest step is orange and shows its share of the total (every step that ties for the largest is orange). A 合計 row is added (the end of the last step, or the largest `start + value`). `better` is not used (shorter is always better).
```
<show name="inline-chart">{"kind":"waterfall","title":"首次開啟 2.4 秒，62% 卡在載入 plugin","unit":"ms","steps":[{"label":"啟動 Electron","value":180},{"label":"讀取設定","value":90},{"label":"載入 plugin","value":1480,"hot":true},{"label":"連線 bot","value":380},{"label":"首次繪製","value":250}],"note":"每條從上一步結束處開始；橘色是最大的一段。"}</show>
```

### dumbbell (before / after)

`rows[]` (or `items[]`): `{label, before, after}`; `beforeLabel` / `afterLabel` (optional, default 前 / 後) name the two dots in the small key above the chart. The line between the dots is blue when `after` is better than `before` (by `better`) and orange when it is worse; the change in % is at the right of the row (the same value gives a grey, neutral row).
```
<show name="inline-chart">{"kind":"dumbbell","title":"三項變快，搜尋慢了 31%","unit":"ms","better":"lower","beforeLabel":"改前","afterLabel":"改後","rows":[{"label":"開啟聊天","before":820,"after":310},{"label":"載入歷史","before":600,"after":240},{"label":"切換 bot","before":450,"after":280},{"label":"搜尋","before":160,"after":210}],"note":"搜尋變慢要另外查。"}</show>
```

### line (optional: a trend)

`x[]`: the x labels (strings); `series[]` (or `items[]` with the same shape): 1–3 lines `{name, values[]}`, `values` the same length as `x` (the first line is blue, the second orange, the third grey; the first and last value of each line are labelled); `ref` (optional): a dashed reference line `{value, label}` such as a target.
```
<show name="inline-chart">{"kind":"line","title":"首次回應時間 5 週降了 46%","unit":"s","better":"lower","x":["W42","W43","W44","W45","W46"],"series":[{"name":"p50","values":[2.4,2.2,1.9,1.5,1.3]}],"ref":{"value":1.5,"label":"目標 1.5 s"},"note":"每週中位數；虛線是目標。"}</show>
```

### targets (median and p90 per row against one target)

`items[]` (or `rows[]`): `{label, median, p90}` (p90 ≥ median); `target` (required): one number, drawn as ONE dashed vertical line across all rows and labelled 目標 N unit; `unit`: ONE unit per chart (draw seconds and milliseconds as two charts, convert before you send); `log` (optional): `true` = log scale, `false` = never log; without it the chart switches to log by itself when the largest of all values (target included) is more than 20× the smallest, and says so in the key (對數刻度（最大是最小的 N 倍）) and on the axis (`s · 對數`). Log needs every value > 0. Each row: label, a thin track, median = filled dot, p90 = hollow diamond, joined by a line, then `median / p90` at the right. Colours: median over the target = red (bad), only p90 over = orange (warn), both within (≤ target) = blue (ok). A small key above lists median ● · p90 ◇ · 目標 ┆ and the colour states present. Put the conclusion in `title`.
```
<show name="inline-chart">{"kind":"targets","title":"兩項都超過 10 s 目標，p90 約是目標的 3 倍","unit":"s","target":10,"items":[{"label":"冷啟到 core.ready","median":13.1,"p90":26.8},{"label":"重啟到可用","median":14.7,"p90":30.6}]}</show>
```

### stacked (horizontal stacked bars: parts of a total per row)

`items[]` (or `rows[]`): `{label, <segment key>: number, …}`, one row per group, drawn top to bottom. `segments` (optional): the parts, left to right, `[{key, label, tone}]`; `key` is the row field holding the number, `label` its name in the legend and tooltip (default: the key), `tone` one of `good` (green) | `neutral` (grey) | `bad` (red, diagonal hatch) | `accent` (blue) | `warn` (orange); 1–6 segments. Without `segments` the default is `[{"key":"done","label":"完成","tone":"good"},{"key":"remaining","label":"剩餘","tone":"neutral"},{"key":"cancelled","label":"取消","tone":"bad"}]`, so rows `{label, done, remaining, cancelled}` work directly. A missing, null or 0 segment draws nothing. All rows share ONE linear axis in `unit` (ticks and the unit under the last row; never log, a short bar stays short but always keeps its numbers): every bar is as long as its row total. Beside each bar: `first / total` (the first segment, e.g. `86 / 324`), or `972 全部完成` when the first segment is the whole row, plus every `bad` segment in red (`取消 127`); a segment's own number is drawn inside it only when the row has two or more parts and the number fits. A small legend names the segments that appear, with 單位 `unit`. Put estimates such as a finish date into the `label`: long labels wrap to two lines then end with …, the full label is in the tooltip. The key number (one-cell tile, pin chip) is the first segment's share of all rows' totals (`25% 完成`; green when 100%).
```
<show name="inline-chart">{"kind":"stacked","title":"已完成 2,509 / 9,909 runs，跨任務 6,741 還沒開始","unit":"runs","items":[{"label":"OpenBMI 跨 session（MAtt/MF/TSMNet）· 11/23–25","done":972,"remaining":0,"cancelled":0},{"label":"OpenBMI 跨 subject MAtt · 11/23–25","done":86,"remaining":238,"cancelled":0},{"label":"OpenBMI 跨 subject MF · 11/23–25","done":86,"remaining":238,"cancelled":0},{"label":"OpenBMI 跨 subject TSMNet · 11/23–25","done":197,"remaining":0,"cancelled":127},{"label":"Stieger 跨 session（三模型）· 11/19–20","done":1116,"remaining":0,"cancelled":0},{"label":"Stieger 跨 subject MAtt · 11/19–20","done":17,"remaining":19,"cancelled":0},{"label":"Stieger 跨 subject MF · 11/19–20","done":17,"remaining":19,"cancelled":0},{"label":"Stieger 跨 subject TSMNet · 11/19–20","done":18,"remaining":0,"cancelled":18},{"label":"跨任務（7 模型 × 4 資料集，待審核）· 審核後約 6–7 夜（推估，可能差 3 倍）","done":0,"remaining":6741,"cancelled":0}],"note":"每列標籤後是估計完成日期；斜線紅是已取消的 runs。"}</show>
```
Own segments: `{"kind":"stacked","title":"…","unit":"jobs","segments":[{"key":"ok","label":"成功","tone":"good"},{"key":"running","label":"執行中","tone":"accent"},{"key":"failed","label":"失敗","tone":"bad"}],"rows":[{"label":"nightly","ok":40,"running":3,"failed":2}]}`. To keep a progress card current, give it an `id` and `<show>` the same id again with new numbers.

## Interaction

Every bar (bars), step and the 合計 row (waterfall), row (dumbbell, targets) and x position (line) is an item: mouse hover, a tap, or keyboard focus (Tab, then the arrow keys to move, Esc to close) shows one small tooltip and dims the other items. Nothing is sent anywhere. The tooltip shows:
- bars: full label, its group (when grouped), value + unit (and `· n=60` when `n` is given), `範圍 low–high unit` when it has a range; 最高 / 最低 (並列 N 項) on the highlighted items; with `base` the difference against it (`比基準 Opus −17 tokens/s（−29%）· ×0.7`, blue when better, orange when worse); without `base` the difference against the best.
- waterfall: full label, value + unit, its share of all steps, and from → to; on 合計 the step count (and the plain sum when steps overlap).
- dumbbell: full label, before → after + unit, the change (+50 ms（+31%）· 變差).
- line: the x label, every line's value there; the first line's distance to `ref` and its change from the point before.
- stacked: hovering / tapping a row (or Tab to it) shows the full label, `first / total` + unit with its share, and every part with its value and share of the row; hovering / tapping one segment shows just that part: row label, segment name, value + unit, its share of the row and the row total (the other segments dim).
- targets: full label, median and p90 + unit, the target, and for each of median / p90 how far over it is (`median 超標 +3.1 s（目標的 1.3×）`, red; p90 orange) or how far within (blue).

## Wrong data

Invalid JSON, an unknown or missing `kind`, a wrong `better`, a missing / non-number / negative value, a `base` that is not an item, lengths that do not match, a missing `target`, a p90 below its median, a stacked `segments` entry without `key`, with a repeated key or an unknown `tone`, a `log` that is not true / false, a `decimals` that is not an integer 0–8, a bars `low` above its `high`, a `sort` other than desc / asc, a `groups` entry without `key` or with an unknown `tone`, or a 0 on a log scale (targets or bars) draws a small red-dashed error card saying what is wrong, where (`items[1].value`) and a minimal valid example for that kind; it is never blank, and the pin chip says 圖表資料錯誤. Fix the JSON and `<show>` it again. When you give the same `id` again (`<show name="inline-chart" id="speed">`) the card is updated in place.

## From command

(none: the bot writes the JSON; there is no Command, Refresh or Detail command.)

## Optional (bot only)

Everything above is written by the bot. Optional: `title`, `unit`, `better`, `note`, `base`, `hl`, `n`, `log`, `decimals`, `low` / `high`, `group`, `groups` and `sort` (bars), `hot` and `start` (waterfall), `beforeLabel` / `afterLabel` (dumbbell), `ref` (line), `log` (targets), `segments` (stacked).

## Display rules

- No card frame of its own: in the chat the reply's bubble is the frame (drawn at exactly the reply's text width, no side inset), on the Board the tile and in a pin the panel. As tall as its content in the chat and in a pin; the line chart has a fixed plot height. Fully transparent (no background, border, radius or shadow anywhere; only the error card has its own tinted box), so the card always matches the bubble / tile behind it; every colour comes from one set of semantic variables (`--t-foreground`, `--t-muted-foreground`, `--t-border`, `--t-chart-1`…`--t-chart-6` …) mapped onto the host's theme tokens via the ccb-kit marker, and follows the app's dark or light theme (blue = good / highlight, orange = hot / worse, grey = context).
- One responsive layout: narrow cards shrink the label column. A short Board tile (about one row high) shows the title and the first three rows. About one cell (under ~220px wide) shows just the title and the key number, big: bars → the best value, waterfall → the total and the hot step with its share, dumbbell → "3/4 變好" and the worst row, line → the last value and its change from the first, stacked → the first segment's share ("25% 完成") over "2,509 / 9,909 runs", targets → "2/5 超標" (red when a median is over, orange when only p90s are, blue 全部達標) and the row with the highest p90. A short tile keeps the over-target rows first. In a narrow card (under ~380px) each targets label moves above its track.
- Pin chip: the icon with the key value (the same number, e.g. "182 tokens/s", "2,400 ms", "3/4 變好", "2/5 超標", "25% 完成"); orange dot when something got worse (or a p90 is over target), red when a targets median is over, green when all got better / all within target / a stacked chart is 100% done.
