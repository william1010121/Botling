// BotQuestions (M7-S44): the questions a bot puts to the user and what answers them: tool approvals (the card, its timer,
// "Allow once / Always allow / Don't allow", the closing of one nobody answered), the calls auto mode blocked and their
// "allow" rules, a worker's approval routed to its owner, and the user's pick (`choose`) or words (`answer`,
// `answerQuestions`) on any question line. It owns the approvals and the rules the user has given; every other name its
// bodies read is borrowed from the `Bot` it belongs to through the bridge block below (the convention of context.ts).
// `tellHead` stays in `Bot` (tests replace it on an instance), so the bridge forwards it.
import { answerLabel } from "../attachments";
import { type ApprovalAnswerer, type WorkerApproval } from "../agent-registry";
import { ContractError, type ResultOf } from "../../contract";
import { type StreamItem } from "../agent/stream";
import { answerMessage, savedQuestions, validPicks, type QuestionPick } from "../questions";
import { alwaysAllows } from "../permission-rules";
import { isOpenQuestion, newId, swiftDateISO, toSwiftDate, type ChatRecord, type ChoiceRecord } from "../store/records";
import { RECENT_TOOL_CALLS, NO_LONGER_NEEDED, NO_ANSWER, NEVER_ALWAYS, type AgentHead, type Turn, type Approval } from "./types";
import { isReviewRefusal, isRule, allowRule, permissionText, approvalSummary } from "./view-functions";
import type { Conductor, ConductorAction, Engine, CardPick } from "../heads";
import type { HostFacts } from "../agent-registry";
import type { SubagentBook } from "../subagents";
import type { BotStore } from "../store/bot-store";
import type { Bot } from "../bot";
import type { BotOptions, Denial } from "./types";

export class BotQuestions {
  constructor(private readonly host: Bot) {}

  // ---- Bridge: the names borrowed from `Bot` (one line each) ----
  get options(): BotOptions { return this.host.options; }
  get store(): BotStore { return this.host.store; }
  get subagents(): SubagentBook { return this.host.subagents; }
  get owner(): Bot { return this.host.owner; }
  get members(): Bot[] { return this.host.members; }
  get peers(): Bot[] { return this.host.peers; }
  get profile() { return this.host.profile; }
  get engine(): Engine { return this.host.engine; }
  get sharesChat(): boolean { return this.host.sharesChat; }
  get singleActionApprovals(): boolean { return this.host.singleActionApprovals; }
  get records(): ChatRecord[] { return this.host.records; }
  get head(): AgentHead | null { return this.host.head; }
  get problem(): string | null { return this.host.problem; }
  get turn(): Turn | null { return this.host.turn; }
  get shuttingDown(): boolean { return this.host.shuttingDown; }
  get conductor(): Conductor { return this.host.conductor; }
  get commandFolder(): string { return this.host.commandFolder; }
  get appQuestions(): Map<string, (index: number) => void> { return this.host.appQuestions; }
  get appAnswers(): Map<string, (text: string, files: string[]) => boolean> { return this.host.appAnswers; }
  get cardPicks(): Map<string, CardPick[]> { return this.host.cardPicks; }
  log(line: string) { this.host.log(line); }
  add(record: ChatRecord, opts?: { archive?: boolean }) { this.host.add(record, opts); }
  changed(record: ChatRecord) { this.host.changed(record); }
  updated() { this.host.updated(); }
  line(id: string): ChatRecord | null { return this.host.line(id); }
  hostFacts(): HostFacts { return this.host.hostFacts(); }
  conduct(actions: ConductorAction[]): void { this.host.conduct(actions); }
  send(...args: Parameters<Bot["send"]>): ReturnType<Bot["send"]> { return this.host.send(...args); }
  tellHead(text: string) { this.host.tellHead(text); }
  resolveDecision(messageId: string, index: number | null, text: string | undefined): boolean | null { return this.host.resolveDecision(messageId, index, text); }

