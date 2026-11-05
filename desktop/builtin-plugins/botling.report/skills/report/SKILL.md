---
name: report
description: "Build a report page (status, decision, investigation, comparison, plan, results, explainer, experiment, or a 16:9 deck) from a ReportSpec v2 JSON with the app's report command."
---

# Report pages

A settled result that needs visuals or comparison (status, decision, comparison, results to share) goes into one report page, never into chat; long text still being discussed or explained goes into a .md file instead. The page opens with one sentence that answers the user's question ("You asked X; the answer is Y"); if it cannot, do not publish it: answer in chat. Build the page from a ReportSpec v2 JSON, never by writing HTML.

1. Each time, before you write a spec, read `report-blocks.md` in this folder. It is the one place for the rules: the format, the blocks, the template for each report `kind`, the writing rules (first page, takeaways, plain language, baselines, uncertainty), the experiment order and the chart rules. Every data chart is a `figure` block (your matplotlib `.py`, reading the result files; template `per_subject.py` in this folder). The guide can change between reports, so do not work from memory.
2. Write the spec as `spec.json`.
3. Run the report command your instructions name (`Botling 2 --render-report spec.json <artifacts folder>/<english-name>.html`; add `--slides` for a 16:9 deck, `--force` to replace a page). It prints one JSON line `{ok, errors, warnings, htmlPath, link}`.
4. Fix each error (it gives a path and a valid example) and the warnings you can, and run it again (at most twice).
5. Deliver the page at `htmlPath` as the results rule says. The chat reply carries only a brief conclusion and the link.

The rule that tells every bot to do this comes with this plugin (its `promptSections`: the short contract only), and so does the command (its `agentCommands`). The guide and the renderer come from the same plugin folder: the shipped one, or a rebuilt one in `<data dir>/plugin-overrides/botling.report` (`npm run build:plugins -- --only botling.report --out <data dir>/plugin-overrides`), which bots read and run from their next report on, with no restart.
