// M7-S67: `CoreCommands` cut out of `Core` (core/server.ts). The command switch: `handle` (one case per contract command), `snapshot`, the
// settings view and `changeSetting`, and the two fields they own (`shownChat`, `snapshotHeld`). Same bridge convention as `CoreWatch`
// (core/server/watch.ts, in its header): a block of one-line forwarders to `host` first, then the members as they were in `Core`, byte for byte.
import type { Core } from "../server";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { agyPermissionSessions, changeAgyPermissions } from "../agent/agy-permissions";
import { discoveryFailure } from "../agent/model-discovery";
import { agyRuntimeStatus, validateAgyRuntimePath } from "../agy-runtime-settings";
import { ALL_BOTS } from "../../mobile-bridge/scope";
import { writeIncoming } from "../attachments";
import { botChoicesFromDefaults, engineDefaultsFor } from "../engine-defaults";
import { appliedCodexWorkers, applySetting, codexWorkersJSON, readSettings, settingsView, writeSettings } from "../settings";
import { claudeAutoCompactWindow, codexConfigFile } from "../engine-files";
import { attachmentFile as attachmentLinkFile } from "../../contract/attachment-url";
import { lineHasLink } from "../../browser-tab-menu";
import { botName } from "../projects";
import { ContractError, type Command, type ResultOf, type SettingsChange, type SettingsView } from "../../contract";
import { filePath, pageInCard } from "../page-preview";
import { PAGE_COMPONENT } from "../preview-url";
import { profilePaths } from "../prompts";
import { storageItems } from "../storage";
import { usageView } from "../usage";
import { Layout } from "../store/workspace";
import { type ShownChat } from "../workspace";
import { MACHINE_NAME } from "../../remote/machines";
import { machineNameFrom } from "../../remote/relay/wire";

export class CoreCommands {
  constructor(private readonly host: Core) {}

