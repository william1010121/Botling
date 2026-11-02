// botling.git's program part: app-managed git worktrees, the Review of their changes, commit and pull request. It decides where
// each bot's session starts (`sessions.setFolder`: Botling keeps the answer, so a turn never waits on this part), keeps each
// bot's worktree list and recorded turns where the core kept them (beside its chat files), and answers its frames (web.ts).
import type { BotlingApi, SessionBot } from "../../../../Web/host/src/api";
import { WorktreeDesk } from "./desk";

const ENABLED = "botling.git.enabled";
const ROOT = "botling.git.root";

const text = (value: unknown, max = 4_096): string => (typeof value === "string" && value.length <= max ? value : "");
const must = (value: unknown, max = 4_096): string => { const found = text(value, max); if (!found) throw new Error("Not a request this view can make."); return found; };
const optional = (value: unknown, max = 64): string | null => (value === null || value === undefined ? null : must(value, max));
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? value as Record<string, unknown> : {});

export interface Options { gh?: string; openTerminal?: (path: string) => Promise<void>; platform?: NodeJS.Platform }

export async function activate(api: BotlingApi, options: Options = {}) {
  let enabled = api.settings.get<boolean | null>(ENABLED) !== false;
  let root = text(api.settings.get<string | null>(ROOT)).trim() || null;
  const dataDir = api.plugin.appDataDir ?? api.plugin.storageDir;
  /** The bots whose sessions this plugin may place, as the core last said. */
  let bots = new Map<string, SessionBot>();
  const refresh = async () => { bots = new Map((await api.sessions.bots()).map((bot) => [bot.id, bot])); return bots; };
  const profile = async (botId: string): Promise<SessionBot> => {
    const found = (await refresh()).get(botId);
    if (!found) throw new Error("No such project.");
    return found;
  };

  const desk = new WorktreeDesk({
    dataDir,
    settings: () => ({ enabled, root }),
    // The folder its session starts in changed: Botling restarts an awake bot before its next message.
    moved: (botId, reason) => {
      const bot = bots.get(botId);
      if (bot) void api.sessions.setFolder(botId, desk.assignment(bot), reason).catch(() => {});
    },
    ...options,
  });

  /** Tells the core every bot's folder, the picture it loads with (and after a setting changed). */
  const sync = async () => {
    const all = await refresh();
    const folders: Record<string, NonNullable<ReturnType<WorktreeDesk["assignment"]>>> = {};
    for (const bot of all.values()) { const assigned = desk.assignment(bot); if (assigned) folders[bot.id] = assigned; }
    await api.sessions.syncFolders(folders);
  };
  await sync().catch(() => {});

  api.subscriptions.push(
    api.settings.onChange(ENABLED, (value) => { enabled = value !== false; void sync().catch(() => {}); }),
    api.settings.onChange(ROOT, (value) => { root = text(value).trim() || null; }),
    // A turn began in a bot's session: remember its worktree's tree, so the review can show what the turn changed.
    api.events.on("turnStarted", ({ botId, turnId }) => { void profile(botId).then((bot) => desk.turnStarted(bot, turnId), () => {}); }),
  );

  /** Where the Review tab of a bot looks (set by the Worktrees block's "Review"), with a stamp so a tab open already notices. */
  const targets = new Map<string, { target: unknown; stamp: number }>();
  let stamp = 0;
  const expose = (method: string, fn: (params: Record<string, unknown>) => unknown) => api.subscriptions.push(api.ui.expose(method, (params) => fn(record(params))));
  const on = (method: string, fn: (bot: SessionBot, params: Record<string, unknown>) => unknown) => expose(method, async (params) => fn(await profile(must(params.botId, 64)), params));

  on("worktrees.list", (bot) => desk.view(bot));
  on("worktrees.create", (bot, p) => desk.create(bot, must(p.name, 80).trim(), optional(p.base, 200)?.trim() || undefined));
  on("worktrees.use", (bot, p) => desk.use(bot, optional(p.worktreeId)));
  on("worktrees.merge", (bot, p) => desk.merge(bot, must(p.worktreeId)));
  on("worktrees.discard", (bot, p) => desk.discard(bot, must(p.worktreeId), p.force === true));
  on("worktrees.terminal", (bot, p) => desk.terminal(bot, must(p.worktreeId)));
  on("worktrees.commit", (bot, p) => desk.commit(bot, must(p.worktreeId), text(p.message, 10_000)));
  on("pr.draft", (bot, p) => desk.prDraft(bot, must(p.worktreeId)));
  on("pr.create", (bot, p) => desk.prCreate(bot, must(p.worktreeId), text(p.title, 500), text(p.body, 20_000)));
  on("review.files", (bot, p) => {
    const scope = p.scope === "turn" || p.scope === "uncommitted" ? p.scope : "branch";
    return desk.reviewFiles(bot, optional(p.worktreeId), scope, optional(p.turn) ?? undefined);
  });
  on("review.diff", (bot, p) => {
    const rev = (value: unknown) => { const found = text(value, 64); if (!/^([0-9a-f]{40,64})?$/.test(found)) throw new Error("Not a revision."); return found; };
    return desk.reviewDiff(bot, optional(p.worktreeId), rev(p.from), rev(p.to), must(p.path), optional(p.oldPath, 4_096) ?? undefined, p.force === true);
  });
  // "Send to agent": the review comments are one chat message from the user to the bot that owns the worktree.
  on("chat.send", async (bot, p) => { await api.bots.send(bot.id, must(p.text, 100_000), { as: "user" }); return null; });
  on("review.open", (bot, p) => { targets.set(bot.id, { target: record(p.target), stamp: ++stamp }); return null; });
  on("review.target", (bot) => {
    const found = targets.get(bot.id) ?? { target: { worktreeId: null, branch: null, base: null, path: null }, stamp: 0 };
    return { bot: { id: bot.id, name: bot.name }, ...found };
  });
  expose("lang", () => api.settings.app<string>("language"));
  expose("settings", () => ({ enabled, root: root ?? "" }));
  expose("settings.set", async (p) => {
    if (typeof p.enabled === "boolean") { enabled = p.enabled; await api.settings.update(ENABLED, p.enabled); await sync().catch(() => {}); }
    if (typeof p.root === "string") { root = text(p.root).trim() || null; await api.settings.update(ROOT, root); }
    return { enabled, root: root ?? "" };
  });
}

