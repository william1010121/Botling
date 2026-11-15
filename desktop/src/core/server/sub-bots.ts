// M7-S63: `CoreSubBots` cut out of `Core` (core/server.ts). The hidden sub bots under a project bot: the <sub-bot>, <remove-sub-bot> and <remove-bot>
// tags, making and closing a sub bot, and its "done" notice to the project bot. Same bridge convention as `CoreWatch` (core/server/watch.ts, in its
// header): a block of one-line forwarders to `host` first, then the members as they were in `Core`, byte for byte (a member that `Core` or another
// collaborator calls lost its `private`; `removeSubBotRequested` reaches `closeSubBot` through `host`, so that a spy on `Core.closeSubBot` sees it).
import type { Core } from "../server";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "../durable/atomic";
import { botName, folderPath, folderURLText, saveProjectRow } from "../projects";
import { ContractError, type ResultOf } from "../../contract";
import { type AgentRecord } from "../agent-registry";
import { subBotClosedNotice } from "../agent-relay";
import { Bot } from "../bot";
import { type Engine } from "../heads";
import { projectProfile, type BotProfile } from "../store/workspace";
import { handoffFile, progressFile, progressStatus, runHandoff, fallbackHandoff, subBotFirstMessage, subBotDirectFirstMessage, directSubBotEngine, SUB_BOT_WAIT_MS, safeToken, subBotEngine, wrapUpMessage } from "../sub-bots";

export class CoreSubBots {
  constructor(private readonly host: Core) {}

  // The bridge: everything this class borrows from `Core`.
  private agentBotName(...a: Parameters<Core["agentBotName"]>) { return this.host.agentBotName(...a); }
  private agentFlags(...a: Parameters<Core["agentFlags"]>) { return this.host.agentFlags(...a); }
  private get agents() { return this.host.agents; }
  private attach(...a: Parameters<Core["attach"]>) { return this.host.attach(...a); }
  private get bots() { return this.host.bots; }
  private checkBot(...a: Parameters<Core["checkBot"]>) { return this.host.checkBot(...a); }
  private log(...a: Parameters<Core["log"]>) { return this.host.log(...a); }
  private get maintainerId() { return this.host.maintainerId; }
  private moveOwners(...a: Parameters<Core["moveOwners"]>) { return this.host.moveOwners(...a); }
  private get options() { return this.host.options; }
  private get profiles() { return this.host.profiles; }
  private removeBot(...a: Parameters<Core["removeBot"]>) { return this.host.removeBot(...a); }
  private get removed() { return this.host.removed; }
  private seedEngineDefaults(...a: Parameters<Core["seedEngineDefaults"]>) { return this.host.seedEngineDefaults(...a); }
  private singleEngine(...a: Parameters<Core["singleEngine"]>) { return this.host.singleEngine(...a); }
  private writeInstructions(...a: Parameters<Core["writeInstructions"]>) { return this.host.writeInstructions(...a); }

  private movingSubagents = new Set<string>();

  /** Sub bots that already told their project bot they were done. */
  subBotsReported = new Set<string>();

