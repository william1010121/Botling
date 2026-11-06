---
name: report
description: "Build a report page (status, decision, investigation, comparison, plan, results, explainer, experiment, or a 16:9 deck) from a ReportSpec v2 JSON with the app's report command."
---

# Report pages

A settled result that needs visuals or comparison (status, decision, comparison, results to share) goes into one report page, never into chat; text still being discussed or explained stays short in chat. Every result page is a ReportSpec v2 report. The page opens with one sentence that answers the user's question ("You asked X; the answer is Y"); if it cannot, do not publish it: answer in chat. Build the page from a ReportSpec v2 JSON, never by writing HTML.

1. Each time, before you write a spec, read `report-blocks.md` in this folder. It is the one place for the rules: the format, the blocks, the template for each report `kind`, the writing rules (first page, takeaways, plain language, baselines, uncertainty), the experiment order and the chart rules. Every chart is drawn by Python: a `figure` block (your matplotlib `.py`, reading the result files); the renderer draws no chart of its own and SVG is disabled. The page is charts with a short explanation under each, opening with one or more flowcharts (`role: "flowchart"`); supporting detail goes in collapsed sections. Every chart follows the guide's "Chart design" rules (one message per chart, no empty panels, small multiples, direct labels). Templates in this folder: `flowchart.py` (clean flowcharts from a JSON), `per_subject.py` (complete results: before → after per unit, one panel per model), `paired.py` (an experiment card's chart: each unit's gain with the mean and its 95% interval). The guide can change between reports, so do not work from memory.
2. Write the spec as `spec.json`.
3. Run the report command your instructions name (`Botling 2 --render-report spec.json <artifacts folder>/<english-name>.html`; add `--slides` for a 16:9 deck, `--force` to replace a page). It prints one JSON line `{ok, errors, warnings, htmlPath, link}`.
4. Fix each error (it gives a path and a valid example) and the warnings you can, and run it again (at most twice).
5. Deliver the page at `htmlPath` as the results rule says. The chat reply carries only a brief conclusion and the link.

The rule that tells every bot to do this comes with this plugin (its `promptSections`: the short contract only), and so does the command (its `agentCommands`). The guide and the renderer come from the same plugin folder: the shipped one, or a rebuilt one in `<data dir>/plugin-overrides/botling.report` (`npm run build:plugins -- --only botling.report --out <data dir>/plugin-overrides`), which bots read and run from their next report on, with no restart.