  // The bridge: everything this class borrows from `Core`.
  private activate(...a: Parameters<Core["activate"]>) { return this.host.activate(...a); }
  private get activated() { return this.host.activated; }
  private addProject(...a: Parameters<Core["addProject"]>) { return this.host.addProject(...a); }
  private agentMessageCommand(...a: Parameters<Core["agentMessageCommand"]>) { return this.host.agentMessageCommand(...a); }
  private agentStopCommand(...a: Parameters<Core["agentStopCommand"]>) { return this.host.agentStopCommand(...a); }
  private agentTargets(...a: Parameters<Core["agentTargets"]>) { return this.host.agentTargets(...a); }
  private agentView(...a: Parameters<Core["agentView"]>) { return this.host.agentView(...a); }
  private get agents() { return this.host.agents; }
  private get agyInstaller() { return this.host.agyInstaller; }
  private attachmentFile(...a: Parameters<Core["attachmentFile"]>) { return this.host.attachmentFile(...a); }
  private bot(...a: Parameters<Core["bot"]>) { return this.host.bot(...a); }
  private botView(...a: Parameters<Core["botView"]>) { return this.host.botView(...a); }
  private get bots() { return this.host.bots; }
  private calledInAnswer(...a: Parameters<Core["calledInAnswer"]>) { return this.host.calledInAnswer(...a); }
  private calledInGroupAnswer(...a: Parameters<Core["calledInGroupAnswer"]>) { return this.host.calledInGroupAnswer(...a); }
  private calledInPick(...a: Parameters<Core["calledInPick"]>) { return this.host.calledInPick(...a); }
  private checkBot(...a: Parameters<Core["checkBot"]>) { return this.host.checkBot(...a); }
  private checkWorkspaceSoon(...a: Parameters<Core["checkWorkspaceSoon"]>) { return this.host.checkWorkspaceSoon(...a); }
  private closeSubBot(...a: Parameters<Core["closeSubBot"]>) { return this.host.closeSubBot(...a); }
  private componentInfos(...a: Parameters<Core["componentInfos"]>) { return this.host.componentInfos(...a); }
  private get components() { return this.host.components; }
  private componentsTick(...a: Parameters<Core["componentsTick"]>) { return this.host.componentsTick(...a); }
  private developerProject(...a: Parameters<Core["developerProject"]>) { return this.host.developerProject(...a); }
  private get doctor() { return this.host.doctor; }
  private get epoch() { return this.host.epoch; }
  private event(...a: Parameters<Core["event"]>) { return this.host.event(...a); }
  private groupAgents(...a: Parameters<Core["groupAgents"]>) { return this.host.groupAgents(...a); }
  private ignoreQuestion(...a: Parameters<Core["ignoreQuestion"]>) { return this.host.ignoreQuestion(...a); }
  private ignoreWaiting(...a: Parameters<Core["ignoreWaiting"]>) { return this.host.ignoreWaiting(...a); }
  private get imported() { return this.host.imported; }
  private language(...a: Parameters<Core["language"]>) { return this.host.language(...a); }
  private log(...a: Parameters<Core["log"]>) { return this.host.log(...a); }
  private machinesOr(...a: Parameters<Core["machinesOr"]>) { return this.host.machinesOr(...a); }
  private machinesView(...a: Parameters<Core["machinesView"]>) { return this.host.machinesView(...a); }
  private mainBot(...a: Parameters<Core["mainBot"]>) { return this.host.mainBot(...a); }
  private get maintainer() { return this.host.maintainer; }
  private makeBot(...a: Parameters<Core["makeBot"]>) { return this.host.makeBot(...a); }
  private get mobileDesk() { return this.host.mobileDesk; }
  private mobileOr(...a: Parameters<Core["mobileOr"]>) { return this.host.mobileOr(...a); }
  private mobileView(...a: Parameters<Core["mobileView"]>) { return this.host.mobileView(...a); }
  private moveAgent(...a: Parameters<Core["moveAgent"]>) { return this.host.moveAgent(...a); }
  private noMainBotMessage(...a: Parameters<Core["noMainBotMessage"]>) { return this.host.noMainBotMessage(...a); }
  private get options() { return this.host.options; }
  private get order() { return this.host.order; }
  private outId(...a: Parameters<Core["outId"]>) { return this.host.outId(...a); }
  private get pending() { return this.host.pending; }
  private pinOwner(...a: Parameters<Core["pinOwner"]>) { return this.host.pinOwner(...a); }
  private get pluginStore() { return this.host.pluginStore; }
  private get plugins() { return this.host.plugins; }
  private get profiles() { return this.host.profiles; }
  private get projectFiles() { return this.host.projectFiles; }
  private get relay() { return this.host.relay; }
  private removeBot(...a: Parameters<Core["removeBot"]>) { return this.host.removeBot(...a); }
  private reportComponent(...a: Parameters<Core["reportComponent"]>) { return this.host.reportComponent(...a); }
  private reportFeedback(...a: Parameters<Core["reportFeedback"]>) { return this.host.reportFeedback(...a); }
  private send(...a: Parameters<Core["send"]>) { return this.host.send(...a); }
  private get seq() { return this.host.seq; }
  private get storage() { return this.host.storage; }
  private get usage() { return this.host.usage; }
  private waiting(...a: Parameters<Core["waiting"]>) { return this.host.waiting(...a); }

  /** The chat the main window shows now, as it last said (`chat.shown`); null: none, or not said yet. */
  shownChat: ShownChat | null = null;
  /** Whether the first chat.snapshot was held already (`firstSnapshotDelayMs`). */
  private snapshotHeld = false;

