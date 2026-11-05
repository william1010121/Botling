---
name: report
description: "Build a report page (status, decision, investigation, comparison, plan, results, explainer, or a 16:9 deck) from a ReportSpec v2 JSON with the app's report command."
---

# Report pages

A settled result that needs visuals or comparison (status, decision, comparison, results to share) goes into one report page, never into chat; long text still being discussed or explained goes into a .md file instead. The page opens with one sentence that answers the user's question ("You asked X; the answer is Y"); if it cannot, do not publish it: answer in chat. Build the page from a ReportSpec v2 JSON, never by writing HTML.

1. Read `report-blocks.md` in this folder: the format, the blocks and the writing rules.
2. For technical or scientific reports (`investigation`, `explainer`, `results`, `comparison`):
   - **Plain language before jargon (先講人話再給術語):** state the plain question, setup, and everyday answer first; define each domain acronym or metric symbol in one plain sentence the first time it appears instead of stacking acronyms in titles or takeaways.
   - **One question per chart + 1-sentence reading guide (一張圖只回答一個問題＋一句看圖指南):** never cram incompatible baselines or scales into one chart; add one sentence telling the reader what taller/shorter or right/left of `0` means.
   - **Never hand-code data-chart SVGs (禁止手刻複雜數據圖 SVG):** use native `bar` (supports negative/diverging values and `referenceLine`), `table`, `kpi`, `trend`, and `flowchart` blocks instead of hand-written `<svg>` charts whose pixel coordinates cause CJK text overlap.
3. Write the spec as `spec.json`.
4. Run the report command your instructions name (`Botling 2 --render-report spec.json <artifacts folder>/<english-name>.html`; add `--slides` for a 16:9 deck, `--force` to replace a page). It prints one JSON line `{ok, errors, warnings, htmlPath, link}`.
5. Fix each error (it gives a path and a valid example) and the warnings you can, and run it again (at most twice).
6. Deliver the page at `htmlPath` as the results rule says. The chat reply carries only a brief conclusion and the link.

The rule that tells every bot to do this comes with this plugin (its `promptSections`), and so does the command (its `agentCommands`).
