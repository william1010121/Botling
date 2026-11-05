---
name: report
description: "Build a report page (status, decision, investigation, comparison, plan, results, explainer, experiment, or a 16:9 deck) from a ReportSpec v2 JSON with the app's report command."
---

# Report pages

A settled result that needs visuals or comparison (status, decision, comparison, results to share) goes into one report page, never into chat; long text still being discussed or explained goes into a .md file instead. The page opens with one sentence that answers the user's question ("You asked X; the answer is Y"); if it cannot, do not publish it: answer in chat. Build the page from a ReportSpec v2 JSON, never by writing HTML.

1. Read `report-blocks.md` in this folder: the format, the blocks and the writing rules.
2. Pick the `kind` and follow its template in the guide: `status` (software progress / features), `experiment` (ML / deep-learning experiments), `investigation`, `explainer`, `results`, `comparison`, `decision`, `plan`. Then, for every report:
   - **First page = five things (第一頁五件事):** `tldr` (the answer), `impact` (what it means for the goal), `asks` (decision needed: who, what, by when), `risk` (biggest risk + response), `next`. Reading only the verdict card, the reader can say the status, the impact and what to decide.
   - **Headlines are conclusions (小標寫結論):** every `takeaway` states what the section shows, never "結果" or "進度說明".
   - **Plain language before jargon (先講人話再給術語):** define each acronym, model or dataset name and metric symbol once, in a `glossary` block or as "plain words（TERM）"; keep a cause with its effect in one sentence instead of chopping it short.
   - **Numbers need a baseline and a meaning (數字要有基準與意義):** plan, previous version, chance level or the paper's score, then what the gap means for the reader.
   - **Experiments (實驗報告):** an `experiment` card first (question, hypothesis, success criterion, equally tuned baseline, ≥ 3 seeds, what ± means, the 95% interval, verdict); a gap inside the noise is "不顯著"; add error analysis, ablations and negative results; reproducibility last.
   - **One question per chart + 1-sentence reading guide (一張圖只回答一個問題＋一句看圖指南);** never hand-code data-chart SVGs (禁止手刻複雜數據圖 SVG): use native `bar` (negative values, `referenceLine`), `table`, `kpi`, `trend`, `flowchart`.
3. Write the spec as `spec.json`.
4. Run the report command your instructions name (`Botling 2 --render-report spec.json <artifacts folder>/<english-name>.html`; add `--slides` for a 16:9 deck, `--force` to replace a page). It prints one JSON line `{ok, errors, warnings, htmlPath, link}`.
5. Fix each error (it gives a path and a valid example) and the warnings you can, and run it again (at most twice).
6. Deliver the page at `htmlPath` as the results rule says. The chat reply carries only a brief conclusion and the link.

The rule that tells every bot to do this comes with this plugin (its `promptSections`), and so does the command (its `agentCommands`).