  async handle(cmd: Command, signal: AbortSignal): Promise<unknown> {
    if (!this.activated && !new Set<string>(["boot.commit", "chat.snapshot", "settings.get", "plugins.list", "plugins.web", "plugins.file", "results.list", "waiting.list", "bot.settings", "usage.view", "doctor.view", "attachment.file", "card.image", "link.authorize", "chat.shown"]).has(cmd.type)) {
      throw new ContractError("conflict", "Waiting for the update boot receipt to commit. Please try again shortly.");
    }
    switch (cmd.type) {
      case "boot.commit": { const first = !this.activated; this.activate(); if (first) this.event({type:"plugins.updated",plugins:this.plugins.view()}); return {}; }
      case "chat.snapshot": {
        const delay = this.options.firstSnapshotDelayMs ?? 0;
        if (delay > 0 && !this.snapshotHeld) {
          this.snapshotHeld = true;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        return this.snapshot(cmd.botId);
      }
      case "chat.send":
        // Files named by their hash are uploads to a Botling 3 server (M2 step 12); the 2.x app has none.
        if (cmd.files) throw new ContractError("bad_request", "Files named by their hash are taken only by the Botling 3 server.");
        return this.send(cmd.botId, cmd.text, { replyTo: cmd.replyTo, to: cmd.to });
      case "plugins.list": return this.plugins.view();
      case "plugins.enable": return this.plugins.setEnabled(cmd.name, cmd.enabled);
      case "plugins.store": return cmd.refresh ? await this.pluginStore.refresh() : this.pluginStore.view();
      case "plugins.storeInstall": return await this.pluginStore.install(cmd.name);
      case "plugins.storeDismiss": return this.pluginStore.dismiss(cmd.name);
      case "plugins.revert": { const problem = this.maintainer.revertPlugin(cmd.name); if (problem) throw new ContractError("conflict", problem); return this.plugins.view(); }
      case "plugins.remove": { const problem = this.maintainer.removePlugin(cmd.name); if (problem) throw new ContractError("conflict", problem); return this.plugins.view(); }
      case "plugins.setting": return this.plugins.setSetting(cmd.name, cmd.key, cmd.value);
      case "plugins.secret": return this.plugins.setSecret(cmd.name, cmd.key, cmd.value);
      case "plugins.command": return { result: await this.plugins.command(cmd.id, cmd.from, cmd.name, cmd.args) ?? null };
      case "plugins.linkCommand": {
        // A chat attachment's link (the chat origin's URL) stands for its file; the link must be in that bot or user line.
        const url = attachmentLinkFile(cmd.url, cmd.botId) ?? cmd.url;
        const line = this.bot(cmd.botId).lines().find((candidate) => candidate.id === cmd.messageId);
        if (!line || (line.role !== "bot" && line.role !== "user") || !lineHasLink(line, url)) throw new ContractError("not_found", "That link is not in that message.");
        return { result: await this.plugins.linkCommand(cmd.id, { botId: cmd.botId, messageId: cmd.messageId, url }) ?? null };
      }
      case "plugins.tabCommand": return { result: await this.plugins.tabCommand(cmd.id, { botId: cmd.botId, tabId: cmd.tabId, url: cmd.url }) ?? null };
      case "plugins.panel": return this.plugins.panel(cmd.name, cmd.panel);
      case "plugins.call": return { result: await this.plugins.call(cmd.name, cmd.method, cmd.params, cmd.from) ?? null };
      case "plugins.approvalAsk": return this.plugins.approvalAsk(cmd.name, cmd.botId, cmd.command, cmd.folder, cmd.card, cmd.component, cmd.detail, cmd.from);
      case "plugins.approve": return this.plugins.approve(cmd.name, cmd.botId, cmd.command, cmd.folder, cmd.component, cmd.detail);
      case "plugins.tileImages": return this.plugins.tileImages(cmd.name, cmd.botId, cmd.data);
      case "plugins.noteSnapshot": return this.plugins.noteSnapshot(cmd.name, cmd.botId, cmd.picture);
      case "plugins.linkTarget": return this.plugins.linkTarget(cmd.name, cmd.botId, cmd.href);
      case "plugins.web": return { specs: this.activated ? this.plugins.webSpecs() : [] };
      case "settings.get": return this.settingsNow();
      case "agy.runtime.install": {
        if (process.env.BOTLING_AGY_ACP_PATH) throw new Error('BOTLING_AGY_ACP_PATH overrides saved settings. Remove it and restart Botling before installing from Doctor.');
        const path = await this.agyInstaller.install(this.options.dataDir);
        this.changeSetting({ key: 'agyAcpPath', value: path });
        return this.doctor.run(false);
      }
      case "agy.runtime.check": return agyRuntimeStatus(readSettings(Layout.settings(this.options.dataDir)), this.options.dataDir);
      case "projects.add": return this.addProject(cmd.folder);
      case "bots.create": {
        const made = this.makeBot(cmd.name, cmd.job, { setUp: true });
        if (made.kind === "empty") throw new ContractError("bad_request", "A bot needs a name and a job.");
        if (made.kind === "taken" || made.kind === "removedByUser") throw new ContractError("conflict", `No bot was made: the name "${botName(cmd.name)}" is already used by a project or the app.`);
        return { botId: made.botId, created: made.kind === "made" };
      }
      case "bots.remove": return this.removeBot(cmd.botId);
      case "subagent.settle": return this.bot(cmd.botId).settleSubagent(cmd.subagentId, cmd.settled);
      case "link.authorize": {
        const lines=this.bot(cmd.botId).lines();
        const context=cmd.messageId?lines.find(line=>line.id===cmd.messageId):null;
        const pin=cmd.pinId?await this.pinOwner(cmd.botId,cmd.pinId,null):null;
        if(cmd.pinId&&(!pin||typeof pin.linkAuthor!=="string"))return {result:false,linked:false};
        // A component inherits its own reply's author, never a guest's links merely because they
        // appear in the same host/group chat. Notices can echo user text and grant no authority.
        if(cmd.messageId&&(!context||context.role!=="bot"))return {result:false,linked:false};
        // Automatically generated preview frames come from Markdown, without stored displays.
        const author=(line:typeof lines[number])=>typeof line.sourceID==='string'?line.sourceID.toUpperCase():cmd.botId;
        const owner=pin?String(pin.linkAuthor).toUpperCase():context?author(context):cmd.botId;
        const same=(url:string)=>url===cmd.url||(filePath(url)!==null&&filePath(url)===filePath(cmd.url));
        let result=false,linked=false;
        for(const line of lines){
          if(line.role!=="bot"&&!(cmd.source==="user"&&line.role==="notice"))continue;
          const match=[...line.text.matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/g)].some(value=>same(value[1]!));
          const shown=line.displays?.some(display=>display.name===PAGE_COMPONENT&&same(pageInCard(display.data)??""));
          if(match||shown){if(line.role==="bot")result=true;if(cmd.source==="user"||line.role==="bot"&&author(line)===owner)linked=true;}
        }
        // A card's picture in the lightbox (its Open in Preview / Show in Finder): exactly the file its token
        // stands for, a picture some component's data named (what the chat origin's card-image route serves).
        if(cmd.cardImage&&this.components.images.covers(cmd.cardImage,cmd.url)){result=true;linked=true;}
        // A file attached in this chat (yours, a relayed report's, a reply's): the app copied it into
        // the bot's folder and the chat shows it, so your click on it opens it (a component's does not).
        if(cmd.source==="user"&&!cmd.messageId&&!cmd.pinId&&lines.some(line=>line.attachments?.some(file=>typeof file?.url==="string"&&same(file.url))))linked=true;
        return {result,linked};
      }
      case "results.list": return { results: this.bot(cmd.botId).results().slice(0, 200) };
      case "storage.list": {
        const bot = this.bot(cmd.botId);
        const artifacts = bot.profile.folder ? profilePaths(bot.profile).artifacts : null;
        return { items: storageItems(artifacts, this.storage.refs(cmd.botId), bot.linkedFiles()), artifacts };
      }
      // Main checked the paths are files (main.ts storageAdd).
      case "storage.add": this.bot(cmd.botId); return { added: this.storage.add(cmd.botId, cmd.paths) };
      case "storage.remove": this.bot(cmd.botId); return { removed: this.storage.remove(cmd.botId, cmd.id) };
      case "waiting.list": return this.waiting();
      case "waiting.ignore": return this.ignoreWaiting(cmd.botId, cmd.text);
      case "settings.set": return this.changeSetting(cmd.change);
      case "engineDefaults.applyAll": return this.applyEngineDefaultsToAll();
      case "bot.settings": return this.bot(cmd.botId).settingsView();
      case "mobile.view": return this.mobileView();
      case "mobile.pair": {
        // No list: every bot (`*`, resolved on each request), so a bot made later is on the phone too.
        const botIds = cmd.botIds ?? [ALL_BOTS];
        if (cmd.botIds?.some((id) => id === "main" && !this.mainBot())) throw new ContractError("not_found", this.noMainBotMessage());
        if (cmd.botIds?.some((id) => !this.bots.has(id))) throw new Error("Unknown bot.");
        if (cmd.relay) {
          if (!this.relay) throw new Error("The phone relay is not available.");
          const offer = await this.relay.pair(botIds);
          return { ...offer, route: { kind: "relay" as const, origin: new URL(offer.url).origin } };
        }
        return this.mobileOr().pair(botIds, cmd.route);
      }
      case "mobile.revoke": {
        if (!this.mobileDesk && !this.relay) throw new Error("The phone connection is not set up.");
        this.mobileDesk?.revoke(cmd.deviceId);
        await this.relay?.revoke(cmd.deviceId);
        return this.mobileView();
      }
      case "mobile.relay": {
        if (!this.relay) throw new Error("The phone relay is not available.");
        await this.relay.setURL(cmd.url);
        return this.mobileView();
      }
      // Botling 3's first pairing and code check (botlingd answers them itself); the 2.x renderer never sends them.
      case "mobile.cluster":
      case "mobile.confirm": throw new ContractError("conflict", "This is a Botling 3 pairing request.");
      case "machines.view": return this.machinesView();
      case "machines.hosts": return { hosts: this.machinesOr().sshHosts().slice(0, 500) };
      case "machines.add": {
        const name = cmd.name?.trim() || undefined;
        if (name && !MACHINE_NAME.test(name)) throw new ContractError("bad_request", "A machine's name is letters, digits, and . _ @ - (up to 64).");
        await this.machinesOr().addSsh(cmd.host.trim(), name ?? machineNameFrom(cmd.host.trim()));
        return this.machinesView();
      }
      case "machines.pair": {
        const { command, expiresAt } = await this.machinesOr().pairRelay();
        return { command, expiresAt };
      }
      case "machines.approve": {
        const remote = this.machinesOr();
        const machine = remote.machines.get(cmd.id);
        if (!machine) throw new ContractError("not_found", "No such machine.");
        if (machine.via === "relay") {
          if (!cmd.code?.trim()) throw new ContractError("bad_request", "Type the code the machine shows.");
          await remote.approveRelay(cmd.id, cmd.code);
        } else await remote.approveSsh(cmd.id);
        return this.machinesView();
      }
      case "machines.decline": await this.machinesOr().decline(cmd.id); return this.machinesView();
      case "machines.revoke": this.machinesOr().revoke(cmd.id); return this.machinesView();
      case "machines.remove": this.machinesOr().remove(cmd.id); return this.machinesView();
      case "machines.check": {
        // What the check found (or why it failed) is in the machine's info.
        try { await this.machinesOr().check(cmd.id); } catch (error) { if (!this.machinesOr().machines.get(cmd.id)?.info?.error) throw error; }
        return this.machinesView();
      }
      case "bot.configure": {
        const { type: _type, botId, ...change } = cmd;
        return this.bot(botId).configure(change);
      }
      case "bot.restart": return this.bot(cmd.botId).restartNow();
      case "files.add": this.bot(cmd.botId); return { files: this.pending.addPaths(cmd.botId, cmd.paths) };
      case "files.data": this.bot(cmd.botId); return { files: await this.pending.addData(cmd.botId, cmd.name, cmd.base64) };
      case "files.remove": this.checkBot(cmd.botId); return { files: this.pending.remove(cmd.botId, cmd.id) };
      case "project.files": {
        this.bot(cmd.botId);
        const profile = this.profiles.find(p => p.id === cmd.botId);
        if (!profile) throw new ContractError("not_found", "No project.");
        return this.projectFiles.search(profile.folder, cmd.query);
      }
      case "project.preview": {
        this.bot(cmd.botId);
        const profile = this.profiles.find(p => p.id === cmd.botId);
        if (!profile) throw new ContractError("not_found", "No project.");
        return this.projectFiles.preview(profile.folder, cmd.path);
      }
      case "attachment.file": return this.attachmentFile(cmd.botId, cmd.ref, cmd.line);
      case "plugins.loaded": this.plugins.webLoaded(cmd.name); return {};
      case "plugins.failed": this.plugins.webFailed(cmd.name, cmd.message); return {};
      case "plugins.notice": this.plugins.webNotice(cmd.name, cmd.text); return {};
      case "plugins.file": return this.plugins.webFile(cmd.name, cmd.path);
      case "heads.set": return this.bot(cmd.botId).setHeads(cmd.engines);
      case "usage.view": if (!cmd.localOnly) await this.usage.refresh(); return usageView(this.usage.view(), cmd.localOnly);
      case "doctor.view": return this.doctor.view();
      case "doctor.run": return this.doctor.run(cmd.includeLatest);
      case "heads.answerWith": return this.bot(cmd.botId).setAnswerWith(cmd.to);
      case "handoff.stop": return this.bot(cmd.botId).stopHandoff(cmd.handoffId);
      case "rounds.stop": return this.bot(cmd.botId).stopRounds();
      case "chat.ignoreQuestion": return this.ignoreQuestion(cmd.botId, cmd.messageId);
      case "chat.choose": return this.calledInPick(cmd.botId, cmd.messageId, cmd.index) ?? this.bot(cmd.botId).choose(cmd.messageId, cmd.index, cmd.text);
      case "chat.answer": {
        // A component's pictures: written to incoming/, kept by the bot with the answer, then removed.
        const files = (cmd.images ?? []).flatMap((image) => writeIncoming(join(this.options.dataDir, "incoming"), image.name, image.base64) ?? []);
        try {
          if (cmd.picks) return this.calledInGroupAnswer(cmd.botId, cmd.messageId, cmd.picks, files.length) ?? this.bot(cmd.botId).answer(cmd.messageId, cmd.text, files, cmd.picks);
          return this.calledInAnswer(cmd.botId, cmd.messageId, cmd.text, files.length) ?? this.bot(cmd.botId).answer(cmd.messageId, cmd.text, files);
        } finally { for (const file of files) rmSync(file, { force: true }); }
      }
      case "chat.react": return this.bot(cmd.botId).react(cmd.messageId, cmd.emoji, cmd.present);
      case "chat.history": return this.bot(cmd.botId).history(cmd.before, cmd.bytes, cmd.until);
      case "task.output": return this.bot(cmd.botId).taskOutput(cmd.messageId, cmd.taskId);
      case "subagent.view": return this.agentView(cmd.botId, cmd.subagentId);
      case "worker.cwd": {
        this.checkBot(cmd.botId);
        // Where the worker runs: its host bot's session folder (a worktree when one is set), else that bot's own folder.
        const record = this.agents.byHostBot(cmd.botId, cmd.subagentId) ?? this.agents.movedIn(cmd.botId).find((candidate) => candidate.nativeId === cmd.subagentId);
        const hostId = record?.host.botId ?? cmd.botId;
        const profile = this.profiles.find((candidate) => candidate.id === hostId);
        return { cwd: this.plugins.sessionFolder(hostId)?.cwd ?? record?.host.folder ?? profile?.folder ?? null };
      }
      case "agent.targets": return this.agentTargets(cmd.botId, cmd.subagentId);
      case "agent.move": return this.moveAgent(cmd.botId, cmd.subagentId, cmd.to, { notifyAgent: cmd.notifyAgent === true });
      case "agent.message": return this.agentMessageCommand(cmd.botId, cmd.subagentId, cmd.text);
      case "agent.stop": return this.agentStopCommand(cmd.botId, cmd.subagentId);
      case "agent.group": return this.groupAgents(cmd.botId, cmd.subagentIds, { kind: "newSubBot", name: cmd.name, ...(cmd.note ? { note: cmd.note } : {}) });
      case "subbot.close": return this.closeSubBot(cmd.botId);
      case "chat.shown": {
        if (cmd.botId) this.checkBot(cmd.botId);
        // The main window says what it shows; plugins watching the workspace hear it (kind "current").
        this.shownChat = cmd.botId ? { botId: cmd.botId, view: cmd.view, tab: cmd.tab } : null;
        this.checkWorkspaceSoon();
        return { shown: true };
      }
      case "chat.read": {
        // You read it up to its newest line: plugins hear how much was unread before (`chatRead`).
        const bot = this.bot(cmd.botId);
        this.plugins.event("chatRead", { botId: this.outId(bot.id), ...bot.readMark() });
        return bot.read();
      }
      case "component.command": return this.bot(cmd.botId).componentCommand(cmd.messageId, cmd.index, cmd);
      case "component.approve": return this.bot(cmd.botId).componentApprove(cmd.messageId, cmd.index, cmd);
      case "component.detail": return this.bot(cmd.botId).componentDetail(cmd.name, cmd.folder, cmd.values, cmd.card, cmd.command);
      case "component.save": return this.bot(cmd.botId).componentSave(cmd.messageId, cmd.index, cmd.data);
      case "component.report": return { sent: await this.reportComponent(cmd) };
      case "chat.feedback": {
        const incoming = join(this.options.dataDir, "incoming");
        const pictures = cmd.images.flatMap((image) => writeIncoming(incoming, image.name, image.base64) ?? []);
        const shot = cmd.screenshot ? writeIncoming(incoming, "feedback.png", cmd.screenshot) : null;
        try { return { sent: this.reportFeedback(cmd.text, cmd.messageId, this.bot(cmd.botId), shot, pictures) }; }
        finally { for (const file of [...pictures, ...(shot ? [shot] : [])]) rmSync(file, { force: true }); }
      }
      case "engine.models": {
        const bot = this.bot(cmd.botId);
        return this.options.engineModels?.(cmd.engine, bot.profile) ?? discoveryFailure(cmd.engine, "unsupported", "Model discovery is unavailable in this runtime.");
      }
      case "codex.models": return { models: ((await this.options.codexModels?.()) ?? []).slice(0, 200).map((model) => ({ id: model.id.slice(0, 200), name: model.name.slice(0, 200), isDefault: model.isDefault, efforts: model.efforts?.slice(0, 10) ?? null })) };
      case "component.revert": {
        const problem = this.components.library.revert(cmd.name);
        if (problem) this.mainBot()?.appNotice(`Couldn't revert component "${cmd.name}": ${problem}`);
        this.componentsTick();
        return { reverted: !problem, problem };
      }
      case "card.image": {
        const file = this.components.images.file(cmd.token);
        if (!file) throw new ContractError("not_found", "No such picture.");
        return file satisfies ResultOf<"card.image">;
      }
      case "turn.stop": return this.bot(cmd.botId).stop(cmd.turnId);
      case "turn.await": return this.bot(cmd.botId).await(cmd.turnId, signal);
      case "routines.list": return this.bot(cmd.botId).routinesView();
      case "routines.change": {
        const { type: _type, botId: _bot, requestId, ...rest } = cmd;
        return this.bot(cmd.botId).changeRoutine({ ...rest, ...(requestId ? { request_id: requestId } : {}) });
      }
      // M5-01: call-ins between servers are Botling 3's server only; the 2.x core never takes them.
      case "callin.ask":
      case "callin.reply":
      case "callin.cancel":
        throw new ContractError("bad_request", "Botling 3 only.");
      default: throw new ContractError("not_found", `The core does not handle ${cmd.type}.`);
    }
  }

