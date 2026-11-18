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

/** The sentence of botling.report's page rule that says when a page is made: only on the user's ask (the manifest's text, byte for byte; a test holds it). */
export const REPORT_RULE_ALL_TO_PAGE = "A report page is made ONLY when the user explicitly asks for a report or a page, or after you asked in the chat (\"Do you want this as a report page?\") and the user agreed; never on your own, however long or visual the result is. Without that, the result stays in chat as text. When a page is made, the chat reply carries only a brief conclusion and the link to the page; never paste the report body into chat.";
/** What it says for a bot with the inline guidance: the same ask-only rule, with inline blocks as the way to show a result. */
export const REPORT_RULE_BY_SIZE = "Default is inline; a report page is made only when asked. A settled result that is one table, KPI row, comparison, timeline or flow goes into ONE inline report block in the chat reply (the inline blocks rule), and a chart into ONE inline chart (inline-chart) or a matplotlib PNG shown inline (the chart rule); long content goes in as several blocks or as text. Make a report page ONLY when the user explicitly asks for a report or a page, or after you asked in the chat (\"Do you want this as a report page?\") and the user agreed; never on your own, however long the content is. The chat reply then carries only a brief conclusion and the link to the page; never paste the report body into chat.";
/** The page rule's text for a bot with the inline guidance (the sentence swapped; any other wording of a plugin's own stays as it is). */
export const inlineReportRule = (text: string): string => text.replace(REPORT_RULE_ALL_TO_PAGE, () => REPORT_RULE_BY_SIZE);

/** The results rule's list of what goes to a page (prompts.ts), and the same list without comparisons for a bot with the inline guidance. */
export const RESULTS_LIST = "Results meant for the user (a report or comparison only when the user asks or agrees after you ask in the chat; screenshots, previews)";
export const RESULTS_LIST_INLINE = "Results meant for the user go inline in the chat by default (inline blocks, below); screenshots, previews and pages the user asks for (or agrees to after you ask in the chat)";
/** Added to the end of the Claude worker handoff line for a bot with the inline guidance (not the main bot): what a worker hands back: the data and a script, shown by a <card>, never component JSON (2026-11-18, the user). */
export const INLINE_HANDOFF_SENTENCE = "A worker hands back the data (numbers or rows, concise) plus, when it had to be gathered, the path of a re-runnable read-only script in .bot/card-scripts/<name>/ that prints it, never component JSON; you show it with a <card> (what to show, where the data or script is). A page only if the user asked or agreed after you asked.";

/** What the components rule says of Maintainer, and of <plugin>, for a bot with the inline guidance: the inline blocks are the bot's own. */
export const INLINE_COMPONENTS_NOTE = "  The exception is a built-in component (the inline blocks, below): every bot has them, and no request to Maintainer is needed to show one.";
export const INLINE_PLUGIN_NOTE = " A built-in component (the inline blocks) is not a request either: it is yours to use.";

/**
 * The guidance (stable, so it sits in the cacheable part of the instructions). Each example is a real report block of the user's own chats, one
 * line of JSON, checked with the report command's --check (the chart ones by inline-chart's own drawer, a test holds it); the title states the point.
 * A kind named in the text above has an example here: a bot guessed the shape of one without (waterfall `items` for `steps`, 2026-11-18).
 */
export const INLINE_EXAMPLES = `  numbers vs a baseline: {"type":"kpi","title":"實驗 3 高過 12B 的 38.5%，實驗 4 沒有","items":[{"label":"實驗 3","value":"59%","delta":"+20.5pt","deltaDir":"up_good"},{"label":"實驗 4","value":"31%","delta":"-7.5pt","deltaDir":"up_good"}]}
  progress by group: {"type":"progress","title":"103 張已合併 78 張","items":[{"label":"已合併","value":78,"max":103,"status":"done"},{"label":"擱著","value":10,"max":103,"status":"blocked"}]}
  options with a recommendation: {"type":"options","title":"推薦 1＋3：髮色加字章","criteria":["20px 分得出來","額外工作"],"options":[{"name":"1＋3 髮色加字章","recommended":true,"cells":[{"text":"分得出來","tone":"good"},{"text":"多一張遮罩","tone":"warn"}]},{"name":"只用 1","cells":[{"text":"撞色分不出","tone":"bad"},{"text":"少","tone":"good"}]}]}
  a sequence of steps or events: {"type":"steps","title":"85 + 6 = 91 人已刪","items":[{"title":"先刪 85 人","status":"done"},{"title":"再刪 6 人","status":"done"},{"title":"留 7 人","status":"active"}]}
  numbers per category (inline-chart): {"kind":"bars","title":"Haiku 比 Opus 快 3.1 倍","unit":"tokens/s","base":"Opus","items":[{"label":"Haiku","value":182},{"label":"Sonnet","value":96},{"label":"Opus","value":58}]}
  time per step (inline-chart): {"kind":"waterfall","title":"載入 plugin 佔 89%","unit":"ms","steps":[{"label":"啟動","value":180},{"label":"載入 plugin","value":1480,"hot":true}]}
  before / after per row (inline-chart): {"kind":"dumbbell","title":"開啟變快 62%","unit":"ms","better":"lower","rows":[{"label":"開啟聊天","before":820,"after":310}]}
  a trend over time (inline-chart): {"kind":"line","title":"回應時間 5 週降 46%","unit":"s","better":"lower","x":["W42","W43"],"series":[{"name":"p50","values":[2.4,1.3]}]}
  a cause chain: {"type":"flowchart","title":"撞機判雙輸，平台上輸比分","nodes":[{"id":"a","label":"撞機＝雙輸"},{"id":"b","label":"兜圈拖時間"},{"id":"c","label":"時間到比分輸","status":"blocked"}],"edges":[{"from":"a","to":"b"},{"from":"b","to":"c"}]}`;