  /**
   * A project bot's <sub-bot name="…" subagent="id"/>: the subagent (a Claude subagent, a Codex worker or an Antigravity
   * worker) is asked to write handoff.md and end (Claude: by the project bot's own SendMessage; a Codex worker: by the app,
   * joined into its turn; an Antigravity worker takes no message while it works, so it is stopped at once) and waited for
   * (and stopped, with the file written here, only if it does not end in time); then a hidden sub bot is made in the same
   * folder, on the worker's engine when the project bot has it, and handed the file. A request that cannot be done says
   * why in the chat, never silently.
   */
  async subBotRequested(bot: Bot, request: { name: string; subagent: string; note: string; engine?: string; subagents?: string[] }): Promise<void> {
    const profile = bot.profile;
    const refuse = (why: string) => {
      bot.appNotice(`No sub bot was made: ${why}`);
      bot.queueNote(`(App: No sub bot was made: ${why})`);
    };
    if (profile.role === "main" || profile.id === this.maintainerId) return refuse("only a project's or a bot's own subagents can become sub bots.");
    if (profile.parent) return refuse("a sub bot cannot make another sub bot; it starts subagents of its own instead.");
    const name = botName(request.name);
    if (!name) return refuse("it needs a name.");
    // App-managed workers (any engine) are pulled in: the new sub bot owns them, they keep running where they are.
    const keys = [...new Set([request.subagent, ...(request.subagents ?? [])].filter(Boolean))];
    if (keys.length && this.agentFlags().agentMoves) {
      const records = keys.map((key) => this.tagAgent(bot, key));
      const missing = keys.filter((_, i) => !records[i]);
      if (records.every((record) => record && record.host.kind !== "claude-sidechain")) {
        try { await this.moveOwners(records as AgentRecord[], { kind: "newSubBot", name, ...(request.note.trim() ? { note: request.note } : {}) }, { task: request.note.trim() || undefined }); }
        catch (error) { refuse((error as Error).message); }
        return;
      }
      if (keys.length > 1) return refuse(missing.length ? `there is no worker ${missing.map((key) => `"${key}"`).join(", ")} of yours here.` : "only app-managed workers can be pulled into one sub bot together.");
    } else if (keys.length > 1) return refuse("moving several workers at once needs agentMoves on.");
    const key = keys[0] ?? "";
    if (!key) return this.subBotMade(bot, name, request);
    const found = bot.findSubagent(key);
    if (!found) return refuse(`there is no subagent "${key}" here.`);
    // One that already ended can still move if the app has a record of what it did; with none there is nothing to hand over.
    if (found.status !== "running" && !found.steps.length && !found.result.trim()) return refuse(`the subagent "${key}" has already ended and left no record of its work, so there is nothing to hand over.`);
    const token = safeToken(key);
    if (this.profiles.some((sub) => sub.parent === profile.id && sub.handoff === token) || this.movingSubagents.has(`${profile.id}:${token}`)) return refuse(`"${key}" was already moved to a sub bot.`);
    this.movingSubagents.add(`${profile.id}:${token}`);
    try {
      const file = handoffFile(profile.folder, token);
      mkdirSync(join(file, ".."), { recursive: true });
      const mode = bot.handoffMode(found.id);
      const result = await runHandoff({
        status: () => bot.findSubagent(key)?.status ?? "missing",
        ...(mode === "steer" ? { ask: () => { bot.askForHandoff(found.id, wrapUpMessage(file)); } } : {}),
        ...(mode === "stop" ? { stopAtOnce: true } : {}),
        forceStop: () => bot.stopForHandoff(found.id),
        fallbackText: (reason) => {
          const now = bot.findSubagent(key) ?? found;
          return fallbackHandoff({ name, description: now.description, prompt: now.prompt, steps: now.steps, status: now.status, result: now.result, reason, engine: now.engine, id: now.id, threadId: now.threadId, run: now.run });
        },
        written: () => { try { return readFileSync(file, "utf8").trim().length > 0; } catch { return false; } },
        write: (text) => writeFileAtomic(file, text),
        sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
        now: () => Date.now(),
        waitMs: this.options.subBotWaitMs ?? SUB_BOT_WAIT_MS,
        pollMs: Math.min(500, Math.max(5, Math.floor((this.options.subBotWaitMs ?? SUB_BOT_WAIT_MS) / 10))),
      });
      const chosen = subBotEngine(found.engine, { engine: bot.engine, heads: bot.headEngines });
      const subId = this.makeSubBot(profile, name, `Continue the work moved out of a subagent: ${found.description || found.prompt.slice(0, 200)}`, token, chosen.engine);
      this.agents.succeed(profile.id, found.id, { kind: "subBot", botId: subId }, file);
      const progress = progressFile(profile.folder, token);
      if (!existsSync(progress)) writeFileAtomic(progress, "Status: working\n");
      bot.appNotice(`Moved "${found.description || key}" to the sub bot "${name}".${result.outcome === "forced" ? (mode === "stop" ? " The worker cannot take a message while it works, so it was stopped at once and the handoff was written from its recorded steps." : " The subagent did not end in time, so it was stopped and the handoff was written from its recorded steps.") : ""}${chosen.note ? ` ${chosen.note}` : ""}`, undefined, undefined, { sourceID: subId });
      this.bots.get(subId)?.relay(subBotFirstMessage({ parentName: profile.name, name, handoff: file, progress, note: request.note }));
      this.log(`sub bot ${name} made under ${profile.name} (${result.outcome}${result.wroteFallback ? ", handoff written by the app" : ""})`);
    } catch (error) {
      refuse(`${(error as Error).message}`);
    } finally {
      this.movingSubagents.delete(`${profile.id}:${token}`);
    }
  }

