// botling.note, program part: the note is read and saved only through the app's notes API (api.notes.*, "files"
// permission); the app says where the file is. What the Note tab's frame asks for (`ccb.host.call`) and the note events
// it hears (`ccb.on`). Built into Botling since 2.7.0 (it was the library's main.js until 1.19.0, written for older apps
// too: the guards for a missing notes method or event stay, so the same code also runs as a newer library copy).
import type { BotlingApi } from "../../../../Web/host/src/api";
import { activateMargin } from "./margin";

type Params = Record<string, unknown>;
type Notes = BotlingApi["notes"];

const paramsOf = (params: unknown): Params => (params && typeof params === "object" ? params as Params : {});
const botOf = (params: Params): string => {
  const id = params.botId;
  if (typeof id !== "string" || !id) throw new Error("No bot.");
  return id;
};
const base = (params: Params) => (typeof params.base === "number" ? { base: params.base } : {});

export function activate(api: BotlingApi) {
  const need = <K extends keyof Notes>(name: K): Notes[K] => {
    if (typeof api.notes?.[name] !== "function") throw new Error(`unavailable: notes.${name}`);
    return (api.notes[name] as (...args: never[]) => unknown).bind(api.notes) as Notes[K];
  };
  const expose = (method: string, fn: (params: Params) => unknown) => api.ui.expose(method, (params) => fn(paramsOf(params)));
  api.subscriptions.push(
    expose("read", async (params) => {
      const note = await api.notes.read(botOf(params));
      return { text: note.text, mtime: note.mtime };
    }),
    expose("write", (params) => api.notes.write(botOf(params), String(params.text ?? ""), base(params))),
    expose("importAsset", (params) => need("importAsset")(botOf(params), { data: String(params.data ?? ""), name: String(params.name ?? "image.png") })),
    expose("assetUrls", (params) => need("assetUrls")(botOf(params), Array.isArray(params.refs) ? params.refs.map(String) : [])),
    expose("localizeImages", (params) => need("localizeImages")(botOf(params), base(params))),
    // Where the reader was in a note: the route shown at each branch ({ fork key: route name }; a nested branch's key holds
    // its parent route, so every route keeps its own sub-routes) and the line / scroll. Kept per bot in the plugin's
    // storage (ccb.storage), never in note.md: the note's frame is sandboxed and has no localStorage of its own.
    expose("viewGet", (params) => {
      const view = typeof api.storage?.get === "function" ? api.storage.get(`view:${botOf(params)}`) : null;
      return view && typeof view === "object" ? view : null;
    }),
    expose("viewSet", (params) => {
      const id = botOf(params);
      if (typeof api.storage?.set !== "function") throw new Error("unavailable: storage");
      const view = paramsOf(params.view);
      const routes: Record<string, string> = {};
      for (const [key, route] of Object.entries(paramsOf(view.routes)).slice(0, 2000)) if (typeof route === "string") routes[String(key).slice(0, 2000)] = route.slice(0, 500);
      const at = view.pos && typeof view.pos === "object" ? view.pos as Params : null;
      const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);
      const pos = at ? { line: num(at.line), caret: num(at.caret), scroll: num(at.scroll), editing: !!at.editing, text: String(at.text ?? "").slice(0, 500) } : null;
      const folds: Record<string, true> = {};
      for (const [key, folded] of Object.entries(paramsOf(view.folds)).slice(0, 2000)) if (folded === true) folds[String(key).slice(0, 2000)] = true;
      api.storage.set(`view:${id}`, { routes, pos, folds });
      return { saved: true };
    }),
    api.events.on("noteChanged", ({ botId, mtime }) => {
      api.ui.emit("noteChanged", { botId, mtime }, { botId });
    }),
    // Live cards (`<show>` lines). `text`: the editor's words, saved or not. Each card comes with where it is (lines, as
    // notes.parse reads them) and what it draws now (notes.cards).
    expose("cards", async (params) => {
      const botId = botOf(params);
      const text = String(params.text ?? "");
      const [parsed, states] = await Promise.all([need("parse")(text), need("cards")(botId, { text })]);
      const byKey = new Map((states ?? []).map((state) => [state.key, state]));
      return (parsed?.cards ?? []).map((card) => ({ ...(byKey.get(card.key) ?? {}), key: card.key, name: card.name, line: card.line, endLine: card.endLine, refresh: card.refresh }));
    }),
    expose("runCard", (params) => {
      const opts = { ...(params.force ? { force: true } : {}), ...(typeof params.text === "string" ? { text: params.text } : {}) };
      return need("runCard")(botOf(params), String(params.key ?? ""), opts);
    }),
    expose("components", (params) => need("components")(botOf(params))),
    // How the app cuts a text into cells and branches (notes.parse `cells` / `branches`); null from an app whose parse has
    // none: the editor then follows its own bundled copy of the rules (desktop/src/core/note-cells.ts, the same file).
    expose("parse", async (params) => {
      const parsed = await need("parse")(String(params.text ?? "")) as { cells?: unknown; branches?: unknown } | null;
      return parsed && Array.isArray(parsed.cells) ? { cells: parsed.cells, branches: Array.isArray(parsed.branches) ? parsed.branches : null } : null;
    }),
    // The ids note.db gives the cells and forks of the editor's text (notes.outline), for the 問 quote's first line; null
    // from an app without it (the quote then has no id line).
    expose("outline", (params) => {
      if (typeof api.notes?.outline !== "function") return null;
      return api.notes.outline(botOf(params), typeof params.text === "string" ? { text: params.text } : {});
    }),
  );
  // Margin comments (旁註): a question on a passage, the bot's answer and the follow-ups, kept beside the Note (margin.ts, MARGIN.md).
  api.subscriptions.push(...activateMargin(api, expose));
  // A card's run started or finished: tell the bot's Note tab (an app without this event: the tab polls while a card runs).
  try {
    api.subscriptions.push(api.events.on("noteCardChanged", ({ botId, key }) => api.ui.emit("noteCardChanged", { botId, key }, { botId })));
  } catch { /* older app: no noteCardChanged */ }
  // An edit made in note.md could not be taken into note.db (made on an older copy of a cell): it is kept as `file`.
  try {
    api.subscriptions.push(api.events.on("noteConflict", ({ botId, file, reason }) => api.ui.emit("noteConflict", { botId, file, reason }, { botId })));
  } catch { /* older app: no noteConflict */ }
}
