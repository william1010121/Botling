---
name: report
description: "Build a report page (status, decision, investigation, comparison, plan, results, explainer, or a 16:9 deck) from a ReportSpec v2 JSON with the app's report command."
---

# Report pages

A settled result that needs visuals or comparison (status, decision, comparison, results to share) goes into one report page, never into chat; long text still being discussed or explained goes into a .md file instead. The page opens with one sentence that answers the user's question ("You asked X; the answer is Y"); if it cannot, do not publish it: answer in chat. Build the page from a ReportSpec v2 JSON, never by writing HTML.

1. Read `report-blocks.md` in this folder: the format, the blocks and the writing rules.
2. Write the spec as `spec.json`.
3. Run the report command your instructions name (`Botling 2 --render-report spec.json <artifacts folder>/<english-name>.html`; add `--slides` for a 16:9 deck, `--force` to replace a page). It prints one JSON line `{ok, errors, warnings, htmlPath, link}`.
4. Fix each error (it gives a path and a valid example) and the warnings you can, and run it again (at most twice).
5. Deliver the page at `htmlPath` as the results rule says. The chat reply carries only a brief conclusion and the link.

The rule that tells every bot to do this comes with this plugin (its `promptSections`), and so does the command (its `agentCommands`).
