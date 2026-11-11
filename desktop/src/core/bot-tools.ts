// The tools every engine's bot answers itself, in the core, for its coordinator and its workers alike: the in-app
// browser tools (browser-tools.ts), the Note tools (note-tools.ts) and app_component_usage. Each engine hands a call here with who made it
// (`caller`): a worker gets only the read tools of the Note, and is refused a write even if it named one.
import { isBrowserTool, type BrowserToolName } from "../browser-bot";
import { isNoteTool, type NoteToolName, type ToolCaller } from "./note-tools";

export type { ToolCaller } from "./note-tools";
/** A coordinator reads one component's whole usage when it needs it (bot.ts `componentUsage`); workers never get it. */
export const COMPONENT_USAGE_TOOL = "app_component_usage";
export type BotToolName = BrowserToolName | NoteToolName | typeof COMPONENT_USAGE_TOOL;
export const isBotTool = (name: string): name is BotToolName => isBrowserTool(name) || isNoteTool(name) || name === COMPONENT_USAGE_TOOL;
/** Runs one bot tool call (bot.ts `botTool`); `caller` defaults to the coordinator. */
export type BotToolRunner = (name: BotToolName, args: Record<string, unknown>, caller?: ToolCaller) => Promise<unknown>;