  /** A project bot's <remove-sub-bot name="…"/>: one of its own sub bots is closed exactly as the UI's "Close sub bot" does. */
  async removeSubBotRequested(bot: Bot, request: { name: string }): Promise<void> {
    const refuse = (why: string) => { bot.appNotice(`No sub bot was removed: ${why}`); bot.queueNote(`(App: No sub bot was removed: ${why})`); };
    const wanted = request.name.trim().toLowerCase();
    const sub = this.profiles.find((profile) => profile.parent === bot.id && !this.removed.has(profile.id) && profile.name.trim().toLowerCase() === wanted);
    if (!sub) return refuse(`you have no sub bot named "${request.name}".`);
    try { await this.host.closeSubBot(sub.id); this.log(`sub bot ${sub.name} removed by ${bot.profile.name}`); }
    catch (error) { refuse((error as Error).message); }
  }

  /**
   * A bot's <remove-bot name="…" path="…"/>: a project or bot (never a sub bot, the asker itself or what it hangs under, the
   * main bot or Maintainer) is found by name, and by folder when names repeat. The user is asked on a card in the asker's
   * chat; only "Remove" runs `removeBot`, exactly what the left column's Remove does (nothing on disk is deleted).
   */
  removeBotRequested(bot: Bot, request: { name: string; path?: string }): void {
    const refuse = (why: string) => { bot.appNotice(`No bot was removed: ${why}`); bot.queueNote(`(App: No bot was removed: ${why})`); };
    const wanted = request.name.trim().toLowerCase();
    const named = this.profiles.filter((profile) => !this.removed.has(profile.id) && profile.name.trim().toLowerCase() === wanted);
    const protectedBot = named.find((profile) => profile.role === "main" || profile.id === this.maintainerId);
    if (protectedBot && named.length === 1) return refuse(`"${protectedBot.name}" is ${protectedBot.role === "main" ? "the main bot" : "Maintainer"}, which cannot be removed.`);
    let found = named.filter((profile) => profile.role !== "main" && profile.id !== this.maintainerId && !profile.parent);
    if (!found.length) {
      return refuse(named.some((profile) => profile.parent)
        ? `"${request.name}" is a sub bot; a sub bot is closed by its own project bot (<remove-sub-bot>).`
        : `there is no project or bot named "${request.name}".`);
    }
    if (request.path) {
      const want = folderPath(request.path);
      const at = (folder: string) => folderPath(folder) ?? folder;
      const exact = found.filter((profile) => want !== null && at(profile.folder) === want);
      found = exact.length ? exact : found.filter((profile) => want !== null && at(profile.folder).toLowerCase() === want.toLowerCase());
      if (!found.length) return refuse(`no project or bot named "${request.name}" is at ${request.path}.`);
    }
    if (found.length > 1) {
      return refuse(`more than one project or bot is named "${request.name}" (${found.map((profile) => profile.folder).join(", ")}); add path="its folder" to say which.`);
    }
    const target = found[0]!;
    if (target.id === bot.id || target.id === bot.profile.parent) return refuse(target.id === bot.id ? "a bot cannot remove itself." : `"${target.name}" is the project bot you belong to.`);
    const project = target.role !== "bot";
    bot.appNotice(
      `Remove **${target.name}** from Botling?\n\n\`${target.folder}\`\n\nIt stops at once${this.profiles.some((profile) => profile.parent === target.id && !this.removed.has(profile.id)) ? ", with its sub bots" : ""}. Nothing on disk is deleted: its folder, notes in .bot/ and chat files stay.`,
      [{ label: project ? "Remove project" : "Remove bot" }, { label: "Keep" }],
      (index) => {
        if (index !== 0) { bot.queueNote(`(App: The user chose to keep "${target.name}"; nothing was removed.)`); return; }
        if (!this.profiles.some((profile) => profile.id === target.id) || this.removed.has(target.id)) { bot.queueNote(`(App: "${target.name}" was already removed.)`); return; }
        this.removeBot(target.id).then(
          () => { bot.queueNote(`(App: The user confirmed; "${target.name}" was removed from Botling. Its folder stays at ${target.folder}.)`); this.log(`${target.name} removed by ${bot.profile.name}, confirmed by the user`); },
          (error: Error) => refuse(error.message));
      },
      { sourceID: target.id });
    bot.queueNote(`(App: The user now sees a card asking to remove "${target.name}" (${target.folder}). Nothing is removed until they confirm.)`);
  }

