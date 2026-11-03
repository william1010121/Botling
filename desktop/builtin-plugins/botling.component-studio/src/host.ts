// botling.component-studio's program part: "Make into component" (the message menu's quick entry and the preview card's), a bot's
// <suggest-component> and Maintainer's <component-spec> (reply tags), the chips under replies (message decorations), the spec panel
// in the right panel's place (a takeover view) and what those draw ask here (`ui.expose`). desk.ts does the work, one step at a time.
import type { BotlingApi } from "../../../../Web/host/src/api";
import { SpecDesk, type DeskDeps } from "./desk";
import { studioOver, type Studio } from "./studio";

/** The view id the manifest names (`contributes.views`). */
export const VIEW = "botling.component-studio.spec";
const MAKE = "botling.component-studio.make";

const text = (value: unknown, max = 4_096): string => (typeof value === "string" && value.length <= max ? value : "");
const must = (value: unknown, max = 4_096): string => { const found = text(value, max); if (!found) throw new Error("Not a request this view can make."); return found; };
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? value as Record<string, unknown> : {});

export interface Options { studio?: Studio; timing?: DeskDeps["timing"] }

export async function activate(api: BotlingApi, options: Options = {}) {
  const studio = options.studio ?? studioOver((method, params) => api.studio.request(method, params as never));
  const desk = new SpecDesk({
    studio,
    decorate: (chat, decorations) => api.chat.decorate(chat, decorations),
    takeover: (chat, wide) => api.ui.takeover(chat ? VIEW : null, chat ? { bot: chat, wide } : {}),
    emit: (chat, state) => api.ui.emit("spec", { state, lang: api.settings.app<string | null>("language") }, { botId: chat }),
    clock: () => ({}),
    log: (line) => console.error(`component studio: ${line}`),
    ...(options.timing ? { timing: options.timing } : {}),
  });
  await desk.load().catch((error) => console.error(`component studio: ${(error as Error).message}`));

  api.subscriptions.push(
    // A bot's <suggest-component name="…">draft</suggest-component>: a chip under its reply.
    api.replyTags.on("suggest-component", (tag) => {
      const name = (tag.attributes.name ?? "").trim();
      if (name) void desk.suggest(name, tag.body, tag.bot.id).catch((error) => console.error(`component studio: ${(error as Error).message}`));
    }),
    // Maintainer's <component-spec id="…">json</component-spec>: into that spec.
    api.replyTags.on("component-spec", (tag) => {
      const id = (tag.attributes.id ?? "").trim();
      if (id) void desk.componentSpec(tag.bot.id, id, tag.body).catch((error) => console.error(`component studio: ${(error as Error).message}`));
    }),
    // The library changed: specs being built whose component landed are finished.
    api.events.on("libraryChanged", () => { void desk.finishBuilds().catch(() => {}); }),
    api.events.on("cardChanged", ({ card }) => { void desk.cardChanged(card).catch(() => {}); }),
    api.events.on("maintainerReplied", ({ role, text: said, running }) => { void desk.settleChanges({ role, text: said }, running).catch(() => {}); }),
    // "Make into component" on a reply (the message menu: its bot and message) or on one of its result pages' preview cards (and which card).
    api.commands.register(MAKE, async (...args: unknown[]) => {
      const [botId, messageId, preview] = args.map((arg) => (typeof arg === "string" ? arg : ""));
      if (!botId || !messageId) return;
      const card = preview !== undefined && /^[0-2]$/.test(preview) ? Number(preview) : null;
      await desk.make(botId, messageId, null, card);
    }),
  );

  const expose = (method: string, fn: (params: Record<string, unknown>) => unknown) => api.subscriptions.push(api.ui.expose(method, (params) => fn(record(params))));
  const id = (p: Record<string, unknown>) => must(p.id, 64);
  // The chips' and the panel's asks (SpecAction): each answers whether it was taken and, for a run that waits for your OK, what the sheet must ask.
  expose("make", async (p) => {
    const spec = await desk.make(must(p.botId, 128), must(p.messageId, 200), text(p.purpose, 4_000) || null, typeof p.preview === "number" && Number.isInteger(p.preview) && p.preview >= 0 && p.preview <= 2 ? p.preview : null);
    return { specId: spec?.id ?? null };
  });
  expose("press", (p) => desk.press(id(p)));
  expose("open", (p) => desk.openSpec(id(p)));
  expose("undo", (p) => desk.undo(id(p)));
  expose("restore", (p) => desk.restore(id(p)));
  expose("edit", (p) => desk.editValue(id(p), must(p.key, 40), text(p.value, 20_000)));
  expose("answer", (p) => {
    const option = p.option;
    if (typeof option !== "number" || !Number.isInteger(option) || option < 0 || option >= 20) throw new Error("Not an option.");
    return desk.answer(id(p), must(p.question, 200), option);
  });
  expose("say", (p) => desk.say(id(p), text(p.text, 20_000), typeof p.request === "string" ? p.request.slice(0, 200) : null));
  expose("testRun", (p) => desk.testRun(id(p), must(p.command, 20_000), must(p.folder, 4_000)));
  expose("command", (p) => desk.runComponent(id(p), { command: must(p.command, 20_000), folder: must(p.folder, 4_000), ...(typeof p.detail === "string" && p.detail ? { detail: p.detail.slice(0, 20_000) } : {}), ...(p.force === true ? { force: true } : {}) }));
  expose("build", (p) => desk.build(id(p)));
  expose("cancel", (p) => desk.cancel(id(p)));
  expose("close", async () => { await desk.closePanel(); return null; });
  expose("wide", async (p) => { await desk.setWide(p.wide === true); return null; });
  expose("state", (p) => desk.state(must(p.botId, 128)));
  expose("lang", () => api.settings.app<string | null>("language"));
  return desk;
}
