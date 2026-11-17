// botling.component-studio's program part: a bot's <suggest-component> and Maintainer's <component-spec> (reply tags), the chips under
// replies (message decorations) and what those draw ask here (`ui.expose`). desk.ts does the work, one step at a time.
import type { BotlingApi } from "../../../../Web/host/src/api";
import { SpecDesk, type DeskDeps } from "./desk";
import { studioOver, type Studio } from "./studio";

const text = (value: unknown, max = 4_096): string => (typeof value === "string" && value.length <= max ? value : "");
const must = (value: unknown, max = 4_096): string => { const found = text(value, max); if (!found) throw new Error("Not a request the chips can make."); return found; };
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? value as Record<string, unknown> : {});

export interface Options { studio?: Studio; timing?: DeskDeps["timing"] }

export async function activate(api: BotlingApi, options: Options = {}) {
  const studio = options.studio ?? studioOver((method, params) => api.studio.request(method, params as never));
  const desk = new SpecDesk({
    studio,
    decorate: (chat, decorations) => api.chat.decorate(chat, decorations),
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
  );

  const expose = (method: string, fn: (params: Record<string, unknown>) => unknown) => api.subscriptions.push(api.ui.expose(method, (params) => fn(record(params))));
  const id = (p: Record<string, unknown>) => must(p.id, 64);
  // The chips' asks (SpecAction): each answers whether it was taken and, for a run that waits for your OK, what the sheet must ask.
  expose("press", (p) => desk.press(id(p)));
  expose("undo", (p) => desk.undo(id(p)));
  expose("restore", (p) => desk.restore(id(p)));
  expose("command", (p) => desk.runComponent(id(p), { command: must(p.command, 20_000), folder: must(p.folder, 4_000), ...(typeof p.detail === "string" && p.detail ? { detail: p.detail.slice(0, 20_000) } : {}), ...(p.force === true ? { force: true } : {}) }));
  return desk;
}
