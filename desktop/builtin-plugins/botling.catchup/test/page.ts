// The real chat page (Web/src/main.ts) in jsdom with this plugin's web part loaded the way Botling
// loads it (PluginHost.sync), and summaries handed to it as the decorations its program part makes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { desktop } from "../../../test/helpers";
import { PluginHost, type PluginSpec } from "../../../../Web/src/plugins";
import type { ChatState, DecorationView, MessageView } from "../../../../Web/src/types";
import manifest from "../package.json";
import type { CatchUpView } from "../src/types";
import { activate } from "../src/web";

export const catchupCSS = readFileSync(join(desktop, "builtin-plugins", "botling.catchup", "catchup.css"), "utf8");
export const chatCSS = readFileSync(join(desktop, "..", "Web", "src", "chat.css"), "utf8");

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

/** Opens the chat page with the web part loaded (once per test file). */
export async function openPage(): Promise<void> {
  document.body.innerHTML = `<main id="scroller"><div id="messages"></div></main><div id="composer-slot"></div>`;
  // A web part's source is imported from a Blob URL, which jsdom cannot do: this one is handed in instead.
  const sync = PluginHost.prototype.sync;
  PluginHost.prototype.sync = function (specs: PluginSpec[]) { return sync.call(this, specs, async () => activate); };
  await import("../../../../Web/src/main");
  await window.ccb.setPlugins([{ name: manifest.name, version: manifest.version, source: "bundled", styles: [], settings: {}, commands: [] }]);
}

/** A summary as the program part puts it in the chat. */
export function decoration(view: CatchUpView, kind: "unread" | "interval" = view.kind ?? "unread"): DecorationView {
  const { tasks, ...data } = view;
  return { plugin: manifest.name, key: `${kind}:${view.key}`, fold: view.ids, tasks: tasks ?? null, data: { ...data, kind } };
}

/** The old ChatState shape (the folded group, the interval summaries) as decorations. */
export function withSummaries(state: ChatState & { catchUp?: CatchUpView | null; intervalSummaries?: CatchUpView[] }): ChatState {
  const { catchUp, intervalSummaries, ...rest } = state;
  return { ...rest, decorations: [...(catchUp ? [decoration(catchUp, "unread")] : []), ...(intervalSummaries ?? []).map((view) => decoration(view, "interval"))] };
}

export const line = (id: string, role: MessageView["role"] = "bot"): MessageView => ({
  id, role, text: `text ${id}`, stamp: null, avatar: role === "bot" ? `face-${id}` : null, choices: null,
  chosen: null, answer: null, open: false, attachments: null, replyTo: null, replyPreview: null, openable: false,
});
