// M7-S66: `CoreSend` cut out of `Core` (core/server.ts). `chat.send` through the plugins' beforeSend hooks, `applyNow`, and what the prompts, the settings file and the plugin wiring give a bot. Same bridge convention as `CoreWatch` (core/server/watch.ts, in its header): a block of one-line
// forwarders to `host` first, then the members as they were in `Core`, byte for byte (a member that `Core` or another collaborator calls lost its `private`).
import type { Core, ApplyNowCommand } from "../server";
import { specTrace } from "../spec-trace";
import { dirname, join } from "node:path";
import { commandGuidePath } from "../plugins/app-command";
import { rmSync } from "node:fs";
import { linkIncoming, servedType, writeIncoming } from "../attachments";
import { claudeWorkersMode } from "../settings";
import { botName } from "../projects";
import { ContractError, type ResultOf } from "../../contract";
import { Bot, type PresetTurnIds } from "../bot";
import type { Engine, Heads } from "../heads";
import { DEFAULT_ORCHESTRATION_RULES, type OrchestrationRules } from "../orchestration/default-rules";
import { botPrompts, desktopPrompts, isResultPublishing, preferredLanguage, savedLanguage, withPluginSections, type BotPrompts } from "../prompts";
import { readJSON } from "../store/bot-store";
import { Layout, type BotProfile } from "../store/workspace";
import { agentContributions, claudeWiring, skillRootsWiring } from "../plugins/agent-contributions";
import { claudeSkillFolders, placedSkillRoot } from "../plugins/engine-skills";

export class CoreSend {
  constructor(private readonly host: Core) {}

  // The bridge: everything this class borrows from `Core`.
  private get activated() { return this.host.activated; }
  private bot(...a: Parameters<Core["bot"]>) { return this.host.bot(...a); }
  private botInfo(...a: Parameters<Core["botInfo"]>) { return this.host.botInfo(...a); }
  private calledInAnswer(...a: Parameters<Core["calledInAnswer"]>) { return this.host.calledInAnswer(...a); }
  private calledInGroupAnswer(...a: Parameters<Core["calledInGroupAnswer"]>) { return this.host.calledInGroupAnswer(...a); }
  private calledInPick(...a: Parameters<Core["calledInPick"]>) { return this.host.calledInPick(...a); }
  private changeSetting(...a: Parameters<Core["changeSetting"]>) { return this.host.changeSetting(...a); }
  private get conversations() { return this.host.conversations; }
  private ignoreQuestion(...a: Parameters<Core["ignoreQuestion"]>) { return this.host.ignoreQuestion(...a); }
  private makeBot(...a: Parameters<Core["makeBot"]>) { return this.host.makeBot(...a); }
  private get options() { return this.host.options; }
  private get pending() { return this.host.pending; }
  private get plugins() { return this.host.plugins; }
  private get profiles() { return this.host.profiles; }
  private settingsNow(...a: Parameters<Core["settingsNow"]>) { return this.host.settingsNow(...a); }

  /**
   * Botling 3's server: the core-set commands it applies inside its own transaction. Synchronous, the same handlers
   * as `handle`: what they emit meanwhile is stored in that transaction, and a turn they start is kept aside by
   * `deferTurn` (the server routes it after the commit).
   */
  applyNow(cmd: ApplyNowCommand): unknown {
    if (!this.activated) throw new ContractError("conflict", "Waiting for the update boot receipt to commit. Please try again shortly.");
    switch (cmd.type) {
      case "chat.react": return this.bot(cmd.botId).react(cmd.messageId, cmd.emoji, cmd.present);
      case "chat.ignoreQuestion": return this.ignoreQuestion(cmd.botId, cmd.messageId);
      case "chat.choose": return this.calledInPick(cmd.botId, cmd.messageId, cmd.index) ?? this.bot(cmd.botId).choose(cmd.messageId, cmd.index, cmd.text);
      case "chat.answer": {
        const files = (cmd.images ?? []).flatMap((image) => writeIncoming(join(this.options.dataDir, "incoming"), image.name, image.base64) ?? []);
        try {
          if (cmd.picks) return this.calledInGroupAnswer(cmd.botId, cmd.messageId, cmd.picks, files.length) ?? this.bot(cmd.botId).answer(cmd.messageId, cmd.text, files, cmd.picks);
          return this.calledInAnswer(cmd.botId, cmd.messageId, cmd.text, files.length) ?? this.bot(cmd.botId).answer(cmd.messageId, cmd.text, files);
        } finally { for (const file of files) rmSync(file, { force: true }); }
      }
      case "component.approve": return this.bot(cmd.botId).cards.componentApprove(cmd.messageId, cmd.index, cmd);
      case "settings.set": return this.changeSetting(cmd.change);
      case "bots.create": {
        const made = this.makeBot(cmd.name, cmd.job, { setUp: true });
        if (made.kind === "empty") throw new ContractError("bad_request", "A bot needs a name and a job.");
        if (made.kind === "taken" || made.kind === "removedByUser") throw new ContractError("conflict", `No bot was made: the name "${botName(cmd.name)}" is already used by a project or the app.`);
        return { botId: made.botId, created: made.kind === "made" };
      }
    }
  }

