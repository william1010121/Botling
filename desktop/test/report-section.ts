// The report page rule as it was before it became botling.report's prompt section (core/prompts.ts's reportPageLine, as of 8e8c2188),
// kept as the golden the plugin's text must equal byte for byte (routing to .md files and the answer-first sentence
// added 2026-11-04), and the plugin's section as the tests use it.
import { readFileSync } from "node:fs";
import { fillSection, shellQuote, withPluginSections, type PromptSection, type ReportTool } from "../src/core/prompts";

const manifest = JSON.parse(readFileSync(new URL("../builtin-plugins/botling.report/package.json", import.meta.url), "utf8"));
/** botling.report's section as the manifest gives it. */
export const REPORT_SECTION = manifest.ccb.contributes.promptSections[0] as PromptSection & { command: string };
/** The prompt sections of a core whose plugins include botling.report, the command resolved to `tool` (none: not resolved, so no rule). */
export const reportSections = (tool: ReportTool | null) => withPluginSections(tool ? [{ plugin: "botling.report", ...REPORT_SECTION, tool }] : []);
/** The line a bot is told, from the plugin's text. */
export const reportPageLine = (tool: ReportTool, artifacts: string) => fillSection(REPORT_SECTION.text, tool, artifacts);

export function legacyReportPageLine(tool: ReportTool, artifacts: string): string {
  return `- A settled result that needs visuals or comparison (status, decision, comparison, results to share) goes into one report page, never into chat: the chat reply carries only a brief conclusion and the link to the page; never paste the report body into chat. Long text still being discussed or explained goes into a .md file instead, as the results rule says. The page opens with one sentence that answers the user's question (\"You asked X; the answer is Y\"); if it cannot, do not publish it: answer in chat. Build every report page (status, decision, investigation, comparison, plan, results, explainer) from a ReportSpec v2 JSON, never hand-written HTML: read ${shellQuote(tool.docs)} for the format, the blocks and the writing rules; write the spec; run ${tool.command} spec.json ${shellQuote(`${artifacts}/<english-name>.html`)} exactly as quoted (add --slides for a 16:9 deck, --force to replace). It prints one JSON line {ok, errors, warnings, htmlPath, link}: fix each error (it gives a path and a valid example) and the warnings you can, run it again (at most twice), then deliver the page at htmlPath as the results rule says. Use ASD-STE100-informed plain language: active voice, direct verbs, and consistent terms. Aim for sentences of at most 20 English words or 30 Chinese characters. These are writing guidelines, not renderer checks or formal ASD-STE100 compliance for Chinese. Keep useful technical names. State verified facts and pending inferences with their reasons; do not assign mechanical confidence percentages. Omit routine defensive boilerplate. Explain material uncertainty and failed checks that affect the reader’s decision; never hide defects or claim unperformed validation. For multistep causes, prefer a flow plus a table of evidence. Keep long paths, hashes, test commands, and preview-tool details in sources or the internal handback, outside the prose.`;
}
