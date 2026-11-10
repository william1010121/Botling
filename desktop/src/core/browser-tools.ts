// The bot tools on the user's in-app browser pane (phase 2, browser-bot.ts): app_browser_tabs, app_browser_open,
// app_browser_requests and app_browser_extract, for every engine's coordinators and workers (app-tools/registry.ts).
// The core checks a call, asks main over the `browser` app op (core-client.ts → browser-bot-host.ts) and shapes the
// answer for the model: small results inline; data asked to be saved (or too big to read inline) goes to a file in
// the bot's `.bot/browser/` (git-ignored), whose path the bot links in its reply so the user gets it in the chat.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserRequest, csvRows, toCsv, type BrowserToolName, type CapturedRequest, type SaveAs } from "../browser-bot";
import type { AppAnswer } from "./server";

export type BrowserBridge = (request: string) => Promise<AppAnswer>;

let bridge: BrowserBridge | null = null;
/** Main's side, set once by the core (null: no app, a headless core). */
export function setBrowserBridge(next: BrowserBridge | null): void { bridge = next; }

/** About this much of a result is read inline; more goes to a file. */
export const INLINE_MAX = 60_000;
const INLINE_BODY = 6_000;
const SAVES: readonly SaveAs[] = ["json", "csv", "txt"];

export interface BrowserToolContext {
  botId: string;
  /** The bot's own folder (its `.bot/browser/` takes saved data). */
  folder: string;
  bridge?: BrowserBridge | null;
  now?: () => Date;
}

/** One bot tool call: its result for the model, or a thrown error it reads (nothing was done). */
export async function runBrowserTool(name: BrowserToolName, args: Record<string, unknown>, context: BrowserToolContext): Promise<unknown> {
  const ask = context.bridge === undefined ? bridge : context.bridge;
  if (!ask) throw new Error("The in-app browser is not available here (no app window).");
  const save = args.save_as === undefined || args.save_as === null || args.save_as === "" ? null : args.save_as;
  if (save !== null && !SAVES.includes(save as SaveAs)) throw new Error(`save_as must be one of ${SAVES.join(", ")}.`);
  const request = browserRequest(context.botId, name, args);
  const answer = await ask(JSON.stringify(request));
  if (!answer.ok) throw new Error(answer.error || "The browser did not answer.");
  const data = answer.data as Record<string, unknown>;
  if (request.op === "requests") return shapeRequests(data, save as SaveAs | null, context);
  if (request.op === "extract") return shapeExtract(data, save as SaveAs | null, context);
  return data;
}

function saveFile(context: BrowserToolContext, data: Record<string, unknown>, label: string, extension: SaveAs, text: string): string {
  const folder = join(context.folder, ".bot", "browser");
  mkdirSync(folder, { recursive: true });
  const stamp = (context.now?.() ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  let host = "page";
  try { host = new URL(String(data.url ?? "")).hostname.replace(/^www\./, "").replace(/[^A-Za-z0-9.-]/g, "") || "page"; } catch { /* page */ }
  const file = join(folder, `${stamp}-${host}-${label}.${extension}`);
  writeFileSync(file, text);
  return file;
}

const LINK_NOTE = "Give the user this file as a Markdown link to its full path in your reply (it opens from the chat); do not paste its contents.";

function shapeRequests(data: Record<string, unknown>, save: SaveAs | null, context: BrowserToolContext): unknown {
  const requests = (Array.isArray(data.requests) ? data.requests : []) as CapturedRequest[];
  const summary = requests.map((r) => ({ id: r.id, method: r.method, type: r.type, status: r.status, url: r.url.slice(0, 300) }));
  const full = JSON.stringify(data, null, 1);
  if (save || full.length > INLINE_MAX) {
    const file = saveFile(context, data, "requests", "json", full);
    const { requests: _all, ...rest } = data;
    return { ...rest, file, requests: summary.slice(-100), note: `${save ? "Saved" : "Too much to read inline; saved"} in full (headers${requests.some((r) => r.body !== undefined) ? ", bodies" : ""}) as JSON. ${LINK_NOTE}` };
  }
  // Inline: long bodies cut so a few requests fit; the file has them whole.
  const cut = requests.map((r) => r.body !== undefined && r.body.length > INLINE_BODY ? { ...r, body: r.body.slice(0, INLINE_BODY), bodyTruncated: true } : r);
  return { ...data, requests: cut };
}

function shapeExtract(data: Record<string, unknown>, save: SaveAs | null, context: BrowserToolContext): unknown {
  const value = data.data;
  const label = String(data.what ?? "data");
  const json = JSON.stringify(value, null, 1) ?? "null";
  let kind = save;
  if (!kind && json.length > INLINE_MAX) kind = typeof value === "string" ? "txt" : "json";
  if (!kind) return data;
  let text: string;
  if (kind === "csv") {
    const rows = csvRows(value);
    if (!rows) throw new Error("This result is not rows (a list of lists or of objects, or tables); save it as json or txt instead.");
    text = toCsv(rows);
  } else if (kind === "txt") text = typeof value === "string" ? value : json;
  else text = json;
  const file = saveFile(context, data, label, kind, text);
  const { data: _value, ...rest } = data;
  const preview = typeof value === "string" ? value.slice(0, 1_500) : json.slice(0, 1_500);
  return { ...rest, file, ...(Array.isArray(value) ? { items: value.length } : {}), preview, note: `${save ? "Saved" : "Too much to read inline; saved"} as ${kind}. ${LINK_NOTE}` };
}