  snapshot(botId?: string): ResultOf<"chat.snapshot"> {
    const bot = botId === undefined ? this.mainBot() : this.bot(botId);
    const views = this.order.map((id) => this.botView(this.bots.get(id)!));
    return {
      epoch: this.epoch,
      seq: this.seq,
      bots: views,
      imported: this.imported,
      chat: bot ? { ...bot.snapshot(), decorations: this.plugins.decorations(bot.id), pluginData: this.plugins.chatData(bot.id), pendingFiles: this.pending.views(bot.id) } : null,
      components: this.componentInfos(),
      plugins: this.plugins.view(),
      settings: this.settingsNow(),
      doctor: this.doctor.view(),
      waiting: this.waiting(),
    };
  }

  settingsNow(): SettingsView {
    return { ...settingsView(readSettings(Layout.settings(this.options.dataDir)), this.language()), agyPermissionSessions: agyPermissionSessions(),
      claudeAutoCompactWindow: claudeAutoCompactWindow(), codexConfigFile: codexConfigFile() };
  }

  /**
   * "Apply to all bots" (the Settings page asked first; the command carries `confirmed`): every bot's engines, models,
   * effort and primary become the app's defaults. One that cannot (read-only, an engine that is not available) is listed, the rest go on.
   */
  private async applyEngineDefaultsToAll(): Promise<ResultOf<"engineDefaults.applyAll">> {
    const choices = botChoicesFromDefaults(engineDefaultsFor(readSettings(Layout.settings(this.options.dataDir))));
    const failed: { botId: string; name: string; reason: string }[] = [];
    let applied = 0;
    for (const [botId, bot] of [...this.bots]) {
      try { await bot.applyEngineChoices(choices); applied += 1; }
      catch (error) { failed.push({ botId, name: bot.profile.name, reason: String((error as Error)?.message ?? error).slice(0, 300) }); }
    }
    this.log(`engine defaults applied to ${applied} bots, ${failed.length} failed`);
    return { applied, failed };
  }