  /** An agent a bot names in a tag (its agent id, its task id, or the id it reaches it by), if that bot owns it. */
  private tagAgent(bot: Bot, key: string): AgentRecord | undefined {
    const record = this.agents.get(key) ?? this.agents.byHostBot(bot.id, key) ?? this.agents.movedIn(bot.id).find((candidate) => candidate.nativeId === key);
    return record && record.owner.botId === bot.id ? record : undefined;
  }

  /** A <sub-bot> with no subagent: a new empty sub bot under the project bot, sent the words inside the tag as its first task. */
  private subBotMade(bot: Bot, name: string, request: { note: string; engine?: string }): void {
    const profile = bot.profile;
    const task = request.note.trim();
    const refuse = (why: string) => { bot.appNotice(`No sub bot was made: ${why}`); bot.queueNote(`(App: No sub bot was made: ${why})`); };
    if (!task) return refuse("it needs a task (the words inside the tag) or a subagent to move.");
    try {
      const chosen = directSubBotEngine(request.engine, { engine: bot.engine, heads: bot.headEngines });
      const subId = this.makeSubBot(profile, name, task.slice(0, 1_000), undefined, chosen.engine);
      const progress = progressFile(profile.folder, subId);
      mkdirSync(join(progress, ".."), { recursive: true });
      writeFileAtomic(progress, "Status: working\n");
      bot.appNotice(`Made the sub bot "${name}" and gave it its first task.${chosen.note ? ` ${chosen.note}` : ""}`, undefined, undefined, { sourceID: subId });
      this.bots.get(subId)?.relay(subBotDirectFirstMessage({ parentName: profile.name, name, task, progress }));
      this.log(`sub bot ${name} made directly under ${profile.name}`);
    } catch (error) {
      refuse((error as Error).message);
    }
  }

