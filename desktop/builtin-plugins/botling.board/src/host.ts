import type { BotlingApi } from "../../../../Web/host/src/api";
import { PinBook, type PinChange } from "./pinbook";
import type { PinRecord } from "./pin-data";

const text = (value: unknown): value is string => typeof value === "string";
const refreshes = ["shown", "interval", "manual"] as const;
const isRefresh = (value: unknown): value is (typeof refreshes)[number] => refreshes.includes(value as never);
const corners = ["topRight", "topLeft", "bottomRight", "bottomLeft"] as const;
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter(text).slice(0, 200) : []);

/**
 * The Board's program part: it keeps every bot's pins (in this plugin's storage; the core's pins.json imported once, the file stays),
 * runs their commands through the core once the user allowed them, and tells each chat page what to draw (`chat.setData`).
 * Its web part sends what the user did to pins as the chat page's actions were (`action`).
 */
export function activate(api: BotlingApi): void {
  const book = new PinBook({
    cards: api.cards,
    load: (botId) => {
      const stored = api.storage.get(`pins:${botId}`);
      return Array.isArray(stored) ? stored : null;
    },
    save: (botId, pins: PinRecord[]) => api.storage.set(`pins:${botId}`, pins),
    publish: (botId, data) => api.chat.setData(botId, data as never),
  });
  /** The pins the user can see now, in the chat on screen. */
  let visible: { botId: string; ids: string[] } | null = null;

  /** What the user did to pins (the chat page's actions, as the app page forwarded them to the core before this plugin). */
  async function action(botId: string, a: Record<string, unknown>): Promise<unknown> {
    const change = (change: PinChange) => (text(a.id) ? book.change(botId, a.id, change) : { changed: false });
    switch (a.type) {
      case "pin":
        if (text(a.id) && isRefresh(a.refresh) && typeof a.minutes === "number") {
          return book.add(botId, a.id, { ...(text(a.messageID) ? { messageId: a.messageID } : {}), ...(typeof a.index === "number" ? { index: a.index } : {}), ...(text(a.name) ? { name: a.name } : {}) },
            a.refresh, a.minutes, typeof a.seconds === "number" ? a.seconds : undefined);
        }
        return { pinned: false };
      case "unpin": return change({ kind: "remove" });
      case "movePin": return typeof a.to === "number" ? change({ kind: "move", to: a.to }) : { changed: false };
      case "resizePin": return text(a.size) ? change({ kind: "resize", size: a.size }) : { changed: false };
      case "setPinHeight": return change({ kind: "height", height: typeof a.height === "number" ? Math.round(a.height) : null });
      case "pinStatus": return change({ kind: "status", text: text(a.text) ? a.text.slice(0, 400) : null, tone: text(a.tone) ? a.tone.slice(0, 40) : null });
      case "pinSave": return text(a.data) ? change({ kind: "save", data: a.data }) : { changed: false };
      case "floatPin": return typeof a.floating === "boolean" ? change({ kind: "float", floating: a.floating }) : { changed: false };
      case "setPinFloat":
        return change({
          kind: "floatAt",
          ...(corners.includes(a.corner as never) ? { corner: a.corner as (typeof corners)[number] } : {}),
          ...(typeof a.width === "number" ? { width: Math.round(a.width) } : {}), ...(typeof a.height === "number" ? { height: Math.round(a.height) } : {}),
          ...(typeof a.collapsed === "boolean" ? { collapsed: a.collapsed } : {}),
        });
      case "setPinRefresh":
        return isRefresh(a.refresh) ? change({ kind: "refresh", refresh: a.refresh, ...(typeof a.minutes === "number" ? { minutes: a.minutes } : {}), ...(typeof a.seconds === "number" ? { seconds: a.seconds } : {}) }) : { changed: false };
      case "arrangePins": {
        if (!Array.isArray(a.places)) return { changed: false };
        const places = (a.places as unknown[]).flatMap((entry) => {
          const place = entry as { id?: unknown; col?: unknown; row?: unknown; size?: unknown };
          return text(place.id) && typeof place.col === "number" && typeof place.row === "number"
            ? [{ id: place.id, col: Math.max(0, Math.round(place.col)), row: Math.max(0, Math.round(place.row)), ...(text(place.size) ? { size: place.size } : {}) }] : [];
        }).slice(0, 200);
        return book.arrange(botId, places);
      }
      case "pinCommand":
        return text(a.id) ? book.command(botId, a.id, { ...(text(a.command) ? { command: a.command } : {}), ...(text(a.folder) ? { folder: a.folder } : {}), ...(a.force === true ? { force: true } : {}) }) : { accepted: false };
      case "pinShown": return { ran: await book.shown(botId, Array.isArray(a.ids) ? strings(a.ids) : null) };
      case "pinsVisible": {
        const ids = strings(a.ids);
        visible = { botId, ids };
        return { ran: await book.refreshDue(botId, ids) };
      }
      default: return null;
    }
  }

  api.ui.expose("action", async (params) => {
    const { botId, action: a } = (params ?? {}) as { botId?: unknown; action?: unknown };
    if (!text(botId) || !a || typeof a !== "object") return null;
    return action(botId, a as Record<string, unknown>);
  });
  /** The chat page asks for what to draw when it has none (a bot it just opened, or the program part came back). */
  api.ui.expose("view", async (params) => {
    const { botId } = (params ?? {}) as { botId?: unknown };
    if (!text(botId)) return null;
    await book.publish(botId);
    return null;
  });
  /** The core asks whose a pin is (a link a pin's card opens, a problem report from its menu). */
  api.ui.expose("pin.owner", async (params) => {
    const { botId, id, name, strict } = (params ?? {}) as { botId?: unknown; id?: unknown; name?: unknown; strict?: unknown };
    if (!text(botId)) return null;
    return book.owner(botId, text(id) ? id : undefined, text(name) ? name : null, strict === true, book.published());
  });

  // The chat page is told again when something a pin shows changed.
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const later = (botId: string) => {
    if (pending.has(botId)) return;
    pending.set(botId, setTimeout(() => {
      pending.delete(botId);
      void book.publish(botId).catch(() => {});
    }, 400));
  };
  api.subscriptions.push(() => { for (const timer of pending.values()) clearTimeout(timer); pending.clear(); });
  api.events.on("cardChanged", ({ card }) => { void book.cardChanged(card).catch(() => {}); });
  api.events.on("componentsChanged", () => {
    book.forgetLibraries();
    for (const botId of book.published()) later(botId);
  });
  const tell = ({ botId }: { botId: string }) => { if (book.published().includes(botId) || botId === "main") later(botId); };
  api.events.on("messagePosted", tell);
  api.events.on("turnFinished", tell);

  // Pins refreshed every so often that the user can see run when their time comes (1.x: each second).
  const clock = setInterval(() => {
    if (visible) void book.refreshDue(visible.botId, visible.ids).catch(() => {});
  }, 1_000);
  clock.unref?.();
  api.subscriptions.push(() => clearInterval(clock));

  // Every bot's pins load now: its pins' notes reach the bot, and its page finds what to draw waiting.
  void (async () => {
    for (const bot of await api.bots.list()) await book.publish(bot.id).catch(() => {});
  })().catch(() => {});
}
