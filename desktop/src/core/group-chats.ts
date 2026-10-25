// Group chats (1.x's GroupChat.swift): a name and the bots in it, like a group in a messenger. A
// message that names members with @ goes to them; one that names nobody goes to every member in turn,
// each deciding whether to answer (PASS keeps it quiet), seeing what the ones before it said. Each bot
// answers from its own session; the exchange shows only in the group. groups.json and groups/<id>/
// are 1.x's layout; a group's chat is a bot that never runs, as in 1.x.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Bot } from "./bot";
import type { Conversations } from "./conversations";
import { writeFileAtomic } from "./durable/atomic";
import { firstLineOf, groupName, groupPrompt, mentioned, transcriptBefore, type Member } from "./groups";
import { isUUID, newId, toSwiftDate, type ChatRecord } from "./store/records";
import type { BotProfile } from "./store/workspace";

/** `ChatGroup`: a group as groups.json keeps it. */
export interface ChatGroup { id: string; name: string; members: string[] }

export interface GroupChatsDeps {
  root: string;
  /** Everyone who can be put in a group, in turn order (`everyMember`). */
  members: () => Member[];
  bot: (id: string) => Bot | null;
  mainBotId: string;
  conversations: Conversations;
  /** Makes the bot that holds a group's chat (it never runs). */
  makeChat: (profile: BotProfile) => Bot;
  /** After the main bot's turn: what it wrote into inboxes goes out (`deliverInboxes`). */
  afterMainTurn: () => void;
  /** The groups changed (made, renamed, members, deleted). */
  changed: (id: string, removed: boolean) => void;
  log: (line: string) => void;
}

export class GroupChats {
  groups: ChatGroup[] = [];
  readonly chats = new Map<string, Bot>();

  constructor(private readonly deps: GroupChatsDeps) {
    this.load();
  }

  private get file() { return join(this.deps.root, "groups.json"); }
  private folder(id: string) { return join(this.deps.root, "groups", id); }