  /** Your message through the plugins' beforeSend hooks first; one can change it or stop it (`Workspace.send`). */
  async send(botId: string, text: string, options: { replyTo?: string; to?: "both" | "claude" | "codex" | "agy"; ids?: PresetTurnIds }, uploads: Array<{ path: string; name: string }> = []): Promise<ResultOf<"chat.send">> {
    const bot = this.bot(botId);
    // A message to a bot in Idle brings it back to the list (the user is talking to it again).
    const idle = this.settingsNow().idleBots ?? [];
    if (idle.includes(botId.toUpperCase())) this.changeSetting({ key: "idleBots", value: idle.filter((id) => id !== botId.toUpperCase()) });
    // The files waiting in its input box go with the message (1.x sends them all).
    const files = this.pending.take(botId);
    // Botling 3 uploads (M2 step 12): the server's checked file under the name the page gave, as an incoming copy, so
    // it lands in the bot's attachments folder like a pasted file (`keep` copies it; the incoming name goes after).
    const incoming = uploads.length ? linkIncoming(join(this.options.dataDir, "incoming"), uploads) : [];
    try {
      // Picked or dropped files on disk go by their own path; the incoming copies are copied (`keep`).
      const result = await this.host.sendWith(bot, text, { ...options, files: [...files.map((file) => file.path), ...incoming], originals: files.filter((file) => !file.incoming).map((file) => file.path) });
      if (result.stoppedBy) this.pending.restore(botId, files);
      else this.pending.done(files);
      return result;
    } catch (error) {
      this.pending.restore(botId, files);
      throw error;
    } finally {
      for (const path of incoming) rmSync(dirname(path), { recursive: true, force: true });
    }
  }

  async sendWith(bot: Bot, text: string, options: { replyTo?: string; to?: "both" | "claude" | "codex" | "agy"; files: string[]; originals?: string[]; ids?: PresetTurnIds }): Promise<ResultOf<"chat.send">> {
    if (!text.trim() && !options.files.length) throw new ContractError("bad_request", "Nothing to send.");
    const outcome = await this.plugins.beforeSend(this.botInfo(bot), text);
    if ("stoppedBy" in outcome) {
      const plugin = this.plugins.registry.plugin(outcome.stoppedBy);
      const name = plugin ? (plugin.manifest.displayName ?? plugin.manifest.name) : outcome.stoppedBy;
      const messageId = bot.appNotice(`Plugin "${name}" stopped this message: ${text}`);
      return { messageId, turnId: null, stoppedBy: outcome.stoppedBy };
    }
    const words = outcome.send.slice(0, 100_000) || text;
    // Bots you named with @ are called in: they answer here too, after reading the chat (`Workspace.send`).
    const called = this.conversations.calledIn(words, bot.id);
    const appNote = this.conversations.notes(bot, called, words);
    const sent = bot.send(words, { ...options, ...(appNote ? { appNote } : {}) });
    if (called.length) {
      // The line this message made (Botling 3's server: by its id, since lines sent after it may be in the chat already).
      const userId = options.ids?.userId;
      const newest = (userId ? bot.lines().find((line) => line.id === userId) : undefined) ?? bot.lines().findLast((line) => line.role === "user");
      if (newest) this.conversations.startCallIn(bot, called, newest.id, null);
    }
    specTrace("callin", "UserLine", { chat: bot.id, to: called[0]?.id ?? null, pending: this.conversations.callIns(bot.id) });
    return sent;
  }

  /** A file the chat origin may serve for this bot: one of its lines' attachments, or one waiting in its input box. */
  /** `line`: the line showing it, whose copy of the picture (as it was when the line was posted) is served when there is one. */
  attachmentFile(botId: string, ref: string, line?: string): ResultOf<"attachment.file"> {
    const bot = this.bot(botId);
    let path: string | null = null;
    if (ref.startsWith("pending:")) path = this.pending.get(botId, ref.slice(8))?.path ?? null;
    else path = bot.attachmentPath(ref, line);
    if (!path) throw new ContractError("not_found", "No such attachment.");
    return { path, type: servedType(path) };
  }

