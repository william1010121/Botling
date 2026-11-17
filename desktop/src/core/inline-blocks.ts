// Inline report blocks in the chat (2026-11-17, the user: "讓所有 bot 內建這個組件，規則改成依內容大小選擇，再附 5 個從你對話挑出的範例").
//
// The components `inline-report-block` and `inline-chart` (botling.cards) are every bot's: built-ins by the `Built-in: yes` tag of their about.md
// (library.ts `builtInNames`; Maintainer decides which components carry it, nothing here lists them). What a bot is TOLD about when to use them
// (the guidance, the report rule "by size", the component lines) is a trial first: settings.json `inlineBlockGuidance` says which bots get it.
//   absent        the Botling source project's own bots (a folder holding desktop/src/core/prompts.ts), the one-day trial
//   "all"         every bot (the one value to change when the trial is opened to all)
//   "off"         no bot
//   ["/path", …]  the bots whose project folder is one of these paths
import { existsSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/** Whether the bot in `folder` gets the inline block guidance (see the header). A malformed value is the default. */
export function inlineBlocksFor(raw: Record<string, unknown> | undefined, folder: string | null | undefined): boolean {
  const value = raw?.inlineBlockGuidance;
  if (value === "all") return true;
  if (value === "off") return false;
  if (!folder) return false;
  if (Array.isArray(value)) {
    const here = realFolder(folder);
    return value.some((entry) => typeof entry === "string" && entry.trim() !== "" && realFolder(entry.trim()) === here);
  }
  return existsSync(join(folder, "desktop", "src", "core", "prompts.ts"));
}

/** The real path (the nearest existing ancestor for a new one), so a typed path, a symlink and the case of a Mac volume compare equal. */
function realFolder(path: string): string {
  let at = resolve(path);
  const rest: string[] = [];
  for (let depth = 0; depth < 64; depth++) {
    try { return join(realpathSync.native(at), ...rest.reverse()); } catch { /* not there yet: its parent */ }
    const parent = resolve(at, "..");
    if (parent === at) break;
    rest.push(basename(at));
    at = parent;
  }
  return resolve(path);
}

/** The sentence of botling.report's page rule that sends every visual result to a page (the manifest's text, byte for byte; a test holds it). */
export const REPORT_RULE_ALL_TO_PAGE = "A settled result that needs visuals or comparison (status, decision, comparison, results to share) goes into one report page, never into chat: the chat reply carries only a brief conclusion and the link to the page; never paste the report body into chat.";
/** What it says for a bot with the inline guidance: by size. */
export const REPORT_RULE_BY_SIZE = "Default is inline; a report page is the exception. A settled result that is one table, KPI row, comparison, timeline or flow goes into ONE inline report block in the chat reply (the inline blocks rule), and a chart of a few numbers into ONE inline chart (inline-chart); anything else stays in chat as plain text. Use a report page ONLY when the content is really long (more than 3 blocks, many series that need matplotlib, or a long read) or the user explicitly asks for a report or a page: the chat reply then carries only a brief conclusion and the link to the page; never paste the report body into chat.";
/** The page rule's text for a bot with the inline guidance (the sentence swapped; any other wording of a plugin's own stays as it is). */
export const inlineReportRule = (text: string): string => text.replace(REPORT_RULE_ALL_TO_PAGE, () => REPORT_RULE_BY_SIZE);

/** The results rule's list of what goes to a page (prompts.ts), and the same list without comparisons for a bot with the inline guidance. */
export const RESULTS_LIST = "Results meant for the user (reports, comparisons, screenshots, previews)";
export const RESULTS_LIST_INLINE = "Results meant for the user go inline in the chat by default (inline blocks, below); screenshots, previews, really long content and pages the user asks for";
/** Added to the end of the Claude worker handoff line for a bot with the inline guidance (not the main bot): what a worker hands back (2026-11-18, the user: "其他時候都應該使用行內組件"). */
export const INLINE_HANDOFF_SENTENCE = "A worker hands back ready-to-paste inline component JSON (inline-chart, inline-report-block), plus a read-only script in .bot/card-scripts/<name>/ that prints it when numbers need gathering; ask for a page only if the user asked or the content is really long.";

/** What the components rule says of Maintainer, and of <plugin>, for a bot with the inline guidance: the inline blocks are the bot's own. */
export const INLINE_COMPONENTS_NOTE = "  The exception is a built-in component (the inline blocks, below): every bot has them, and no request to Maintainer is needed to show one.";
export const INLINE_PLUGIN_NOTE = " A built-in component (the inline blocks) is not a request either: it is yours to use.";

/**
 * The guidance (stable, so it sits in the cacheable part of the instructions). Each example is a real report block of the user's own chats, one
 * line of JSON, checked with the report command's --check; the title states the point.
 */
export const INLINE_BLOCK_GUIDANCE = `- Inline blocks (yours to use, no request needed; for one block it replaces "never into chat"): when the main content of a reply is numbers against a baseline, a comparison or options, progress by group, a sequence in time, or a cause chain, show it as ONE block after one or two sentences, instead of a markdown table or a long list: <show name="inline-report-block">{block}</show>. Numbers per category or a before/after become a chart instead: <show name="inline-chart">{chart}</show>, kind bars (numbers per category), dumbbell (before/after) or waterfall (steps of a total); a few numbers never need a page. A block is not a sentence. Plain text stays right for explanations, hand-offs ("I started a worker") and anything with fewer than about 4 facts. Default is inline: a report page is the exception, only for really long content (more than 3 blocks, many series that need matplotlib, or a long read) or when the user explicitly asks for a report or a page (link only); everything else stays in chat. A wrong block or chart draws an error card with a valid example, so you need no usage lookup. Examples (the title states the point):
  numbers vs a baseline: {"type":"kpi","title":"實驗 3 高過 12B 的 38.5%，實驗 4 沒有","items":[{"label":"實驗 3","value":"59%","delta":"+20.5pt","deltaDir":"up_good"},{"label":"實驗 4","value":"31%","delta":"-7.5pt","deltaDir":"up_good"}]}
  progress by group: {"type":"progress","title":"103 張已合併 78 張","items":[{"label":"已合併","value":78,"max":103,"status":"done"},{"label":"擱著","value":10,"max":103,"status":"blocked"}]}
  options with a recommendation: {"type":"options","title":"推薦 1＋3：髮色加字章","criteria":["20px 分得出來","額外工作"],"options":[{"name":"1＋3 髮色加字章","recommended":true,"cells":[{"text":"分得出來","tone":"good"},{"text":"多一張遮罩","tone":"warn"}]},{"name":"只用 1","cells":[{"text":"撞色分不出","tone":"bad"},{"text":"少","tone":"good"}]}]}
  a sequence of steps or events: {"type":"steps","title":"85 + 6 = 91 人已刪","items":[{"title":"先刪 85 人","status":"done"},{"title":"再刪 6 人","status":"done"},{"title":"留 7 人","status":"active"}]}
  numbers per category (inline-chart): {"kind":"bars","title":"Haiku 比 Opus 快 3.1 倍","unit":"tokens/s","base":"Opus","items":[{"label":"Haiku","value":182},{"label":"Sonnet","value":96},{"label":"Opus","value":58}]}
  a cause chain: {"type":"flowchart","title":"撞機判雙輸，平台上輸比分","nodes":[{"id":"a","label":"撞機＝雙輸"},{"id":"b","label":"兜圈拖時間"},{"id":"c","label":"時間到比分輸","status":"blocked"}],"edges":[{"from":"a","to":"b"},{"from":"b","to":"c"}]}`;
