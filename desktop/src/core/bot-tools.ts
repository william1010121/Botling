// The tools every engine's bot answers itself, in the core, for its coordinator and its workers alike: the in-app
// browser tools (browser-tools.ts), the Note tools (note-tools.ts), app_component_usage and app_fetch. Each engine hands a call here with who made it
// (`caller`): a worker gets only the read tools of the Note, and is refused a write even if it named one.
import { isBrowserTool, type BrowserToolName } from "../browser-bot";
import { isNoteTool, type NoteToolName, type ToolCaller } from "./note-tools";

export type { ToolCaller } from "./note-tools";
/** A coordinator reads one component's whole usage when it needs it (bot.ts `componentUsage`); workers never get it. */
export const COMPONENT_USAGE_TOOL = "app_component_usage";
/** A coordinator fetches a file or folder from another machine (M5-07d, bot.ts `fetchTool`); workers never get it. */
export const FETCH_TOOL = "app_fetch";
export type BotToolName = BrowserToolName | NoteToolName | typeof COMPONENT_USAGE_TOOL | typeof FETCH_TOOL;
export const isBotTool = (name: string): name is BotToolName => isBrowserTool(name) || isNoteTool(name) || name === COMPONENT_USAGE_TOOL || name === FETCH_TOOL;
/** Runs one bot tool call (bot.ts `botTool`); `caller` defaults to the coordinator. */
export type BotToolRunner = (name: BotToolName, args: Record<string, unknown>, caller?: ToolCaller) => Promise<unknown>;

/** What a coordinator asks `app_fetch` for (M5-07d); the wire's own limits (protocol/fetch.ts: path 4096, purpose 500, 500 MiB). */
export interface FetchRequest { machine: string; path: string; purpose: string; maxBytes?: number }
export const FETCH_MAX_REQUEST_BYTES = 524_288_000;
/** The tool's arguments as a request, or an error the model can read; checked here, before anything is sent to a peer. */
export function parseFetchRequest(args: Record<string, unknown>): FetchRequest {
  const { machine, path, purpose, max_bytes: maxBytes } = args;
  const bad = new Error(`app_fetch needs machine, path and purpose as text (path up to 4096 characters, purpose up to 500) and, when given, max_bytes as a whole number from 1 to ${FETCH_MAX_REQUEST_BYTES}.`);
  if (typeof machine !== "string" || !machine.trim()) throw bad;
  if (typeof path !== "string" || !path || path.length > 4096 || path.includes("\0")) throw bad;
  if (typeof purpose !== "string" || !purpose.trim() || purpose.length > 500) throw bad;
  if (maxBytes !== undefined && maxBytes !== null && (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > FETCH_MAX_REQUEST_BYTES)) throw bad;
  return { machine: machine.trim(), path, purpose, ...(typeof maxBytes === "number" ? { maxBytes } : {}) };
}