  settingsFile(): Record<string, unknown> | undefined {
    try {
      const value = readJSON(Layout.settings(this.options.dataDir));
      return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }

  /** settings.json as 1.x writes it (`AppSettings`): only the keys the prompts need. */
  settings(): { language: string | undefined; results: string | undefined } {
    const value = this.settingsFile();
    return { language: value?.languageChoice as string | undefined, results: value?.resultPublishingChoice as string | undefined };
  }

  /** The app's language: settings.json's, else the system's (`AppLanguage.preferred`). */
  language() {
    const settings = this.settings();
    return savedLanguage(settings.language) ?? preferredLanguage(this.options.languages ?? [Intl.DateTimeFormat().resolvedOptions().locale]);
  }

  /** The orchestration rules every prompt is built from: core's own defaults, the one seam a plugin's rules plug into later (M7-O04). */
  orchestrationRules(): OrchestrationRules { return DEFAULT_ORCHESTRATION_RULES; }

  /** The bot's instructions (Prompts.swift's), from its profile and the app's settings. */
  /** `workingFolder`: the app worktree the session starts in, when there is one. */
  prompts(profile: BotProfile, engine: Engine = "claude", heads: Heads | null = null, workingFolder: string | null = null): BotPrompts {
    const settings = this.settings();
    const languages = this.options.languages ?? [Intl.DateTimeFormat().resolvedOptions().locale];
    const rules = this.orchestrationRules();
    return desktopPrompts(botPrompts({
      rules,
      profile: { ...profile, instructions: profile.instructions ?? null },
      language: savedLanguage(settings.language) ?? preferredLanguage(languages),
      results: isResultPublishing(settings.results) ? settings.results : "artifactUnlessSensitive",
      engine,
      heads: heads && heads.engines.length > 1 ? { handoffs: heads.handoffs, limits: heads.limits } : null,
      workingFolder: workingFolder !== profile.folder ? workingFolder : null,
      parentName: profile.parent ? this.profiles.find((candidate) => candidate.id === profile.parent)?.name ?? null : null,
    }), profile, engine, claudeWorkersMode(this.settingsFile() ?? {}) === "app", withPluginSections(this.promptSections()), rules);
  }

  /** The prompt sections plugins give, each that names a command with that command's line and guide (none without one). */
  promptSections() {
    const commands = this.plugins.agentCommands();
    return this.plugins.promptSections().flatMap((section) => {
      if (section.command === undefined) return [section];
      const command = commands.find((candidate) => candidate.plugin === section.plugin && candidate.id === section.command);
      const line = command ? this.options.runCommand?.(command) : null;
      return command && line ? [{ ...section, tool: { command: line, docs: command.docs ? this.commandGuide(command) : "" } }] : [];
    });
  }

  /**
   * The path bots are told for a command's guide: one that stays the same (`<data>/plugin-guides/<plugin>/…`, a link to the plugin
   * folder whose script the command runs: an override's, else the shipped one), so the prompt does not change when an override
   * comes or goes and a rebuilt guide is read by the next report a bot writes. Re-pointed each time prompts are built.
   */
  /**
   * What enabled plugins give a new head (agent-contributions.ts, engine-skills.ts): Claude's --plugin-dir folders (its parts,
   * and one made for each skill folder outside them, under `<data>/plugin-skills/claude`), the secrets' environment, the MCP
   * tools, and the skill folders Codex and Antigravity are pointed at. Skill folders go through `skillPlace`.
   */
  agentWiring(): { dirs: string[]; env: Record<string, string>; tools: string[]; skillRoots: string[] } {
    const contributions = agentContributions(this.plugins.registry);
    const place = (plugin: string, root: string) => this.skillPlace(plugin, root);
    const own = contributions.skillRoots.filter((entry) => !entry.claude).map((entry) => ({ plugin: entry.plugin, root: place(entry.plugin, entry.root) }));
    return { ...claudeWiring(contributions, claudeSkillFolders(own, join(this.options.dataDir, "plugin-skills", "claude"))), skillRoots: skillRootsWiring(contributions, place) };
  }

  /** The path engines are told for a plugin's skill folder (engine-skills.ts `placedSkillRoot`). */
  skillPlace(plugin: string, root: string): string {
    const command = this.plugins.agentCommands().find((candidate) => candidate.plugin === plugin && candidate.docs);
    return placedSkillRoot(root, command, join(this.options.dataDir, "plugin-guides"), this.options.pluginOverrides ?? null);
  }

  commandGuide(command: { plugin: string; folder: string; flag: string; docs: string | null }): string {
    return commandGuidePath({ ...command, docs: command.docs! }, join(this.options.dataDir, "plugin-guides"), this.options.pluginOverrides ?? null);
  }
}