  /** One change on the Settings page: saved in settings.json (other keys kept), then told to every window. */
  changeSetting(change: SettingsChange): SettingsView {
    const file = Layout.settings(this.options.dataDir);
    const before = readSettings(file);
    const developerBefore = this.developerProject();
    if (change.key === "agyAcpPath" && change.value?.trim()) validateAgyRuntimePath(change.value.trim(), this.options.dataDir);
    const next = applySetting(before, change);
    writeSettings(file, next);
    if (change.key === "agyBypassPermissions" && before.agyBypassPermissions !== change.value) changeAgyPermissions(change.value);
    // botling.dev gives builds a fresh start after failures when developer mode is turned on again, and tells the developer
    // project's manager at once if awake, else at its next wake (`setDeveloperMode`).
    const developerNow = this.developerProject();
    if ((change.key === "developerMode" && change.value === true) || developerNow?.id !== developerBefore?.id) {
      this.plugins.event("developerChanged", { before: developerBefore?.id ?? null, now: developerNow?.id ?? null, turnedOn: change.key === "developerMode" && change.value === true });
    }
    // The engine defaults go to every bot at once (`setSubagentModelDefault`, `setCodexWorkerDefaults`).
    const model = settingsView(next).subagentModel;
    if (change.key === "subagentModel" && model !== settingsView(before).subagentModel) {
      for (const bot of this.bots.values()) bot.applyEngineDefaults({ subagentModel: model });
    }
    const subagentEffort = settingsView(next).subagentEffort;
    if (change.key === "subagentEffort" && subagentEffort !== settingsView(before).subagentEffort) {
      for (const bot of this.bots.values()) bot.applyEngineDefaults({ subagentEffort });
    }
    const workers = appliedCodexWorkers(next);
    if ((change.key === "codexWorkers" || change.key === "codexWorkersFollow") && JSON.stringify(workers) !== JSON.stringify(appliedCodexWorkers(before))) {
      for (const bot of this.bots.values()) bot.applyEngineDefaults({ codexWorkers: codexWorkersJSON(workers) });
    }
    // The Antigravity workers' defaults go to every bot as the Claude subagents' do (each worker reads its bot's at its start).
    for (const key of ["agyWorkerModel", "agyWorkerEffort"] as const) {
      const now = settingsView(next)[key];
      if (change.key === key && now !== settingsView(before)[key]) for (const bot of this.bots.values()) bot.applyEngineDefaults({ [key]: now });
    }
    if (change.key === "defaultPrimaryEngine" || change.key === "defaultEngines") for (const bot of this.bots.values()) bot.appPrimaryChanged();
    if (change.key === "claudeWorkerLimit") for (const bot of this.bots.values()) bot.claudeWorkerLimitChanged();
    if (change.key === "language" || change.key === "botLook" || change.key === "claudeWorkerLimit") this.plugins.appSettingsChanged();
    const view = this.settingsNow();
    this.event({ type: "settings.updated", settings: view });
    return view;
  }
}