export const INLINE_BLOCK_GUIDANCE = `- Inline blocks (yours to use, no request needed; for one block it replaces "never into chat"): when the main content of a reply is numbers against a baseline, a comparison or options, progress by group, a sequence in time, or a cause chain, show it as ONE block after one or two sentences, instead of a markdown table or a long list: <show name="inline-report-block">{block}</show>. Charts: first decide what the figure must show (groups side by side, time axis, error bars, measured vs estimated). Use <show name="inline-chart">{chart}</show> (kind bars, dumbbell, waterfall or line) only if it shows that clearly; otherwise draw it with Python matplotlib as a PNG shown with ![caption](file://full path), script read-only in .bot/card-scripts/<name>/ when numbers need gathering; never a page for a chart. A block is not a sentence. Plain text stays right for explanations, hand-offs ("I started a worker") and anything with fewer than about 4 facts. Default is inline: a report page is made only when the user explicitly asks for a report or a page, or after you asked in the chat and they agreed (link only); long content goes in as several blocks or as text. A wrong block or chart draws an error card with a valid example; the examples below need no usage lookup, but for any other kind or type call app_component_usage first. Examples (the title states the point):
${INLINE_EXAMPLES}`;

/**
 * What a Claude head that reaches components through `<card>` is told instead of INLINE_BLOCK_GUIDANCE (2026-11-18, the user: head bots only write `<card>`):
 * only when to use one. The chart rule and the examples are the card worker's own fixed instructions (worker-cards.ts `cardSystemPrompt`), where they are cached.
 */
export const CARD_WHEN_RULE = "- Inline blocks and charts (the inline blocks rule, the chart rule; yours to use, no request needed, for one block it replaces \"never into chat\"): when the main content of a reply is numbers against a baseline, a comparison or options, a chart, progress by group, a timeline or a cause chain, say one or two sentences and write ONE <card> for it (its worker draws the blocks and charts, several side by side when the data needs them: say so in the card); never a markdown table, a long list or a report page for them, and never draw one yourself with <show>. Plain text stays right for explanations, hand-offs (\"I started a worker\") and anything with fewer than about 4 facts. Default is inline: a report page is made only when the user explicitly asks for a report or a page, or after you asked in the chat and they agreed (link only); long content goes in as several blocks or as text.";

/** The chart rule and the examples the card worker is given (its fixed system prompt): the guidance's own text, so a change is made once. */
export const CARD_CHART_RULE = "Charts: first decide what the figure must show (groups side by side, time axis, error bars, measured vs estimated). Use inline-chart (kind bars, dumbbell, waterfall or line) only if it shows that clearly; otherwise draw it with Python matplotlib as a PNG shown with ![caption](file://full path). A block is not a sentence: use inline-report-block when the content is numbers against a baseline, a comparison or options, progress by group, a sequence in time, or a cause chain, never a markdown table. When the card needs several figures (for example several bar charts to compare), end with one <show> for each, in the order they should read.";

/**
 * Whether a head writes only `<card>` for blocks and charts (CARD_WHEN_RULE in its prompt instead of INLINE_BLOCK_GUIDANCE): a Claude head whose workers are the app's
 * and that has the guidance. Maintainer is no such head: a card of its own would hand the chart it describes back to itself, so it keeps the guidance and draws.
 */
export const headWritesCards = (engine: string, appWorkers: boolean, guidance: boolean, isMaintainer: boolean): boolean =>
  guidance && engine === "claude" && appWorkers && !isMaintainer;
