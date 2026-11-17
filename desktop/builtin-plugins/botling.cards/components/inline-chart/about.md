圖表卡片: draws ONE small chart (bars, waterfall, dumbbell or line) inside a normal chat reply from a few lines of JSON: no Python, no chart library, same look in light and dark. Show it with `<show name="inline-chart">JSON</show>`.
Sizes: 2x2
Icon: chart.bar.xaxis
Built-in: yes

Use it when a number comparison is clearer than a sentence: model speed (bars), where the time went (waterfall), before / after (dumbbell), a trend over a few points (line, optional). Several charts = several `<show>` tags. The user does not answer it: it never calls `ccb.answer`, nothing comes back to the bot. A pinned copy keeps its icon and a short key value in the chip.

## Data format (window.ccb.data)

Example: `{"kind":"bars","title":"Haiku 5.5 比 Opus 5.5 快 3.1 倍","unit":"tokens/s","better":"higher","base":"Opus 5.5","items":[{"label":"Haiku 5.5","value":182},{"label":"Sonnet 5.5","value":96},{"label":"Opus 5.5","value":58}]}`

One JSON object (or a string of it). Common fields:

- `kind` (required): `bars` | `waterfall` | `dumbbell` | `line`.
- `title`: the CONCLUSION in one sentence ("Haiku 比 Opus 快 3.1 倍", not "速度比較"). It is what a one-cell Board tile shows.
- `unit`: shown once in the sub line, in the value labels of a waterfall and on the key number (`"tokens/s"`, `"ms"`, `"s"`, `"MB"`).
- `better`: `"higher"` or `"lower"`. Decides which bar is highlighted, the ×N direction and which dumbbell dots are blue (better) or orange (worse). Default: `higher` for bars and line, `lower` for waterfall and dumbbell.
- `note`: one short caption under the chart (what the numbers are: "範例數字" / source / how to read). Optional.

Rules: values are plain numbers ≥ 0 (no strings, no "1,200"); labels are short (they are cut with … at about 8–10 characters, no legend is drawn, every bar is labelled directly); at most 12 items per chart (more → the first 12 are drawn plus a small "+N more"; a line keeps the LAST 12 points and says how many earlier ones were left out). Order the items the way they should be read.

### bars (compare several things on one number)

`items[]`: `{label, value, hl?}`. `hl: true` forces the highlighted (blue) bar; without any `hl` the best item by `better` is highlighted. `base` (optional, an item's `label`): that item is marked 基準 and every other item gets a ×N label against it (for `better: "lower"` the ratio is base ÷ item, so ×N always means "N times better").
```
<show name="inline-chart">{"kind":"bars","title":"Haiku 5.5 比 Opus 5.5 快 3.1 倍","unit":"tokens/s","better":"higher","base":"Opus 5.5","items":[{"label":"Haiku 5.5","value":182},{"label":"Sonnet 5.5","value":96},{"label":"Opus 5.5","value":58},{"label":"Fable 5.2","value":41}],"note":"1,000 token 輸出的平均速度；越長越快。"}</show>
```

### waterfall (where the time went, step by step)

`steps[]`: `{label, value, hot?, start?}`. Each bar starts where the previous one ended; give `start` only for steps that overlap (run in parallel). `hot: true` marks the orange step; without any `hot` the largest step is orange and shows its share of the total. A 合計 row is added (the end of the last step, or the largest `start + value`). `better` is not used (shorter is always better).
```
<show name="inline-chart">{"kind":"waterfall","title":"首次開啟 2.4 秒，62% 卡在載入 plugin","unit":"ms","steps":[{"label":"啟動 Electron","value":180},{"label":"讀取設定","value":90},{"label":"載入 plugin","value":1480,"hot":true},{"label":"連線 bot","value":380},{"label":"首次繪製","value":250}],"note":"每條從上一步結束處開始；橘色是最大的一段。"}</show>
```

### dumbbell (before / after)

`rows[]`: `{label, before, after}`; `beforeLabel` / `afterLabel` (optional, default 前 / 後) name the two dots in the small key above the chart. The line between the dots is blue when `after` is better than `before` (by `better`) and orange when it is worse; the change in % is at the right of the row (the same value gives a grey, neutral row).
```
<show name="inline-chart">{"kind":"dumbbell","title":"三項變快，搜尋慢了 31%","unit":"ms","better":"lower","beforeLabel":"改前","afterLabel":"改後","rows":[{"label":"開啟聊天","before":820,"after":310},{"label":"載入歷史","before":600,"after":240},{"label":"切換 bot","before":450,"after":280},{"label":"搜尋","before":160,"after":210}],"note":"搜尋變慢要另外查。"}</show>
```

### line (optional: a trend)

`x[]`: the x labels (strings); `series[]`: 1–3 lines `{name, values[]}`, `values` the same length as `x` (the first line is blue, the second orange, the third grey; the first and last value of each line are labelled); `ref` (optional): a dashed reference line `{value, label}` such as a target.
```
<show name="inline-chart">{"kind":"line","title":"首次回應時間 5 週降了 46%","unit":"s","better":"lower","x":["W42","W43","W44","W45","W46"],"series":[{"name":"p50","values":[2.4,2.2,1.9,1.5,1.3]}],"ref":{"value":1.5,"label":"目標 1.5 s"},"note":"每週中位數；虛線是目標。"}</show>
```

## Wrong data

Invalid JSON, an unknown or missing `kind`, a wrong `better`, a missing / non-number / negative value, a `base` that is not an item, or lengths that do not match draws a small red-dashed error card saying what is wrong, where (`items[1].value`) and a minimal valid example for that kind; it is never blank, and the pin chip says 圖表資料錯誤. Fix the JSON and `<show>` it again. When you give the same `id` again (`<show name="inline-chart" id="speed">`) the card is updated in place.

## From command

(none: the bot writes the JSON; there is no Command, Refresh or Detail command.)

## Optional (bot only)

Everything above is written by the bot. Optional: `title`, `unit`, `better`, `note`, `base` and `hl` (bars), `hot` and `start` (waterfall), `beforeLabel` / `afterLabel` (dumbbell), `ref` (line).

## Display rules

- No card frame of its own: in the chat the reply's bubble is the frame, on the Board the tile and in a pin the panel. Full reply width and as tall as its content in the chat and in a pin. Fully transparent (no background, border, radius or shadow anywhere), so the card always matches the bubble / tile behind it; every colour (text, grid, axis, bars) comes from the host's theme tokens via the ccb-kit marker and follows the app's dark or light theme (blue = good / highlight, orange = hot / worse, grey = context).
- One responsive layout: narrow cards shrink the label column. A short Board tile (about one row high) shows the title and the first three rows. About one cell (under ~220px wide) shows just the title and the key number, big: bars → the best value, waterfall → the total and the hot step with its share, dumbbell → "3/4 變好" and the worst row, line → the last value and its change from the first.
- Pin chip: the icon with the key value (the same number, e.g. "182 tokens/s", "2,400 ms", "3/4 變好"); orange dot when something got worse, green when all got better.