  // ---- State this class owns (moved from `Bot`; `Bot` keeps an accessor for each) ----
  /** The tool approvals waiting for an answer, by message id. */
  approvals = new Map<string, Approval>();
  /** Tools and rules allowed for good (the bot's store); `Bot`'s constructor fills it. */
  alwaysAllowed: string[] = [];
  /** Calls auto mode blocked that wait in the chat for your Allow, by message id (1.x's `denialAsks`). Nothing waits on them. */
  denialAsks = new Map<string, Denial>();
  /** Blocked calls allowed once: rules for this run of the app. */
  sessionRules: string[] = [];
  /** Rules given to claude while it runs, with the last call it had made then: a block of a call up to that one is no news. */
  rulesGivenAfter = new Map<string, string | null>();
  /** Recent tool calls by id, oldest first: to show and allow a blocked one. */
  toolCalls = new Map<string, { tool: string; detail: string; parent: string | null }>();
  /** `permission_denied` frames waiting for their tool result; blocked calls already shown. */
  deniedFrames = new Map<string, { tool: string | null; reason: string }>();
  deniedCalls = new Set<string>();

  // ---- Moved from `Bot` ----
  /** A worker another bot owns asks for an approval: the owner's chat shows the card (the host's own standing rules still answer what they cover). */
  routeWorkerApproval(head: ApprovalAnswerer, item: Extract<StreamItem, { kind: "permission" }>): boolean {
    const port = this.options.agents;
    if (!item.workerId || !port?.approval || isReviewRefusal(item.requestId) || !port.movedOut(this.engine).has(item.workerId)) return false;
    if (!this.singleActionApprovals && item.tool !== "Monitored command" && item.tool !== "Permissions" && alwaysAllows(this.alwaysAllowed, item, this.commandFolder)) {
      head.answer(item.requestId, true, item.input);
      return true;
    }
    return port.approval(this.hostFacts(), item.workerId, item, head);
  }

  /** The owner's side: a card for a worker it owns that another bot runs; the pick goes back to that bot's `head`. */
  askForWorker(head: ApprovalAnswerer, item: WorkerApproval): void {
    if (this.options.primary) return this.options.primary.askForWorker(head, item);
    this.ask(head as unknown as AgentHead, { kind: "permission", ...item }, null);
  }

  /** A worker's approval was withdrawn: its card here (if any) is no longer needed. */
  settleWorkerApproval(requestId: string): void {
    if (this.options.primary) return this.options.primary.settleWorkerApproval(requestId);
    for (const [id, approval] of [...this.approvals]) if (approval.lasting && approval.requestId === requestId) this.settle(id, NO_LONGER_NEEDED, false);
  }

  /** Its tool approvals waiting for you: the tool, what it would run, when it asked (oldest first). */
  pendingApprovals(): { tool: string; text: string; at: string | null }[] {
    const out: { tool: string; text: string; at: string | null; date: number }[] = [];
    for (const bot of this.members) {
      for (const [id, approval] of bot.approvals) {
        const record = this.owner.records.find((candidate) => candidate.id === id);
        out.push({ tool: approval.tool.slice(0, 200), text: record ? approvalSummary(record.text) : approval.tool.slice(0, 400), at: record ? swiftDateISO(record.date) : null, date: record?.date ?? Infinity });
      }
    }
    return out.sort((a, b) => a.date - b.date).slice(0, 20).map(({ tool, text, at }) => ({ tool, text, at }));
  }

  refuseIfClosed(): void {
    if (this.options.primary) return this.options.primary.refuseIfClosed();
    if (this.problem) throw new ContractError("conflict", this.problem);
    if (this.profile.problem) throw new ContractError("conflict", this.profile.problem);
    if (this.shuttingDown) throw new ContractError("core_unavailable", "The core is shutting down.");
  }

  // ------------------------------------------------------------------------------------------
  // Approvals

