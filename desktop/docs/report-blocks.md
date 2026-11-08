# Botling report blocks (ReportSpec v2)

> Generated from `desktop/reports/v2/promptdoc.ts` and `desktop/reports/v2/blocks` by `node desktop/scripts/report.mjs --docs`. Do not edit by hand.

A report is JSON: header + `tldr` + `sections[] → blocks[]` + `asks`. You pick the blocks; layout, colours, fonts and the slide version are decided by the renderer. Write key points only.

## Rules

Readers skim: most read only the verdict card and the section headlines. Write so that reading only those gives the answer, its meaning and what to decide; put the evidence below for whoever needs it.

1. **Answer first (BLUF).** The first `tldr` sentence is the conclusion and answers the user's question ("You asked X; the answer is Y"); never background, never "this report…". If it cannot, do not publish the page: answer in chat. `tldr` ≤ 3 sentences.
2. **The first page holds five things.** The verdict card shows (1) `tldr`: one-sentence status or result; (2) `impact`: what it means for the goal, in the reader's terms (users, time, money, the research question); (3) `asks` (what, who, by): the decision or help needed, shown right under the card — or `"asks": []` for "No action needed"; (4) `risk` (text, plan): the biggest risk and what is done about it; (5) `next`: ≤ 3 next steps, even tentative ones. Reading only the card, the reader can say the status, the impact and what they must decide. In every report the card comes first; in an `experiment` report the flowcharts and the complete-results chart follow it (see that kind).
3. **Headline = takeaway.** Every section has `takeaway`: its conclusion as one sentence (≈ 22 CJK chars / 15 words in `status`/`plan`/`decision`; up to 48 units in `investigation`/`explainer`/`results`/`comparison`/`experiment`). Write "登入延後 1 週，原因是 API 限流", never a topic such as "進度說明" or "結果". `title` is the short topic label. Reading only the takeaways in order gives the whole argument.
4. **Charts first, detail collapsed (以圖為主，細節收起來).** The page reads as units of "a chart + a short explanation under it": the chart's action title says the point, its `caption` (or one or two sentences of `prose`) says how to read it and what it means. Layer 1, for everyone: the verdict card. Layer 2: the main sections — the flowcharts, then the key charts. Layer 3, for whoever needs it: supporting detail in sections with `"collapsed": true` (rendered below the main part as closed `<details>`): baseline / sanity checks, limitations, per-model breakdowns, tables of exact values, glossary, reproducibility, sources. In the main part: no table of numbers (make it a figure; the exact values go in a collapsed table), ≤ 3 bullets per list, ≤ 1 callout. One idea per section; ≤ 2 charts per section, ≤ 8 in the report.
5. **Plain language before jargon: define every term once (先講人話，術語首次定義).** Say the plain question, setup and everyday answer before the numbers. Each acronym, model or dataset name, and metric symbol (`κ`, `Δκ`, SESS, LOSO, whitening / 白化) gets one plain sentence or everyday analogy the first time it appears: a `glossary` block in the first section, or the plain words first with the term in brackets ("留一受試者驗證（LOSO）"). Use the same word for the same thing everywhere; prefer an everyday word to an acronym. Never stack unexplained acronyms in `title`, `tldr` or `takeaway`. Plain language is writing for your reader, not lowering the level.
6. **Every number has a reference point and a meaning.** Give the comparison (plan, previous version, last week, chance level, the paper's score) and the unit, then say what the gap means in the reader's units: not "準確率 92%" but "92%（現行規則 85%）：每 100 張多抓對 7 張". Prefer "done / not done + expected date" to "80% done". Show what changed since the last report rather than repeating its history.
7. **One question per chart + one-sentence reading guide (一張圖只回答一個問題＋一句看圖指南).** Every chart has an action title stating its conclusion and direct labels; never repeat a KPI as a chart. Never cram two scales, baselines or questions into one figure: split them. Give each non-trivial chart a one-sentence reading guide (`note` or a short `prose`) saying what taller / shorter or left / right of `0` means, and what n and the error bars are. Axes start at 0 for amounts; no decoration that carries no data.
8. **Every chart is drawn by Python: a matplotlib `figure`, never hand-written SVG (所有圖表都用 Python 畫；SVG 已停用).** The renderer draws no chart of its own. Every chart of data — comparisons, signed deltas against chance or a target, trends over time, before/after, shares, heatmaps, per-subject scores, small multiples, scatter, distributions, error bars, curves — is a `figure` block: your own matplotlib `.py` script that reads the data from the result files (never numbers typed into the script); the renderer runs it and embeds the chart (see "Figures (matplotlib)"). A process diagram — the pipeline, how data is split, what is compared — is a `figure` too, with `role: "flowchart"`, drawn by the `flowchart.py` template in the clean-flowchart style (rounded boxes, right-angle arrows, colour only where it means a category). Each chart appears once: the same script with the same args twice is warned. Exact values the reader looks up go in a `table` in a collapsed section; headline numbers in `kpi`. The old native chart blocks (`bar`, `trend`, `donut`, `beforeafter`, `quadrant`) are no longer drawn — older specs show their values as a plain table, with a warning; a `matrix` of numbers shows plain values; `kpi` sparklines are not drawn; SVG images (`image` with an `.svg` or `data:image/svg+xml` source) are disabled and shown as their alt text. `image` is for PNG / JPEG screenshots only.
9. **Use ASD-STE100-informed plain language.** Active voice, direct verbs, "who does what", consistent terms. Prefer short sentences, but keep a cause and its effect in one sentence: "X 因為 Y，所以 Z" stays whole; never cut a causal chain into fragments or drop the "because" to save length, and never cut background the reader needs to follow the argument. Keep useful technical names. These are writing guidelines, not renderer checks or formal ASD-STE100 compliance for Chinese.
10. **Explain uncertainty.** Separate verified facts from pending inferences. Give the reason for each inference and state what remains unchecked. Do not assign mechanical confidence percentages. Use numerical probabilities only when supported by a stated method and evidence.
11. **Explain causes visually.** For multistep causes, prefer a flowchart plus a table of evidence. Show how each step leads to the next. Distinguish observed links from pending inferences; do not invent links to complete the diagram.
12. **Be honest early.** Bad news and the biggest risk go on the first page, never the last line. Report outcomes, not activity ("讓客服一鍵查訂單，處理時間 6 → 4 分鐘", not "開了 5 場會、改了 30 個 PR"). A yellow or red `status` needs a road to green (who does what, by when), whether the team can recover alone, and an ask. Describe problems by activity and fix, never by naming a person (blameless). Do not paint red as amber.
13. **Math (LaTeX).** Every text field (prose, bullets, table cells, captions, callouts, slides) typesets LaTeX offline: inline `$x^2$` or `\(x^2\)`, display `$$\frac{a}{b}$$` or `\[…\]`. In JSON double every backslash: `"text": "比值 $\\frac{a}{b}$"`. A price like "$4 and $20" stays text (the `$` needs a non-space inside both ends and no digit right after the closing one); write `\\$` for a literal dollar next to math. Bad TeX shows as muted source, never breaks the page. Not inside `code`; figure images use matplotlib `$…$` instead.
14. **Write for the reader.** Omit routine defensive boilerplate and internal coordination jargon. Keep research-only handback details, test commands, and preview-tool details in the internal handback. Evidence is short: a short source and a number per claim, ≤ 4 `sources`, no long paths, hashes or logs in prose. State material uncertainty and failed checks that affect the decision, with their practical effect. Never conceal defects or claim unperformed validation.
15. **Experiments (ML / deep learning): see kind `experiment`.** The order is fixed: the verdict card (the answer, impact, risk, next) → one or more flowcharts of the pipeline → the setup (`overview`, shown collapsed) → the complete-results chart (small multiples: one row of panels per compared condition that has data, one panel per model, shared y axis; one thin line per unit from baseline to method, blue = better, orange = worse; the mean as a thick line with its two values labelled; fully trained runs only; conditions not run are one sentence in the caption, never an empty panel) → the gaps with their intervals as a chart → the experiment cards, each with its own chart → collapsed detail (checks, exact values, under-trained runs as a contrast, limitations, reproducibility). State the question, a falsifiable hypothesis and the success criterion before the results. Compare with an equally tuned baseline on the same data split, preprocessing, seeds and training length; change one thing at a time. Run ≥ 3 seeds and give mean ± std, saying what ± is (std or SE, across seeds or subjects, n). A gap inside the variance, or an interval that crosses 0, is "not significant", never "an improvement". Report error analysis, ablations and negative results ("what we ruled out, what it saved, what next"); do not generalise beyond the data you tested.
16. **Forbidden:** topic-only headings, narrating your process chronologically, the conclusion at the end, activity lists instead of outcomes, evidence dumps, decorative charts, numbers with no baseline, unexplained acronyms, best-seed-only results, one-sided options, vague hedging, mixing report kinds.

## Checked by the renderer (warnings)

These come back in `warnings` with a path; fix them before delivering:

- the first `tldr` sentence opens with background ("本報告…", "為了…", "We ran…") instead of the answer;
- a missing first-page item: `impact` (status, decision, investigation, results, experiment), `risk` (status, plan, experiment), `next` (status, plan, experiment); a yellow / red `status` without `status.reason` or with `"asks": []`;
- a `takeaway` that is a topic ("結果", "進度說明", or the same as `title`), missing, or over the length budget;
- a number in `tldr`, `impact` or a `takeaway` with nothing to compare it to (no baseline, change, target, chance level or sign);
- an acronym, coined name (two or more capitals: LOSO, SESS, OpenBMI) or Greek symbol (κ, Δκ) used without a definition — in a `glossary` block, or written "plain words（TERM）" / "TERM（plain words）" where it first appears;
- kind `experiment` without `overview` (its `complete` field is required), without a flowchart (`figure` with `role: "flowchart"`; one or more are fine), or whose first data chart (flowcharts aside) is not a `figure` with `perUnit: true`;
- in the main (not collapsed) part: a table of numbers (make it a figure; exact values go in a collapsed section), a bullet list longer than 3 items, more than 1 callout; in `experiment` reports, a main section with no chart;
- the same figure (script and args) drawn twice, in figure blocks or experiment cards;
- kind `experiment` without an `experiment` block; an experiment card with < 3 runs, no `baselineTuned: true`, no `result.ci`, or verdict "supported" while the interval crosses 0; a `tldr` that claims an improvement while a card is inconclusive; experiment KPIs without delta or target;
- a native chart block (`bar`, `trend`, `donut`, `beforeafter`, `quadrant`), a `matrix` of numbers, a `kpi` sparkline or an SVG image: draw it as a `figure` instead;
- the budgets below (bullets, prose length, table rows, charts per section, chart titles, slides per section).
- Each layout warning carries an `example`: a valid block or section to copy.

## Not checked: rules only

- whether the first sentence is really the answer to the user's question, and whether the `impact` is in the reader's terms;
- cause and effect kept together, one idea per section, the takeaways read in order as a summary;
- whether a definition is plain enough for a non-specialist to repeat it;
- whether the baseline is fair (same tuning budget, split, preprocessing), the test set was used once, and normalisation or feature selection was fitted on training folds only (no leakage);
- error analysis, per-group (per-subject) breakdown, ablations and negative results — the skeleton for `experiment` asks for them;
- whether every number can be traced to a run or a data source.

## Before you publish

- [ ] Reading only the verdict card, a lead can say the status, the impact and what they must decide.
- [ ] A reader outside the field can repeat the main point in their own words; every term is defined once.
- [ ] Every number has a baseline and a unit; key metrics are translated into consequences ("每 100 件…").
- [ ] ML results name the number of seeds and what the error bar is; gaps inside the variance are not called improvements.
- [ ] An experiment report opens with the answer, then one or more flowcharts of the pipeline, then the complete results per condition (each unit before → after, one panel per model; nothing empty drawn).
- [ ] Each chart makes one point, its title states it, a sentence under it says how to read it; nothing is decorative and no chart appears twice.
- [ ] Every chart follows "Chart design": no empty panels, small multiples instead of crowding, direct labels, blue / orange for better / worse, readable fonts, no overlaps — checked by looking at the rendered page in light and dark.
- [ ] The main part is charts and short explanations; checks, limitations, exact-value tables and the glossary sit in collapsed sections.
- [ ] Bad news and the biggest risk are on the first page; yellow / red items have a road to green and an ask.
- [ ] Negative results say what was ruled out and what comes next; every number traces to a run or source.

## Page template: charts first

Every report: the verdict card (the one-sentence answer, impact, risk, next) and the asks → main sections, each a chart with its explanation under it → collapsed sections for supporting detail. Sections marked `"collapsed": true` are always shown after the main ones, closed; the reader opens them.
Experiment report, the sections in order (the setup in `overview` appears collapsed after the first one):

```json
{"title":"流程","takeaway":"兩條路只差有沒有先做 SESS，其餘相同","blocks":[{"type":"figure","role":"flowchart","title":"…","script":"flowchart.py","args":["pipeline.json"],"alt":"…","caption":"…"},{"type":"figure","role":"flowchart","title":"…","script":"flowchart.py","args":["split.json"],"alt":"…","caption":"…"}]}
{"title":"完整結果","takeaway":"…","blocks":[{"type":"figure","perUnit":true,"title":"…","script":"per_subject.py","args":["complete_results.csv"],"alt":"…","caption":"…","missing":["…"]}]}
{"title":"差距","takeaway":"…","blocks":[{"type":"figure","title":"…","script":"gaps.py","args":["cells.csv"],"alt":"…","caption":"…"}]}
{"title":"實驗卡","takeaway":"…","blocks":[{"type":"experiment","…":"…","figure":{"script":"paired.py","args":["complete_results.csv","ROW","COL","MODEL"],"alt":"…","caption":"…"}}]}
{"title":"名詞","takeaway":"…","collapsed":true,"blocks":[{"type":"glossary","items":["…"]}]}
{"title":"基準檢查","takeaway":"…","collapsed":true,"blocks":[{"type":"table","columns":["…"],"rows":["…"]}]}
{"title":"精確數值","takeaway":"…","collapsed":true,"blocks":[{"type":"table","columns":["…"],"rows":["…"]}]}
{"title":"限制與重現","takeaway":"…","collapsed":true,"blocks":[{"type":"prose","text":"…"},{"type":"sources","items":["…"]}]}
```

Status, decision, plan, results: the same idea — the key charts (or the options) in the main part, the engineer-level detail (per-item tables, technical notes, alternatives, references) in collapsed sections.

## Chart design (every figure)

- **One message per chart.** The block `title` states the finding ("顯著變好的只有 2a 跨受試者的 MAtt 與 SPD-MetaFormer"); the plot carries no title of its own, and no statistics are stuffed into panel titles — panel titles are short names (the model). Numbers that matter are direct labels on the plot.
- **Never draw an empty panel.** A condition without results (未跑) is not a panel: it is one sentence in the caption (and `missing`). Never let missing data take half the figure.
- **Pick the form by the question.** Before → after per unit: a slope chart — one thin line per unit, small multiples with one panel per model and a shared y axis (template `per_subject.py`). Is a gain real: a dot + interval plot of the differences with 0 drawn (`paired.py`, or a forest plot of mean ± 95% interval per comparison). Change between two states per category: a dumbbell (two dots joined by a line). Amounts: bars from 0. Over time: lines. Never a pie for close values, never two y axes, never 3D.
- **Small multiples instead of crowding.** Several models or conditions → one small panel each, same axes, rather than many colours in one panel. ≤ 3 colours carry meaning in a chart.
- **Colour has one job.** The theme colours (`C0`…`C5`) follow light and dark mode. Better / worse (or method / baseline) = `C0` blue / `C1` orange — validated colour-blind safe in both modes; grey `C5` = context, not significant, reference. Never red / green as a pair. Text stays in the text colour: the value labels, keys and annotations are ink, a coloured mark beside them carries the identity.
- **Direct labels before legends.** Label the series or the mean on the plot (at the line end, beside the bar); when a key is needed, one line of words above the plot. Label selectively — the mean, the extremes, the one that matters — never a number on every point.
- **Sort meaningfully.** Categories by value (largest gain on top) or by a natural order, never alphabetically by accident.
- **Readable size.** Draw at the page width: `figsize` 9 in wide (a card or a single panel: 9 × 2.5–4.5; small multiples: about 3 in per panel); fonts are the theme's (12 pt, ≥ body text) — never shrink them. A figure is never shown larger than 1.25× its drawn size, so a small figsize gives a small chart.
- **Recessive chrome.** Light grid, no top / right spines (the theme does this), reference lines (0, chance, target) thin and labelled, marks thin and rounded.
- **No overlaps.** Labels never sit on lines, on the 0 line or on each other; place them on the side with room. Render the page and look at every chart in light and dark before delivering.
- **One chart once.** Each question is drawn once; a second chart answers a different question (e.g. the complete results show levels per unit; a card shows whether the gain is real).

## Figures (matplotlib)

A `figure` block names a `.py` script (absolute, or relative to the spec file) and optional `args`. When the page is rendered the script runs as `python3 -I` (or `$BOTLING_PYTHON`) with the spec's folder as working directory; your user site-packages (`pip3 install --user matplotlib`) is available, the script's own folder is not on `sys.path`, so keep it self-contained.
Draw with matplotlib (`import matplotlib.pyplot as plt`, no `plt.show()`); the current figure is saved for you, or save it yourself to `os.environ["BOTLING_FIGURE_OUT"]`. The theme is already applied: CJK fonts, transparent background, text and grid colours; use `C0`…`C5` (blue, orange, green, purple, red, grey) for colours that follow light and dark mode — other colours stay fixed.
Read the data from files (CSV, JSON, logs) passed in `args`; never type result numbers into the script. A condition without results is not drawn: list it in `missing` (shown as one line under the chart) and say it in the caption.
`format`: `svg` (default; inline, sharp, recoloured for dark mode) or `png` (very many points; drawn once per theme). `timeout`: seconds (default 60). A missing script, a Python error, no figure or a timeout comes back in `errors` with the last lines of stderr; fix the script and render again.
Every chart reads its numbers from the result files (CSV, JSON, logs) through `args`; the script holds the drawing, never the data. A flowchart reads its boxes and arrows from a small JSON file next to the spec.
Template for flowcharts: `flowchart.py` in the same folder as this guide (copy it as is). Usage `flowchart.py diagram.json`; the JSON lists `nodes` (`id`, `x`, `y`, `w`, `h`, `text`, optional `color`: `neutral` or `C0`…`C5`), `edges` (`from` / `to` = [node id, side (left/right/top/bottom), optional 0–1 position], `route`: straight / hv / vh / vhv / hvh / auto, or `via` corner points; optional `label`, `dashed`, `color`), `texts` (stage labels) and `legend` (one entry per colour used). Pixels, y down; one row = one y, one column = one x, 40–60 px apart; only horizontal and vertical segments (a diagonal is an error). Colour only what means a category (e.g. the one step that differs). Keep labels short, ≤ 2 lines. Render, look at the page, fix overlaps. Example: `{"nodes": [{"id": "raw", "x": 0, "y": 40, "w": 150, "h": 60, "text": "原始腦波\n資料集 A / B"}, {"id": "sess", "x": 200, "y": 40, "w": 150, "h": 60, "text": "加 SESS", "color": "C0"}], "edges": [{"from": ["raw", "right"], "to": ["sess", "left"]}], "legend": [{"color": "C0", "label": "只差這一步"}]}`.
Template for an experiment card's chart: `paired.py long.csv ROW COL MODEL [--range=LO:HI] [--unit=受試者]` (same long CSV as `per_subject.py`): each unit's gain (method − baseline) as a dot on one axis, sorted, blue = better, orange = worse; the mean and its 95% interval as a thick bar labelled beside it; 0 drawn. Give every card the same `--range` so they compare directly. It answers "is the gain real", a different question from the complete-results chart — never redraw that chart in a card.
Template for the complete-results chart: `per_subject.py DATA.csv [--ylabel=TEXT] [--chance=ROWPREFIX:VALUE …]` in the same folder as this guide. Write a long CSV (columns row, col, unit, model, variant, value; exactly two variants, baseline first) from the raw result files and pass it. It draws small multiples: one row of panels per (row, col) condition that has data, one panel per model, shared y; one thin line per unit from baseline to method (blue = better, orange = worse), the mean as a thick line with both values labelled, the better / worse counts under each panel, a one-line key on top, a labelled chance line. Usually it works as is; copy and adapt it only when it does not fit.

## Generate

Use the report command your instructions name (the app's `--render-report`; in the Botling repo also `node desktop/scripts/report.mjs`). The output must be an `.html` path inside an `artifacts` folder (created if missing).

```sh
<report command> spec.json /abs/.bot/artifacts/report.html                   # document (no JavaScript)
<report command> spec.json /abs/.bot/artifacts/report-slides.html --slides    # 16:9 slides
<report command> spec.json /abs/.bot/artifacts/report.html --force           # replace an existing page
<report command> --check spec.json                                             # validate only
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
  "status": {
    "level": "at_risk",
    "reason": "手機版 bot 清單受阻；今天修，明天驗"
  },
  "tldr": "任務面板 .11 已安裝；手機版 bot 清單受阻，預計今天修好。",
  "impact": "手機使用者今天仍看不到 bot 清單；桌面版不受影響。",
  "risk": {
    "text": "修法要動同步格式，可能影響桌面版",
    "plan": "先在測試機跑 30 分鐘再發布"
  },
  "next": [
    "修好手機清單",
    "測試機驗證後發布"
  ],
  "sections": [
    {
      "title": "進度",
      "takeaway": "四條線完成一條、受阻一條",
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
  ],
  "asks": [
    {
      "what": "確認今晚可以停機 10 分鐘",
      "who": "你",
      "by": "今天 18:00"
    }
  ]
}
```

- `version`: 2
- `lang?`: "zh-Hant" | "en"
- `kind?`: "status" | "decision" | "investigation" | "comparison" | "plan" | "results" | "explainer" | "experiment" — One report type per report; picks the skeleton (see the prompt doc).
- `title`: string ≤40 — What this report is about, ≤ 22 CJK chars.
- `subtitle?`: string ≤80
- `asOf`: string ≤40 — When the evidence was taken, human readable.
- `status?`: { level, reason? }
  - `level`: "on_track" | "at_risk" | "off_track" | "done" | "info"
  - `reason?`: string ≤60 — Required for at_risk / off_track: cause and fix in one line.
- `overview?`: { question, compare, setup, complete, why? } — Experiment reports: "what we are doing", for a reader who is not in the loop. Shown collapsed right after the first section (the flowcharts), which already draws it.
  - `question`: string ≤200 — The research question in plain words.
  - `compare`: string ≤200 — What is compared: the method vs the baseline, and what is held equal.
  - `setup`: string ≤280 — Data and settings: datasets (size, chance level), the compared conditions (e.g. cross-subject / cross-session), runs.
  - `complete`: string ≤200 — What counts as complete training (the formal results) and what does not, e.g. "350 epochs = fully trained; 30-epoch runs are under-trained".
  - `why?`: string ≤200 — Why it matters, in one or two sentences.
- `tldr`: string ≤240 — The answer first: ≤ 3 sentences. Shown in the verdict card and on the cover slide.
- `impact?`: string ≤160 — What the result means for the goal, in the reader's terms (users, time, money, the research question): "so what". Shown under the verdict.
- `risk?`: { text, plan? } — The biggest risk and its response; shown on the first page, never only at the end.
  - `text`: string ≤100 — The biggest risk or open doubt, in plain words.
  - `plan?`: string ≤100 — What is being done about it (road to green), with owner or date when known.
- `next?`: string ≤24[] (≥1 ≤3) — ≤ 3 one-line next steps, shown as numbered chips under the verdict.
- `sections`: { id?, title, takeaway?, layout?, collapsed?, blocks }[] (≥1 ≤8)
  - `id?`: string ≤32
  - `title`: string ≤24 — Short topic label, shown small above the takeaway.
  - `takeaway?`: string ≤80 — The section's conclusion as one sentence; becomes the slide headline.
  - `layout?`: "auto" | "stack" | "split" | "grid"
  - `collapsed?`: boolean — true = supporting detail (baseline checks, limitations, per-model breakdowns, exact-value tables, glossary, reproducibility): shown below the main part as a closed <details> the reader opens. The main part is charts with a short explanation under each.
  - `blocks`: { type, title?, note?, span?, text, slide? } | { type, title?, note?, span?, tone?, text } | { type, title?, note?, span?, items } | { type, title?, note?, span?, question, hypothesis, success, baseline, baselineTuned?, runs, spread, result?, figure?, verdict } | { type, title?, note?, span?, items, stack? } | { type, title?, note?, span?, series, rows, stacked?, horizontal?, sort?, unit?, highlight?, referenceLine? } | { type, title?, note?, span?, x?, series, area?, zero?, unit?, target?, marks? } | { type, title?, note?, span?, parts, unit?, center? } | { type, title?, note?, span?, labels?, rows } | { type, title?, note?, span?, rows, cols, cells, scale?, unit? } | { type, title?, note?, span?, x, y, quadrants?, best?, points } | { type, title?, note?, span?, items, today? } | { type, title?, note?, span?, columns } | { type, title?, note?, span?, dir?, nodes, edges } | { type, title?, note?, span?, dir?, nodes, edges } | { type, title?, note?, span?, actors, steps } | { type, title?, note?, span?, columns, rows, highlight? } | { type, title?, note?, span?, script, args?, format?, timeout?, alt, caption?, role?, perUnit?, missing? } | { type, title?, note?, span?, criteria, options, verdict? } | { type, title?, note?, span?, pros, cons, verdict? } | { type, title?, note?, span?, items } | { type, title?, note?, span?, items } | { type, title?, note?, span?, items } | { type, title?, note?, span?, text, source? } | { type, title?, note?, span?, src, alt, caption?, annotations? } | { type, title?, note?, span?, items }[] (≥1 ≤8)
- `asks?`: { what, who?, by? }[] (≤3) — What the reader must do (owner, deadline). [] renders "No action needed".
  - `what`: string ≤60
  - `who?`: string ≤20
  - `by?`: string ≤20
- section: `{ id?, title, takeaway?, layout?: "auto"|"stack"|"split"|"grid", blocks[] (≤8) }` — keep `layout` on auto unless you have a reason.

## Report kinds

Pick one `kind`; use its skeleton as the default section order (skip what you have no evidence for). In every kind, sections that only support the main point (checks, exact values, glossary, limitations, technical detail) get `"collapsed": true`.

### status

Software progress / feature status: where things stand against the plan, what changed since last time, and what needs a decision. Outcomes, not activity.

1. tldr = one-sentence status + why + the decision needed; `status.level` defined in advance: on_track = within tolerance, at_risk = at risk with a recovery plan, off_track = a commitment is broken or a decision above the team is needed; any blocking red makes the whole report red
2. impact = the effect on the goal (release date, users, cost), planned vs now; risk = the biggest risk + road to green (who, what, by when) and whether the team can recover alone
3. table (dimension | status | one-line reason with a number): schedule, scope, quality, resources — or kpi (target vs actual, delta, spark); stack:true for status counts
4. table or timeline — planned vs actual per milestone: done / not done + expected date (never "80% done"); carry-overs and scope changes stated
5. checklist — 2–5 outcomes since the last report, each "讓［誰］能［做什麼］→［可量測結果］", not activities; a figure of the rate over 3–5 cycles when a rate matters (never one cycle alone; velocity plans, it does not grade the team)
6. next (even tentative) + confidence in the milestone; asks (owner, deadline) — or [] for "No action needed"
7. last section for engineers (`"collapsed": true`): technical details, alternatives considered, PR / issue references in sources ≤ 4

### decision

"Decision needed: X by date" with a recommendation.

1. tldr = the recommendation + the deadline; impact = what changes for the goal if we pick it
2. prose: context in SCQA, 2–3 sentences, terms defined
3. options (2–4 incl. "do nothing", same criteria: cost, risk, time, reversibility) with recommended + verdict
4. proscons, or a figure of effort × impact — why the others lose
5. callout tone=warn: the main risk / assumption (or `risk`)
6. asks: who decides, by when

### investigation

Investigation: what broke or what we found, why, and whether it is fixed.

1. tldr = the finding or cause in plain language + impact + fixed now?; impact = who or what is affected and how much
2. glossary or prose: the setup and one plain sentence per domain term, before any metric
3. flowchart plus a table — show the multistep cause and the evidence for each link; mark pending inferences
4. timeline (events) — only when timing explains the cause
5. figure (before/after, signed deltas or the metric over time, with the baseline drawn in) or a table — the metric before/after the fix, against its baseline
6. checklist — actions with owners (blameless: name the activity, not the person)
7. sources ≤ 4

### comparison

Which one, and "pick X if…, Y if…".

1. tldr = plain question + the winner + when to pick the other
2. prose or glossary: plain-language criteria and baseline definitions (1–3 sentences)
3. options or table with the winning cells toned good
4. figure (one question per chart; signed deltas and a reference line drawn in) — optional
5. callout: caveats

### plan

Goal, definition of done, path there.

1. tldr = goal + definition of done + date; risk = the top risk and its response
2. timeline (gantt with lanes, today) or roadmap
3. flowchart — dependencies / critical path
4. steps — the first step; next; asks — decision needed

### results

What the numbers say after a change (product or system metrics). For an ML / deep-learning experiment use kind `experiment`.

1. tldr = plain question + headline answer against its baseline + what it means; impact = the consequence in the reader's units
2. glossary or prose: plain-language setup, what the baseline is, one sentence per domain term
3. kpi vs baseline (delta, target)
4. figure of the metric over time with marks at the change and the target line
5. figure or table (before/after, signed values and a reference line; add a 1-sentence reading guide) — segment breakdown
6. prose: verified facts and pending inferences, with the reason and what remains unchecked
7. sources ≤ 4

### explainer

Explainer: what it is and how it works, for a reader outside the field.

1. tldr = one plain sentence what + why it matters (no acronym stacking)
2. glossary — everyday analogy + one plain sentence per technical term
3. flowchart plus a table — show the multistep mechanism and explain each link
4. steps — only for an ordered procedure
5. figure / table / image — a worked example with a 1-sentence reading guide
6. callout — limits

### experiment

ML / deep-learning experiment: the answer, the pipeline as flowcharts, every individual result as charts, then whether the change worked and is the gap real; supporting detail collapsed.

1. the verdict card comes first (automatically): tldr = the answer in one plain sentence + the key number against its baseline + whether the gap is real (n runs; "不顯著" when inside the noise); impact = what it means for the research question; risk = the main doubt (underfitting, leakage, small n) and how it will be checked; next; asks
2. first section = one or more flowcharts (`figure` with `role: "flowchart"`, drawn by `flowchart.py` from a diagram JSON): the whole pipeline (data → the compared variants → model → evaluation → comparison); add a second one when the evaluation split or another stage needs its own picture (e.g. cross-subject vs cross-session). Caption = the one thing to notice (e.g. "the two paths differ only in the blue step")
3. `overview` (question, compare, setup, complete = what counts as complete training, why) — shown collapsed right after the flowcharts for the reader who wants the setup in words
4. the complete results: a `figure` with `perUnit: true` (template `per_subject.py`) — small multiples: one row of panels per compared condition that has data, one panel per model, shared y axis; one thin line per unit from baseline to method, blue = better, orange = worse; the mean as a thick line with its two values labelled; fully trained runs only; conditions not run are one sentence in the caption, never an empty panel; the conditions not run also go in `missing`; caption = how to read it
5. the gaps: a `figure` of each comparison's difference with its 95% interval (one row per condition × model, 0 drawn in) — this replaces the big table of means; under-trained or exploratory runs (e.g. a shorter training) as a labelled contrast in the same chart or the next one, never in the complete-results chart
6. an `experiment` card per main hypothesis, each with its own `figure` (e.g. `paired.py`: each unit's baseline → method for that one comparison) and the 95% interval of the difference; never the same script and args as another chart
7. collapsed sections (`"collapsed": true`), in this order as needed: glossary (every acronym, model, dataset and metric in plain words); sanity checks (chance level, the paper's score for the same protocol, convergence / training accuracy, a fair cross-dataset metric); exact values (the table of means, intervals, wins / losses); error analysis, ablations, what was ruled out and what is missing; limitations; reproducibility (data files, the figure and extraction scripts, how numbers are computed) → sources ≤ 4

## Blocks

Every block takes optional `title` (action title), `note` (faint caption: unit, scope, source) and `span: "full"`. Statuses everywhere: `done | active | pending | blocked | risk | unverified | skipped`. Tones: `good | warn | bad | info | neutral`.

| type | use for |
|---|---|
| `prose` | A short paragraph or bullet list in restricted Markdown (**bold**, *italic*, `code`, - bullets, 1. numbers). |
| `callout` | One highlighted message with a tone: info, warn, bad (risk), good (success) or neutral. |
| `glossary` | Plain one-sentence definitions of the acronyms, symbols and field terms the reader may not know. |
| `experiment` | The experiment card: the verdict and the result with its interval, its own chart (a .py figure) with a one-sentence reading guide, and the design (question, hypothesis, success criterion set beforehand, baseline, runs, what ± means) collapsed under it. |
| `kpi` | A row of 1–6 headline numbers, each with label and optional delta and target. |
| `matrix` | A placement grid of rows × columns where each cell lists short item names. |
| `timeline` | Either a vertical event log (items without end) or a gantt chart (items with start and end dates, optional lanes and a today line). |
| `roadmap` | Two to four columns (e.g. Now / Next / Later) of short items with optional status. |
| `flowchart` | Flowchart and architecture diagram: connected boxes and labelled arrows, laid out automatically. Supports status colours, decisions and start/end nodes. |
| `flow` | Compatibility alias for flowchart. Existing reports remain supported; use flowchart for new reports. |
| `sequence` | Sequence diagram: 2–5 actors as columns, numbered messages between them (call, dashed reply, or a note on one actor). |
| `table` | A compact table; cells can carry a status or tone dot. Numeric columns align right. |
| `figure` | A data chart drawn by your own matplotlib script (.py), run when the page is rendered and embedded in the page; follows the light and dark themes. |
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

### `glossary`

Plain one-sentence definitions of the acronyms, symbols and field terms the reader may not know.

**When:** In the first section of any report that uses domain terms (acronyms, model or dataset names, metric symbols such as κ). Define each term once, in everyday words or with an analogy, then use it the same way everywhere. The renderer treats terms listed here as defined.

- `title?`: string ≤80 — Action title: the point of this block, not its topic ("啟動時間少了 42%", not "啟動時間").
- `note?`: string ≤60 — Faint caption on the right of the title: unit, scope or source.
- `items`: { term, plain }[] (≥1 ≤10)
  - `term`: string ≤40 — The term exactly as the report writes it, e.g. "LOSO" or "κ"; related names may share one entry ("MAtt / SPDIM").
  - `plain`: string ≤120 — One plain sentence: what it is and why it matters here.

```json
{"type":"glossary","title":"先看懂這三個詞","items":[{"term":"SESS","plain":"一種「先把每個人的腦波調到同一個基準」的前處理，像把不同麥克風的底噪先扣掉。"},{"term":"跨受試者","plain":"用其他人的資料訓練、拿沒看過的新人來考，最接近真實上線。"},{"term":"κ","plain":"扣掉亂猜後的分數：0 = 跟亂猜一樣，1 = 全對；類別數不同的資料集要用它比。"}]}
```

### `experiment`

The experiment card: the verdict and the result with its interval, its own chart (a .py figure) with a one-sentence reading guide, and the design (question, hypothesis, success criterion set beforehand, baseline, runs, what ± means) collapsed under it.

**When:** Every experiment report (kind "experiment"), in the first section, once per main hypothesis. It answers "was the comparison fair and is the gap real?". Its chart is `figure` (a .py reading the result files, like a figure block; the renderer draws no chart of its own), e.g. each unit's baseline → method for this one comparison; never the same script and args as another chart. When the interval of the difference crosses 0 the card itself says "not significant"; never call that gap an improvement.

- `title?`: string ≤80 — Action title: the point of this block, not its topic ("啟動時間少了 42%", not "啟動時間").
- `note?`: string ≤60 — Faint caption on the right of the title: unit, scope or source.
- `question`: string ≤120 — What the experiment wants to know, in plain words.
- `hypothesis`: string ≤160 — "If we change X, metric Y improves by ≥ Z" — falsifiable, with direction.
- `success`: string ≤120 — The success criterion fixed before running.
- `baseline`: string ≤120 — What the new method is compared against (previous version, paper score, chance level).
- `baselineTuned?`: boolean — true = the baseline got the same tuning budget and training length.
- `runs`: integer ≥1 ≤1000 — Independent runs (seeds / folds) per setting.
- `spread`: string ≤60 — What the ± or error bar is: std or SE, across seeds or subjects, and n.
- `result?`: { metric, base, new, ci?, unit? }
  - `metric`: string ≤24
  - `base`: number
  - `new`: number
  - `ci?`: [number, number] — 95% interval of the difference new − base.
  - `unit?`: string ≤8 — Unit of base and new, e.g. "%" (the difference is then shown in pp), "ms".
- `figure?`: { script, args?, format?, timeout?, alt, caption? } — The card's chart: a matplotlib .py reading the result files, run like a figure block.
  - `script`: string ≤400 — Path to the .py file, absolute or relative to the spec file.
  - `args?`: string ≤400[] (≤20) — Command-line arguments for the script (data files, options); it runs with the spec's folder as working directory.
  - `format?`: "svg" | "png" — svg (default: sharp, recoloured for dark mode) or png (very many points; drawn twice, once per theme).
  - `timeout?`: integer ≥5 ≤300 — Seconds before the script is stopped and the block reports an error.
  - `alt`: string ≤200 — What the chart shows, for screen readers.
  - `caption?`: string ≤200 — One-sentence reading guide under the chart.
- `verdict`: "supported" | "not_supported" | "inconclusive" — supported | not_supported | inconclusive (the gap is inside the noise or runs are missing).

```json
{"type":"experiment","question":"加了 SESS 前處理，模型在沒看過的新受試者身上會不會更準？","hypothesis":"加 SESS 後，跨受試者準確率至少高 3 個百分點。","success":"9 人中至少 7 人變好，且差距的 95% 區間不含 0。","baseline":"同模型、同訓練長度、不加 SESS","baselineTuned":true,"runs":3,"spread":"受試者間標準差（9 人，每人 3 seeds 先平均）","result":{"metric":"準確率","base":41.9,"new":50.8,"ci":[2.2,15.6],"unit":"%"},"verdict":"supported","figure":{"script":"figures/paired.py","args":["figures/per_subject.csv","資料集 A","條件 1","模型 X"],"alt":"每位受試者加 SESS 後的準確率變化，依大小排序，上方是平均與 95% 區間","caption":"每個點是一位受試者的變化（藍 = 變好、橘 = 變差）；粗線是平均與 95% 區間，整段在 0 右邊才算真的變好。"}}
```

### `kpi`

A row of 1–6 headline numbers, each with label and optional delta and target.

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
  - `spark?`: number[] (≥2 ≤40) — Retired: sparklines are no longer drawn (older specs still validate). Draw a trend as a figure.
  - `status?`: "done" | "active" | "pending" | "blocked" | "risk" | "unverified" | "skipped" — Colours the number (blocked = red, pending = orange…).
- `stack?`: boolean — Draw a segmented bar of the items that have a status (first item = total).

```json
{"type":"kpi","items":[{"label":"冷啟動","value":1.4,"unit":"s","delta":"-42%","deltaDir":"down_good"},{"label":"閒置 CPU","value":"2.1%","delta":"-7.7pt","deltaDir":"down_good","target":"目標 ≤ 3%"},{"label":"記憶體","value":412,"unit":"MB","delta":"+6%","deltaDir":"down_good"}]}
```

### `matrix`

A placement grid of rows × columns where each cell lists short item names.

**When:** Placing items on two dimensions at once: priority × status, module × platform. Cells hold arrays of ≤4 short names, or null. ≤30×30. Numbers (a heatmap) are a data chart: draw it in a `figure`.

- `title?`: string ≤80 — Action title: the point of this block, not its topic ("啟動時間少了 42%", not "啟動時間").
- `note?`: string ≤60 — Faint caption on the right of the title: unit, scope or source.
- `rows`: string ≤16 | { label, status? }[] (≥1 ≤30)
- `cols`: string ≤16 | { label, status? }[] (≥1 ≤30) — A column with a status colours the item chips placed in it.
- `cells`: number | any | string ≤14[] (≤4)[][] — Arrays of short item names (or null). Numbers (older specs) are shown as plain values, no longer as a heatmap, with a warning: draw a heatmap as a figure.
- `scale?`: "seq" | "div" — seq = low→high; div = negative↔positive around 0.
- `unit?`: string ≤8

```json
{"type":"matrix","title":"P0 只剩一項，卡在安裝","rows":["P0","P1","P2"],"cols":[{"label":"受阻","status":"blocked"},{"label":"進行中","status":"active"},{"label":"完成","status":"done"}],"cells":[[["離線安裝"],null,null],[null,["Rust 後端","手機同步"],["任務面板"]],[null,["報告改版"],["CPU 降低"]]]}
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

### `flowchart`

Flowchart and architecture diagram: connected boxes and labelled arrows, laid out automatically. Supports status colours, decisions and start/end nodes.

**When:** Use flowchart for system architecture relationships, dependencies, processes, pipelines or causal chains. Nodes are components or steps; arrows show connections. Use sequence for messages ordered over time. ≤12 nodes in a report; mark bottlenecks with status blocked. The old type flow remains an alias.

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
{"type":"flowchart","title":"卡在安裝：新版 .2 裝上後退回 .1","nodes":[{"id":"impl","label":"實作","status":"done"},{"id":"review","label":"複審","status":"done"},{"id":"pack","label":"打包","status":"done"},{"id":"install","label":"安裝","sub":"退回 .1","status":"blocked"},{"id":"accept","label":"驗收","status":"pending"}],"edges":[{"from":"impl","to":"review"},{"from":"review","to":"pack"},{"from":"pack","to":"install"},{"from":"install","to":"accept"}]}
```

### `flow`

Compatibility alias for flowchart. Existing reports remain supported; use flowchart for new reports.

**When:** Use flowchart for system architecture relationships, dependencies, processes, pipelines or causal chains. Nodes are components or steps; arrows show connections. Use sequence for messages ordered over time. ≤12 nodes in a report; mark bottlenecks with status blocked. The old type flow remains an alias.

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

**When:** Exact values the reader will look up, or a few rows × few attributes. ≤8 rows in status/plan/decision reports (≤16 in investigation/results/comparison/explainer); larger data goes to an appendix file. Strings never imply status, regardless of wording or column heading. Supply cell objects with explicit status or tone; status="skipped" strikes the text. strong controls bold text.

- `title?`: string ≤80 — Action title: the point of this block, not its topic ("啟動時間少了 42%", not "啟動時間").
- `note?`: string ≤60 — Faint caption on the right of the title: unit, scope or source.
- `columns`: string ≤24[] (≥2 ≤6)
- `rows`: string ≤60 | number | { text, status?, tone?, strong? }[][] (≥1 ≤20)
- `highlight?`: integer ≥0 ≤9007199254740991 — Index of the row to emphasise.

```json
{"type":"table","title":"四條工作線，一條受阻","columns":["工作線","狀態","下一步"],"rows":[["任務面板 .11",{"text":"已安裝","status":"done"},"收集回饋"],["Rust 遷移",{"text":"進行中","status":"active"},"補完 IPC"],["手機版對齊",{"text":"受阻","status":"blocked"},"修 bot 清單"],["報告改版",{"text":"進行中","status":"active"},"定稿區塊"]]}
```

### `figure`

A data chart drawn by your own matplotlib script (.py), run when the page is rendered and embedded in the page; follows the light and dark themes.

**When:** Every data chart: comparisons, signed deltas, trends over time, before/after, shares, heatmaps, per-subject scores, small multiples, scatter, distributions, error bars, curves. Never a hand-written SVG. The script draws with matplotlib (the current figure is saved; theme colours are C0 blue, C1 orange, C2 green, C3 purple, C4 red, C5 grey) and reads its data from files — never type numbers into the script. In an experiment report the first chart is a figure with perUnit: true: small multiples, one panel per model and condition, each unit a thin line from baseline to method, the mean thick and labelled; conditions not run are not drawn (caption and `missing`). Follow "Chart design" in the guide.

- `title?`: string ≤80 — Action title: the point of this block, not its topic ("啟動時間少了 42%", not "啟動時間").
- `note?`: string ≤60 — Faint caption on the right of the title: unit, scope or source.
- `script`: string ≤400 — Path to the .py file, absolute or relative to the spec file.
- `args?`: string ≤400[] (≤20) — Command-line arguments for the script (data files, options); it runs with the spec's folder as working directory.
- `format?`: "svg" | "png" — svg (default: sharp, recoloured for dark mode) or png (very many points; drawn twice, once per theme).
- `timeout?`: integer ≥5 ≤300 — Seconds before the script is stopped and the block reports an error.
- `alt`: string ≤200 — What the chart shows, for screen readers and as the fallback text.
- `caption?`: string ≤200 — One-sentence reading guide: what each mark is and what higher / further right means.
- `role?`: "chart" | "flowchart" — flowchart = a process diagram (the pipeline, how the data is split, what is compared), drawn in the clean-flowchart style from template flowchart.py: rounded boxes, right-angle arrows. One or more open the report. Default chart.
- `perUnit?`: boolean — true = the complete results: every unit before → after, one panel per model and condition (template per_subject.py); the first chart of an experiment report.
- `missing?`: string ≤60[] (≤12) — Conditions with no results, shown as one "未跑" line under the chart; never draw them as empty panels.

```json
{"type":"figure","title":"同一份資料，只差有沒有先做 SESS","role":"flowchart","script":"figures/flowchart.py","args":["figures/flowchart.json"],"alt":"流程圖：原始腦波分成兩條路（不加 SESS、加 SESS），送進同一個模型，用兩種考法評分，最後配對比較","caption":"每個方框是一個步驟；兩條路只差藍色那一步，其餘完全相同。"}
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

**When:** A procedure, a fix plan or "what happens next" in order. If the steps branch, use flowchart instead.

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

**When:** Showing the actual UI or output the text refers to (a PNG / JPEG screenshot or photo). SVG images are disabled — never a chart or diagram: those are `figure` blocks drawn by a .py. Annotate what to look at; alt text says what the image proves. src must be a data: URI or a path next to the spec file (inlined by the CLI).

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

Default (`status`, `plan`, `decision`):

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
- `mainBullets`: 3
- `mainCallouts`: 1

Relaxed for technical/scientific kinds (`investigation`, `explainer`, `results`, `comparison`, `experiment`):

- `takeawayUnits`: 48
- `proseUnits`: 600
- `tableRows`: 16