  /**
   * "Close sub bot": the agents it owns go back to the bot that runs them (or, when that bot is gone, are only listed as stopped),
   * the ones it runs itself are stopped, then it is removed. Its project bot's chat says which went where.
   */
  async closeSubBot(id: string): Promise<ResultOf<"subbot.close">> {
    this.checkBot(id);
    const profile = this.profiles.find((candidate) => candidate.id === id);
    if (!profile || this.removed.has(id)) throw new ContractError("not_found", "No such bot.");
    if (!profile.parent) throw new ContractError("bad_request", "Only a sub bot can be closed.");
    const parentId = profile.parent;
    const returned: { title: string; to: string }[] = [];
    const stopped: { title: string; why: string }[] = [];
    for (const record of this.agents.movedIn(id)) {
      const title = record.summary.description || "Agent";
      const host = this.removed.has(record.host.botId) ? undefined : this.bots.get(record.host.botId);
      if (!host || record.state === "lost") { stopped.push({ title, why: "the bot that ran it is gone" }); continue; }
      try { await this.moveOwners([record], { kind: "back" }, {}); returned.push({ title, to: this.agentBotName(record.host.botId) }); }
      catch (error) {
        // It cannot go back now (its report is being handed over this very moment): stopped instead, never left without an owner.
        await host.commandWorker(record.nativeId, { kind: "stop" }).catch(() => undefined);
        stopped.push({ title, why: `it could not go back: ${(error as Error).message}` });
      }
    }
    const sub = this.bots.get(id);
    for (const record of this.agents.all.filter((candidate) => candidate.host.botId === id && candidate.state === "running")) {
      const stoppedNow = await sub?.commandWorker(record.nativeId, { kind: "stop" }).catch(() => null);
      if (stoppedNow?.ok) stopped.push({ title: record.summary.description || "Agent", why: "it ran on this sub bot" });
    }
    await this.removeBot(id, { quiet: true });
    const parent = this.removed.has(parentId) ? undefined : this.bots.get(parentId);
    const words = subBotClosedNotice({ name: profile.name, returned, stopped });
    parent?.appNotice(words, undefined, undefined, { sourceID: id });
    parent?.queueNote(`(App: ${words})`);
    parent?.refresh();
    return { closed: true, parentBotId: parentId, returned: returned.length, stopped: stopped.length };
  }

  /** Makes the hidden sub bot: a Bot of its own (head, chat.json, subagents.json) under `parent`, in the same folder, no worktree. */
  makeSubBot(parent: BotProfile, rawName: string, job: string, handoff: string | undefined, engine?: Engine, extras: { plugin?: string; delegation?: "onRequest"; instructions?: string } = {}): string {
    const taken = new Set(this.profiles.filter((profile) => profile.parent === parent.id).map((profile) => profile.name.toLowerCase()));
    let name = botName(rawName) || "Sub bot";
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${botName(rawName) || "Sub bot"} ${n}`;
    const id = randomUUID().toUpperCase();
    mkdirSync(join(parent.folder, ".bot", "sub-bots", id), { recursive: true });
    this.seedEngineDefaults(id);
    // It runs on the engine of the worker it took over (`subBotEngine`), as a single head: the app's defaults would otherwise decide.
    if (engine) this.singleEngine(id, engine);
    const instructionsFile = this.writeInstructions(parent.folder, id, true, extras.instructions);
    const row = { id, name, folder: parent.folder, avatar: parent.avatar, job, parent: parent.id, createdAt: Date.now(), ...(handoff ? { handoff } : {}),
      ...(extras.plugin ? { plugin: extras.plugin } : {}), ...(extras.delegation ? { delegation: extras.delegation } : {}), ...(instructionsFile ? { instructionsFile } : {}) };
    saveProjectRow(this.options.dataDir, row);
    this.attach(projectProfile(this.options.dataDir, { ...row, folder: folderURLText(parent.folder) }));
    // The project bot's subagent list gains the row.
    this.bots.get(parent.id)?.refresh();
    return id;
  }

  /** A sub bot's reply showed: when its progress file says it is done, its project bot hears of it once. */
  subBotReplied(bot: Bot) {
    const sub = bot.profile;
    if (!sub.parent || this.subBotsReported.has(sub.id)) return;
    let status: string | null = null;
    try { status = progressStatus(readFileSync(progressFile(sub.folder, sub.handoff ?? sub.id), "utf8")); } catch { return; }
    if (!status?.startsWith("done")) return;
    this.subBotsReported.add(sub.id);
    const parent = this.bots.get(sub.parent);
    if (!parent) return;
    const words = `The sub bot "${sub.name}" finished its job. Progress file: ${progressFile(sub.folder, sub.handoff ?? sub.id)}`;
    parent.appNotice(words, undefined, undefined, { sourceID: sub.id });
    parent.queueNote(`(App: ${words})`);
    parent.refresh();
  }
}