  ask(head: AgentHead, item: Extract<StreamItem, { kind: "permission" }>, turn: Turn | null) {
    if (isReviewRefusal(item.requestId)) return this.showReviewRefusal(head, item);
    // A bare tool name or a 1.x rule ("Bash(npm test)", "Edit(//…)", "WebFetch(domain:…)"): permission-rules.ts.
    if (!this.singleActionApprovals && item.tool !== "Monitored command" && item.tool !== "Permissions" && alwaysAllows(this.alwaysAllowed, item, this.commandFolder)) {
      head.answer(item.requestId, true, item.input);
      return;
    }
    // Tidying: nobody is reading this turn, and it only touches memory.md.
    if (turn?.origin === "tidy" && !turn.guest) {
      head.answer(item.requestId, false, item.input, "Not now: this turn only updates your memory file.");
      return;
    }
    const choices: ChoiceRecord[] = [{ label: "Allow once", recommended: true, action: "allowOnce" }];
    if (!this.singleActionApprovals && !NEVER_ALWAYS.has(item.tool) && !item.noAlways) choices.push({ label: `Always allow ${item.tool}`, detail: `For ${this.profile.name}, from now on`, recommended: false, action: "alwaysAllow" });
    choices.push({ label: "Don't allow", recommended: false, action: "deny" });
    // Claude Code asks this itself, bypass or not (an rm on a variable that may be empty, …): the card says so, or it reads as broken permissions.
    const safety = item.safetyCheck ? `\n\nClaude Code's own safety check asks about this even when permissions are bypassed: ${item.safetyCheck.replaceAll("\n", " ")}` : "";
    const record: ChatRecord = { id: newId(), role: "bot", text: permissionText(item.tool, item.summary) + safety, date: toSwiftDate(), choices, permissionTool: item.tool, engine: this.engine };
    const expires = Date.now() + this.options.approvalTimeoutMs;
    const timer = setTimeout(() => this.expire(record.id), this.options.approvalTimeoutMs);
    this.approvals.set(record.id, { lasting: !!item.workerId || item.requestId.startsWith("monitor:"), requestId: item.requestId, tool: item.tool, input: item.input, head, timer, expires });
    this.add(record);
    this.log(`asks to use ${item.tool}`);
    this.updated();
  }

  /**
   * Codex's reviewer (auto mode) refused a call: the same card as a call Claude's auto mode blocked, with the
   * reviewer's reason. It waits past the turn (the head carries on without it); after the pick the head is told.
   */
  showReviewRefusal(head: AgentHead, item: Extract<StreamItem, { kind: "permission" }>) {
    const reason = typeof item.input.reason === "string" && item.input.reason ? `\n\nReason: ${item.input.reason.replaceAll("\n", " ")}` : "";
    const worker = typeof item.input.worker === "string" ? item.input.worker : null;
    const lead = worker ? `Worker “${worker}”: auto mode blocked` : "Auto mode blocked";
    const text = permissionText(item.tool, item.summary).replace(/^Wants to use/, lead) + reason;
    const choices: ChoiceRecord[] = [
      { label: "Allow once", recommended: true, action: "allowOnce" },
      { label: "Don't allow", recommended: false, action: "deny" },
    ];
    const record: ChatRecord = { id: newId(), role: "bot", text, date: toSwiftDate(), choices, permissionTool: item.tool, engine: this.engine };
    const expires = Date.now() + this.options.approvalTimeoutMs;
    const timer = setTimeout(() => this.expire(record.id), this.options.approvalTimeoutMs);
    this.approvals.set(record.id, { lasting: true, requestId: item.requestId, tool: item.tool, input: { ...item.input, summary: item.summary }, head, timer, expires });
    this.add(record);
    this.log(`auto mode blocked ${item.tool}`);
    this.updated();
  }

  /** After the pick on a reviewer refusal: the Codex head hears it, so an allowed call is run again (on a turn the app reviews). */
  tellReviewOutcome(approval: Approval, allowed: boolean, words?: string) {
    if (!isReviewRefusal(approval.requestId)) return;
    const what = `\`${String(approval.input.summary ?? "")}\` (${approval.tool})`;
    const worker = typeof approval.input.worker === "string" ? approval.input.worker : null;
    const on = worker ? ` for your worker "${worker}"` : "";
    this.tellHead(allowed
      ? worker
        ? `(App: The user allowed ${what}, which Codex's reviewer refused${on}. It is allowed now. It was the worker's call, not yours: tell that worker (app_send_message) to run it again as it was and carry on.)`
        : `(App: The user allowed ${what}, which Codex's reviewer refused. It is allowed now: run it again as it was, then carry on.)`
      : `(App: The user did not allow ${what}, which Codex's reviewer refused${on}.${words ? ` They said: ${words}` : " Do not try it again; carry on without it, or ask the user what to do instead."})`);
  }