  /** groups.json, as 1.x reads it: an unreadable file is none. */
  private load() {
    let value: unknown;
    try { value = JSON.parse(readFileSync(this.file, "utf8")); } catch { return; }
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const { id, name, members } = entry as Record<string, unknown>;
      if (!isUUID(id) || typeof name !== "string" || !Array.isArray(members)) continue;
      const group: ChatGroup = { id: id.toUpperCase(), name, members: members.filter(isUUID).map((member) => member.toUpperCase()) };
      this.groups.push(group);
      this.openChat(group);
    }
  }

  private save() {
    mkdirSync(this.deps.root, { recursive: true });
    writeFileAtomic(this.file, JSON.stringify(this.groups));
  }

  /** A group's chat is a bot that never runs: it only holds and shows the lines (`openChat`). */
  private openChat(group: ChatGroup) {
    const home = this.folder(group.id);
    mkdirSync(home, { recursive: true });
    const chat = this.deps.makeChat({ id: group.id, name: group.name, role: "manager", avatar: "group", folder: home, memoryPath: ".bot/memory.md", storeDir: home, tools: [], job: null, problem: null });
    this.chats.set(group.id, chat);
  }

  group(id: string): ChatGroup | null { return this.groups.find((group) => group.id === id) ?? null; }
  chat(id: string): Bot | null { return this.chats.get(id) ?? null; }

  /** A group's members, in turn order (not the order they were picked in). */
  members(group: ChatGroup): Member[] {
    return this.deps.members().filter((member) => group.members.includes(member.id));
  }

  /** Makes a group of the members you picked (`createGroup`). Null without a name or a member. */
  create(rawName: string, picked: string[]): ChatGroup | null {
    const name = groupName(rawName);
    const members = this.deps.members().map((member) => member.id).filter((id) => picked.includes(id));
    if (!name || !members.length) return null;
    const group: ChatGroup = { id: newId(), name, members };
    this.groups.push(group);
    this.openChat(group);
    this.save();
    this.deps.changed(group.id, false);
    return group;
  }

  /** Renames a group and changes who is in it (`editGroup`); the chat says what changed. */
  edit(id: string, rawName: string, picked: string[]): ChatGroup | null {
    const group = this.group(id);
    const name = groupName(rawName);
    const members = this.deps.members().map((member) => member.id).filter((member) => picked.includes(member));
    if (!group || !name || !members.length) return null;
    const old = { ...group, members: [...group.members] };
    group.name = name;
    group.members = members;
    this.save();
    const chat = this.chat(id);
    if (chat) {
      chat.rename(name);
      const speaker = this.deps.conversations.speakerName;
      const added = members.filter((member) => !old.members.includes(member)).map(speaker).filter((n): n is string => !!n);
      const left = old.members.filter((member) => !members.includes(member)).map(speaker).filter((n): n is string => !!n);
      const changes: string[] = [];
      if (old.name !== name) changes.push(`Renamed to "${name}".`);
      if (added.length) changes.push(`Added ${added.join(", ")}.`);
      if (left.length) changes.push(`Took out ${left.join(", ")}.`);
      if (changes.length) chat.appNotice(changes.join(" "));
      // Questions from members taken out can no longer be answered here.
      for (const line of chat.lines()) {
        if (line.choices?.length && line.chosen === undefined && line.answer === undefined && typeof line.sourceID === "string" && !members.includes(line.sourceID)) {
          chat.settleAppQuestion(line.id, { answer: "No longer needed" });
        }
      }
    }
    this.deps.changed(id, false);
    return group;
  }

  /** Deletes a group and its chat (`deleteGroup`). The bots in it keep their own chats and memory. */
  async delete(id: string): Promise<boolean> {
    const at = this.groups.findIndex((group) => group.id === id);
    if (at < 0) return false;
    this.groups.splice(at, 1);
    const chat = this.chats.get(id);
    this.chats.delete(id);
    this.save();
    this.deps.changed(id, true);
    await chat?.shutdown({ tidy: false }).catch(() => {});
    try { rmSync(this.folder(id), { recursive: true, force: true }); } catch (error) { this.deps.log(`group ${id}: ${(error as Error).message}`); }
    return true;
  }

  /** You wrote in a group (`postToGroup`): to those you named with @, else to everyone in turn. */
  post(id: string, text: string, files: string[], replyTo?: string): { messageId: string } {
    const group = this.group(id);
    const chat = this.chat(id);
    if (!group || !chat) throw new Error("No such group.");
    const words = text.trim();
    const line: ChatRecord = { id: newId(), role: "user", text: words, date: toSwiftDate() };
    if (files.length) line.attachments = chat.keepFiles(files);
    const quoted = replyTo ? chat.line(replyTo) : null;
    if (quoted) { line.replyTo = quoted.id; line.replyPreview = firstLineOf(quoted.text).slice(0, 200); }
    chat.post(line, { unread: false });
    const members = this.members(group);
    const named = mentioned(words, members);
    this.startRound(id, named.length ? named : members, named.length > 0, line.id, null);
    return { messageId: line.id };
  }

  /** Your pick or words on a bot's line in a group go back to that bot (`answerInGroup`); false if it is gone or out. */
  answer(id: string, line: ChatRecord, text: string): boolean {
    const group = this.group(id);
    const member = group ? this.members(group).find((candidate) => candidate.id === line.sourceID) : undefined;
    if (!group || !member) return false;
    this.startRound(id, [member], true, null, text);
    return true;
  }

  /** Queues a round after any running in that group, so bots never talk over each other (`startGroupRound`). */
  private startRound(id: string, members: Member[], addressed: boolean, newest: string | null, ask: string | null) {
    this.deps.conversations.enqueue(`group:${id}`, () => this.runRound(id, members, addressed, newest, ask));
  }

  private async runRound(id: string, members: Member[], addressed: boolean, newest: string | null, ask: string | null) {
    const chat = this.chat(id);
    if (!chat) return;
    const conversations = this.deps.conversations;
    const timing = conversations.groupTiming;
    // What was said up to the line this round answers; later lines belong to later rounds.
    const before = transcriptBefore(newest, chat.lines());
    const said: string[] = [];
    const unheard: string[] = [];
    let failed = false;
    for (const member of members) {
      // Removed, taken out of the group, or the group deleted while waiting its turn.
      const group = this.group(id);
      const bot = this.deps.bot(member.id);
      if (!group || !group.members.includes(member.id) || !bot || this.chat(id) !== chat) continue;
      const transcript = [...before, ...chat.lines().filter((line) => said.includes(line.id))];
      const prompt = groupPrompt({ member, group: group.name, members: this.members(group), mainBotId: this.deps.mainBotId, addressed, chat: chat.lines(), transcript, newest, ask, speakerName: conversations.speakerName });
      conversations.speak(id, member.id);
      let answer;
      try {
        answer = await bot.groupTurn(prompt, addressed ? timing.busyNamed : timing.busy, addressed ? timing.answerNamed : timing.answer);
      } finally {
        conversations.speak(id, null);
      }
      // The main bot hands work over by writing inboxes, here as in its own chat.
      if (member.id === this.deps.mainBotId) this.deps.afterMainTurn();
      if (this.chat(id) !== chat) return;
      if (answer.kind === "busy") unheard.push(`${member.name} (busy)`);
      else if (answer.kind === "failed") { failed = true; unheard.push(`${member.name} (${firstLineOf(answer.why)})`); }
      else {
        // Tags act only for the main bot (the front desk) and for bots you named.
        const posted = await conversations.postGuestReply(answer, member, bot, chat, { passes: true, tagsAct: addressed || member.id === this.deps.mainBotId });
        if (posted) said.push(posted);
      }
    }
    // Said only when it matters: you named them, or something went wrong.
    if (unheard.length && (addressed || failed)) chat.appNotice(`Did not answer this time: ${unheard.join(", ")}.`);
  }

  /** Whether a group's folder is there (for tests). */
  exists(id: string) { return existsSync(this.folder(id)); }
}
