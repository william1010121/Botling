// The tools every engine's bot answers itself, in the core, for its coordinator and its workers alike: the in-app
// browser tools (browser-tools.ts) and the Note tools (note-tools.ts). Each engine hands a call here with who made it
// (`caller`): a worker gets only the read tools of the Note, and is refused a write even if it named one.
import { isBrowserTool, type BrowserToolName } from "../browser-bot";
import { isNoteTool, type NoteToolName, type ToolCaller } from "./note-tools";

export type { ToolCaller } from "./note-tools";
export type BotToolName = BrowserToolName | NoteToolName;
export const isBotTool = (name: string): name is BotToolName => isBrowserTool(name) || isNoteTool(name);
/** Runs one bot tool call (bot.ts `botTool`); `caller` defaults to the coordinator. */
export type BotToolRunner = (name: BotToolName, args: Record<string, unknown>, caller?: ToolCaller) => Promise<unknown>;