  // ------------------------------------------------------------------------------------------
  // Calls auto mode blocked (1.x's `showDenial` / `decideDenial`)

  noteToolCall(item: Extract<StreamItem, { kind: "toolUse" }>) {
    const value = item.tool === "Bash" ? item.input.command : item.tool === "WebFetch" ? item.input.url : item.input.file_path ?? item.input.notebook_path;
    this.toolCalls.delete(item.id);
    this.toolCalls.set(item.id, { tool: item.tool, detail: typeof value === "string" ? value : "", parent: item.parent });
    if (this.toolCalls.size > RECENT_TOOL_CALLS) this.toolCalls.delete(this.toolCalls.keys().next().value!);
  }

  /** Rules for calls you allowed after auto mode blocked them: always, then this run's. */
  get allowRules(): string[] {
    const always = this.alwaysAllowed.filter(isRule);
    return [...always, ...this.sessionRules.filter((rule) => !always.includes(rule))];
  }

  /**
   * Auto mode's classifier refused a call: the same card as a tool question, for that very call and the
   * classifier's reason. Allowing it adds a rule that lets exactly that through, then tells claude to retry.
   */
  showDenial(denial: Extract<StreamItem, { kind: "permissionDenied" }>) {
    // The frame comes first; the tool result says whether it was a block.
    if (!denial.confirmed) {
      if (this.deniedFrames.size > 100) this.deniedFrames.clear();
      this.deniedFrames.set(denial.toolUseId, { tool: denial.tool, reason: denial.reason });
      return;
    }
    const frame = this.deniedFrames.get(denial.toolUseId);
    this.deniedFrames.delete(denial.toolUseId);
    const reasonText = frame?.reason || denial.reason;
    if (this.turn?.origin === "tidy" || this.deniedCalls.has(denial.toolUseId)) return;
    this.deniedCalls.add(denial.toolUseId);
    const call = this.toolCalls.get(denial.toolUseId);
    const tool = denial.tool ?? frame?.tool ?? call?.tool;
    if (!tool) return;
    const rule = allowRule(tool, call?.detail ?? "");
    if (!rule) return;
    const summary = call?.detail || tool;
    const allowedBefore = this.allowRules.includes(rule);
    // Allowed already, for a call made before claude had the rule: its retry is covered.
    if (allowedBefore && this.rulesGivenAfter.has(rule)) {
      const ids = [...this.toolCalls.keys()];
      const given = this.rulesGivenAfter.get(rule);
      const callIndex = ids.indexOf(denial.toolUseId);
      const givenIndex = given ? ids.indexOf(given) : -1;
      if (callIndex >= 0 && givenIndex >= 0 && callIndex <= givenIndex) return;
    }
    const always = tool === "Bash" ? "Always allow this command"
      : ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool) ? "Always allow editing this file"
      : tool === "WebFetch" ? "Always allow this site" : `Always allow ${tool}`;
    const choices: ChoiceRecord[] = allowedBefore ? [
      { label: "I'll run it myself", recommended: true, action: "deny" },
      { label: "Don't allow", recommended: false, action: "deny" },
    ] : [
      { label: "Allow once", recommended: true, action: "allowOnce" },
      { label: always, detail: `For ${this.profile.name}, from now on`, recommended: false, action: "alwaysAllow" },
      { label: "Don't allow", recommended: false, action: "deny" },
    ];
    let reason = reasonText ? `\n\nReason: ${reasonText.replaceAll("\n", " ")}` : "";
    if (allowedBefore) reason += "\n\nYou already allowed this, but Claude Code blocked it again: it does not apply that allow to this command (made of several parts, or reaching outside the bot's folders, for example). Allowing it again would not help.";
    // A subagent's call: the card says which subagent asked.
    const agent = call?.parent ? this.subagents.get(call.parent) : undefined;
    const title = call?.parent ? (agent?.description || agent?.name || "Subagent") : null;
    const lead = title ? `Subagent “${title}”: auto mode blocked` : "Auto mode blocked";
    const text = permissionText(tool, summary).replace(/^Wants to use/, lead) + reason;
    const record: ChatRecord = { id: newId(), role: "bot", text, date: toSwiftDate(), choices, permissionTool: tool, engine: this.engine };
    const subagent = call?.parent ? `your subagent "${title}"${agent?.name ? ` (named \`${agent.name}\`)` : ""}` : null;
    this.denialAsks.set(record.id, { tool, summary, rule, subagent, allowedBefore });
    this.add(record);
    this.log(`auto mode blocked ${tool}`);
    this.updated();
  }

  /** Your pick on a blocked call: allowed, the rule goes to claude and it is told to retry; not, it is told so. */
  decideDenial(record: ChatRecord, index: number): boolean {
    const denial = this.denialAsks.get(record.id);
    const choice = record.choices?.[index];
    if (!denial || !choice) return false;
    this.denialAsks.delete(record.id);
    record.chosen = index;
    this.changed(record);
    const allowed = choice.action === "allowOnce" || choice.action === "alwaysAllow";
    const on = denial.subagent ? ` for ${denial.subagent}` : "";
    const what = `\`${denial.summary}\` (${denial.tool})`;
    this.log(`${denial.tool} blocked by auto mode: ${allowed ? (choice.action === "alwaysAllow" ? "always allowed" : "allowed once") : "not allowed"}`);
    if (denial.allowedBefore && index === 0) {
      this.tellHead(`(App: Auto mode blocked ${what} again${on}, although the user had allowed it: Claude Code does not apply that allow to this command, so allowing it cannot help. Do not try it again as it was. The user will run it themselves: tell them exactly what to run and what to send back, then wait.)`);
    } else if (!allowed) {
      this.tellHead(`(App: The user did not allow ${what}, which auto mode blocked${on}. Do not try it again; carry on without it, or ask the user what to do instead.)`);
    } else {
      if (choice.action === "alwaysAllow") {
        if (!this.alwaysAllowed.includes(denial.rule)) {
          this.alwaysAllowed.push(denial.rule);
          this.store.saveSetting("alwaysAllowed", this.alwaysAllowed);
        }
      } else if (!this.sessionRules.includes(denial.rule)) this.sessionRules.push(denial.rule);
      this.rulesGivenAfter.set(denial.rule, [...this.toolCalls.keys()].at(-1) ?? null);
      if (this.head?.running) this.head.allow(this.allowRules);
      this.tellHead(denial.subagent
        ? `(App: The user allowed ${what}, which auto mode blocked for ${denial.subagent}. It is allowed now. It was the subagent's call, not yours: do not run it yourself; tell that subagent (SendMessage) to run it again as it was and carry on.)`
        : `(App: The user allowed ${what}, which auto mode blocked. It is allowed now: run it again as it was, then carry on.)`);
    }
    this.updated();
    return true;
  }

  /** The coordinator turn ended/stopped; a monitor or managed worker may still be waiting. */
  settleTurnApprovals() {
    for (const [id, approval] of [...this.approvals]) if (!approval.lasting) this.settle(id, NO_LONGER_NEEDED, true);
  }

  /** Nobody answered in time: it counts as not allowed. */
  expire(id: string) {
    const approval = this.approvals.get(id);
    if (!approval) return;
    this.settle(id, NO_ANSWER, false);
    approval.head.answer(approval.requestId, false, approval.input, "The user did not answer in time; carry on without it, or ask again later.");
  }

  /** Closes an approval without the user's pick (`answer` says why); `deny` tells claude no. */
  settle(id: string, answer: string, deny: boolean) {
    const approval = this.approvals.get(id);
    if (!approval) return;
    clearTimeout(approval.timer);
    this.approvals.delete(id);
    if (deny && approval.head.running) approval.head.answer(approval.requestId, false, approval.input, "No longer needed.");
    const record = this.records.find((candidate) => candidate.id === id);
    if (record && isOpenQuestion(record)) {
      record.answer = answer;
      this.changed(record);
    }
    this.updated();
  }

  /** A button on a question: an approval's action, or a bot's own question answered with the pick's label (`Bot.choose`). */
  choose(messageId: string, index: number, notes?: string): ResultOf<"chat.choose"> {
    // A question group picked by index (a phone, a copy, an older page): that pick answers its first question, the rest are skipped.
    const group = this.line(messageId);
    if (group?.questions?.length && group.role === "bot" && !group.permissionTool && !this.appQuestions.has(messageId) && !this.cardPicks.has(messageId)) {
      return this.answer(messageId, "", [], group.questions.map((_, at): QuestionPick => (at === 0 ? { options: [index] } : { options: [], skipped: true })));
    }
    const resolved = this.resolveDecision(messageId, index, notes);
    if (resolved !== null) return { accepted: resolved };
    // A question the other head asked: its own to settle.
    const peer = this.peers.find(bot => bot.records.some(candidate => candidate.id === messageId));
    if (peer) return peer.choose(messageId, index, notes);
    const asked = this.appQuestions.get(messageId);
    if (asked) {
      const record = this.records.find((candidate) => candidate.id === messageId);
      if (!record || !isOpenQuestion(record) || !record.choices?.[index]) return { accepted: false };
      this.appQuestions.delete(messageId);
      this.appAnswers.delete(messageId);
      record.chosen = index;
      this.changed(record);
      asked(index);
      return { accepted: true };
    }
    const picks = this.cardPicks.get(messageId);
    if (picks) {
      const record = this.records.find((candidate) => candidate.id === messageId);
      if (!record || !isOpenQuestion(record) || !picks[index]) return { accepted: false };
      this.cardPicks.delete(messageId);
      record.chosen = index;
      this.changed(record);
      this.conduct(this.conductor.picked(picks[index]!));
      return { accepted: true };
    }
    const record = this.records.find((candidate) => candidate.id === messageId);
    if (!record?.choices?.length) throw new ContractError("not_found", "No such question.");
    const choice = record.choices[index];
    if (!choice) throw new ContractError("bad_request", "No such button.");
    if (!isOpenQuestion(record)) return { accepted: false };
    if (this.denialAsks.has(messageId)) return { accepted: this.decideDenial(record, index) };
    if (!record.permissionTool) {
      // A bot's own question: the pick goes to it as your next message, as a reply to the question.
      this.refuseIfClosed();
      record.chosen = index;
      const extra = notes?.trim();
      if (extra) record.answer = extra;
      this.changed(record);
      // With two heads, the pick goes to the head that asked.
      this.send(choice.label + (extra ? `\n\n${extra}` : ""), { replyTo: messageId, ...(this.sharesChat ? { to: this.engine } : {}) });
      return { accepted: true };
    }
    const approval = this.approvals.get(messageId);
    if (!approval) {
      record.answer = NO_LONGER_NEEDED;
      this.changed(record);
      return { accepted: false };
    }
    // What a pick means comes from its action, never its words: anything not an allow refuses.
    const allow = choice.action === "allowOnce" || (!this.singleActionApprovals && choice.action === "alwaysAllow");
    const always = !this.singleActionApprovals && choice.action === "alwaysAllow" && !NEVER_ALWAYS.has(approval.tool);
    clearTimeout(approval.timer);
    this.approvals.delete(messageId);
    record.chosen = index;
    this.changed(record);
    approval.head.answer(approval.requestId, allow, approval.input, allow ? undefined : "The user did not allow it.");
    this.tellReviewOutcome(approval, allow);
    this.log(`${approval.tool}: ${allow ? (always ? "always allowed" : "allowed once") : "not allowed"}`);
    if (always && !this.alwaysAllowed.includes(approval.tool)) {
      this.alwaysAllowed.push(approval.tool);
      this.store.saveSetting("alwaysAllowed", this.alwaysAllowed);
      // Other questions for the same tool are settled by "always".
      for (const [id, other] of [...this.approvals]) {
        if (other.tool !== approval.tool) continue;
        clearTimeout(other.timer);
        this.approvals.delete(id);
        const otherRecord = this.records.find((candidate) => candidate.id === id);
        if (otherRecord) { otherRecord.chosen = index; this.changed(otherRecord); }
        other.head.answer(other.requestId, true, other.input);
      }
    }
    this.updated();
    return { accepted: true };
  }

  /** `Bot.answer`: the user answered a question in their own words instead of a button. */
  answer(messageId: string, text: string, files: string[] = [], picks?: QuestionPick[]): ResultOf<"chat.answer"> {
    if (picks) return this.answerQuestions(messageId, picks, files);
    const resolved = this.resolveDecision(messageId, null, answerLabel(text, files.length));
    if (resolved !== null) return { accepted: resolved };
    const peer = this.peers.find(bot => bot.records.some(candidate => candidate.id === messageId));
    if (peer) return peer.answer(messageId, text, files);
    const words = text.trim();
    // A copy of another bot's question: the words go to that bot's question (`Workspace.answer`).
    const copied = this.appAnswers.get(messageId);
    if (copied) {
      const record = this.records.find((candidate) => candidate.id === messageId);
      if (!record || !isOpenQuestion(record) || (!words && !files.length)) return { accepted: false };
      const accepted = copied(words, files);
      if (accepted) { this.appQuestions.delete(messageId); this.appAnswers.delete(messageId); }
      return { accepted };
    }
    const record = this.records.find((candidate) => candidate.id === messageId);
    // A component's answer on a line with no question: your words (and its pictures) go to the bot as a message (1.x).
    if (!record?.choices?.length && record?.displays?.length) {
      if (!words && !files.length) return { accepted: false };
      this.refuseIfClosed();
      this.send(words, { files });
      return { accepted: true };
    }
    if (!record?.choices?.length) throw new ContractError("not_found", "No such question.");
    const shown = answerLabel(words, files.length);
    if (!shown || !isOpenQuestion(record)) return { accepted: false };
    const denial = this.denialAsks.get(messageId);
    if (denial) {
      // Words instead of a button on a blocked call: not allowed, and claude hears what the user said.
      this.denialAsks.delete(messageId);
      record.answer = words;
      this.changed(record);
      this.tellHead(`(App: The user did not allow \`${denial.summary}\` (${denial.tool}), which auto mode blocked${denial.subagent ? ` for ${denial.subagent}` : ""}, and said: ${shown})`);
      this.updated();
      return { accepted: true };
    }
    if (record.permissionTool) {
      // Words instead of a button: not allowed, and claude hears why.
      const approval = this.approvals.get(messageId);
      if (!approval) { record.answer = NO_LONGER_NEEDED; this.changed(record); return { accepted: false }; }
      clearTimeout(approval.timer);
      this.approvals.delete(messageId);
      record.answer = words;
      this.changed(record);
      approval.head.answer(approval.requestId, false, approval.input, `The user did not allow it and said: ${words}`);
      this.tellReviewOutcome(approval, false, words);
      this.updated();
      return { accepted: true };
    }
    this.refuseIfClosed();
    record.answer = shown;
    this.changed(record);
    this.send(words, { replyTo: messageId, files, ...(this.sharesChat ? { to: this.engine } : {}) });
    return { accepted: true };
  }

  /**
   * A question group answered together: the picks are checked against its questions, kept on the line, and the bot
   * gets one message listing each question and its answer (questions.ts), down the same road as words on a question.
   */
  answerQuestions(messageId: string, picks: QuestionPick[], files: string[]): ResultOf<"chat.answer"> {
    const record = this.line(messageId);
    const questions = savedQuestions(record?.questions);
    if (!record || !questions) throw new ContractError("not_found", "No such question.");
    const clean = validPicks(questions, picks);
    if (!clean) throw new ContractError("bad_request", "Those answers do not fit the questions.");
    if (!isOpenQuestion(record)) return { accepted: false };
    record.picks = clean;
    let result: ResultOf<"chat.answer"> = { accepted: false };
    try { result = this.answer(messageId, answerMessage(questions, clean), files); }
    finally { if (!result.accepted && isOpenQuestion(record)) delete record.picks; }
    return result;
  }
}
