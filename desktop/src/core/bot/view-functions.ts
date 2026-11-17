// The functions that turn a bot's records into what the contract shows (moved out of bot.ts, M7-S15): chat lines, steps, subagents, permission text and the small helpers they share.
import { readImages } from "../read-images";
import { backgroundTaskView } from "../background-work";
import { resolve as resolvePathOf } from "node:path";
import { attachmentMissing } from "../attachments";
import type { ChoiceView, MessageView, ResultOf, StepView, SubagentView } from "../../contract";
import type { CodexItem } from "../agent/codex";
import type { Engine } from "../heads";
import { readTotals, speedView } from "../token-speed";
import { characterCount, characterPrefix } from "../briefing";
import { masked, parseReply, pluginTagNames } from "../reply";
import { readExecution, toolCount, reportedOutputTokens, type SubagentBook, type SubagentRecord, type SubagentExecution } from "../subagents";
import type { SubagentHistory } from "../store/subagent-store";
import type { DisplayData } from "../components/service";
import { savedPicks, savedQuestions } from "../questions";
import { isUUID, swiftDateISO, type ChatRecord, type ChoiceRecord, type StepRecord } from "../store/records";
import { NO_LONGER_NEEDED, NEVER_ALWAYS, type Turn } from "./types";

/** `ComponentState.isKeepable`: JSON of anything but null, within 256K UTF-16 characters. */
export function keepable(json: string): boolean {
  if (!json || json.length > 256 * 1024) return false;
  try { return JSON.parse(json) !== null; } catch { return false; }
}

export const resolvePath = (path: string) => resolvePathOf(path);

/** `Bot.union`: the heads in either list, Claude first; undefined when none. */
export function union(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  const both = new Set([...(a ?? []), ...(b ?? [])]);
  const out = ["claude", "codex", "agy"].filter((engine) => both.has(engine));
  return out.length ? out : undefined;
}

export const firstLine = (text: string) => text.split(/\r?\n/).find((part) => part.length) ?? text;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** The id claude's command_lifecycle names a turn's message by (the one it was sent with), lowercased. */
export const turnCommandId = (turn: Turn) => (turn.userId ?? turn.messageId).toLowerCase();

/** `Bot.preview(of:)`: a line's first line, ≤ 60 characters (what a reply to it quotes). */
export function preview(record: ChatRecord): string {
  const line = record.text.split(/[\n\r\u2028\u2029]+/).find((part) => part.length > 0) ?? decodeURIComponent(record.attachments?.[0]?.url.split("/").pop() ?? "");
  return characterCount(line) > 60 ? `${characterPrefix(line, 60)}…` : line;
}

/** Tags held back while still being written, and those that end with their opening `>` (attributes only). */
const BLOCK_TAGS = ["choices", "show", "component", "new-bot", "sub-bot", "remove-sub-bot", "remove-bot", "new-project", "plugin", "install", "need-folder",
  "give-component", "take-component", "suggest-component", "component-spec", "component-declined", "open-question", "no-reply",
  "task", "reaction", "decision-ref", "end", "block", "agent-message", "agent-stop", "card"];
const ATTRIBUTE_TAGS = new Set(["task", "reaction", "decision-ref", "open-question", "agent-stop", "remove-sub-bot", "remove-bot"]);

/**
 * The reply so far as the chat shows it while it streams: the app's complete tags taken out, and
 * a tag still being written held back (from its `<` on), so no raw tag flashes in the bubble.
 */
export function streamingText(raw: string): string {
  // Tags in code are examples: they are looked for outside code only (code that is not closed yet counts as code).
  const outside = masked(raw);
  let cut = -1;
  for (const name of [...BLOCK_TAGS, ...pluginTagNames()]) {
    const opener = new RegExp(`<${name}(?=[\\s/>]|$)`, "g");
    let open = -1;
    for (const match of outside.matchAll(opener)) open = match.index!;
    if (open < 0) continue;
    const rest = outside.slice(open);
    const closed = rest.includes(`</${name}>`) || /^<[^>]*\/>/.test(rest) || (ATTRIBUTE_TAGS.has(name) && /^<[^>]*>/.test(rest));
    if (!closed && (cut < 0 || open < cut)) cut = open;
  }
  // A `<` at the very end may be the start of a tag.
  const tail = /<[a-z/-]*$/i.exec(outside);
  if (tail && (cut < 0 || tail.index < cut)) cut = tail.index;
  return parseReply(cut >= 0 ? raw.slice(0, cut) : raw).body;
}

/** The subagent an item is a step of (1.x's `Bot.subagentID(of:)`), or null. */
export function subagentOf(item: CodexItem): string | null {
  switch (item.kind) {
    case "toolUse": case "toolResult": return item.parent;
    case "subagentText": case "subagentUser": return item.parent;
    case "subagentStarted": case "subagentWaiting": case "subagentOutput": return item.id;
    default: return null;
  }
}

/** A card for a call Codex's reviewer (auto mode) refused (`CodexSession.reviewed`). */
export function isReviewRefusal(requestId: string): boolean {
  return requestId.startsWith("codex-review:");
}

/** An always-allowed entry that is a permission rule ("Bash(npm test)"), not a tool name. */
export function isRule(entry: string): boolean {
  return entry.includes("(") && entry.endsWith(")");
}

/**
 * The permission rule that lets exactly this call through (`Bot.allowRule`): the command, the file (as
 * `//absolute/path`; Edit rules cover every file tool), the site. Null when there is nothing narrow to allow.
 */
export function allowRule(tool: string, detail: string): string | null {
  const value = detail.trim();
  switch (tool) {
    case "Bash": return value ? `Bash(${value})` : null;
    case "Write": case "Edit": case "MultiEdit": case "NotebookEdit": return value.startsWith("/") ? `Edit(/${value})` : null;
    case "WebFetch": {
      try { const host = new URL(value).hostname; return host ? `WebFetch(domain:${host})` : null; } catch { return null; }
    }
    default: return NEVER_ALWAYS.has(tool) ? null : tool;
  }
}

/** The question, with what would run shown as code so nothing in it renders as a link or formatting (`Bot.permissionText`). */
export function permissionText(tool: string, summary: string): string {
  const longest = Math.max(0, ...(summary.match(/~+/g) ?? []).map((run) => run.length));
  const fence = "~".repeat(Math.max(3, longest + 1));
  return `Wants to use \`${tool.replaceAll("`", "'")}\`:\n\n${fence}\n${summary}\n${fence}`;
}

export const clip = (text: string | undefined | null, limit: number) => (text == null ? null : text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

/** A step as the contract shows it; a subagent's with its status and tool count (`ChatPayload.stepView`). */
export function stepView(step: StepRecord, subagents?: Pick<SubagentBook, "get">): StepView {
  const kind = (["tool", "text", "subagent", "message"] as const).includes(step.kind) ? step.kind : "tool";
  const subagent = kind === "subagent" ? subagents?.get(String(step.id)) : undefined;
  const view: StepView = {
    id: String(step.id).slice(0, 200),
    kind,
    tool: clip(step.tool, 200),
    title: clip(subagent?.description || String(step.title ?? ""), 2_000) ?? "",
    detail: clip(step.detail, 10_000),
    output: clip(step.output, 10_000),
    failed: step.failed === true,
    done: step.done === true,
  };
  const images = readImages(step);
  if (images.length) view.images = images;
  if (kind === "message" && step.from) {
    view.from = step.from.slice(0, 40);
    if (typeof step.at === "number") view.time = iso(step.at);
    if (step.queued) view.queued = true;
  }
  if (kind === "subagent") {
    view.status = subagent?.status ?? (step.done ? (step.failed ? "failed" : "completed") : "running");
    view.count = subagent ? toolCount(subagent) : null;
    if (subagent && subagent.status !== "running") view.done = true;
  }
  return view;
}

/** A routines view without its next times (they move with the clock alone). */
export function routinesKey(view: ResultOf<"routines.list">): string {
  return JSON.stringify([view.error, view.routines.map((routine) => [routine.id, routine.status, routine.schedule, routine.timezone])]);
}

function choiceView(choice: ChoiceRecord): ChoiceView {
  return {
    label: clip(String(choice.label ?? ""), 400) ?? "",
    detail: clip(choice.detail, 400),
    recommended: choice.recommended === true,
    action: choice.action === "allowOnce" || choice.action === "alwaysAllow" || choice.action === "deny" ? choice.action : null,
  };
}

export const iso = (swift: number | undefined) => (typeof swift === "number" && Number.isFinite(swift) ? swiftDateISO(swift) : new Date(0).toISOString());

/** `ChatPayload.make(subagent:)`'s data: its task, steps, words and report. */
function executionText(id: string, execution: SubagentExecution | undefined): string {
  return [`Agent: ${id}`, ...(execution ? [`Run: ${execution.run}`, execution.threadId ? `Thread: ${execution.threadId}` : "", execution.turnId ? `Turn: ${execution.turnId}` : "", execution.ownerSessionId ? `Owner session: ${execution.ownerSessionId}` : ""] : [])].filter(Boolean).join("\n");
}

export function subagentView(subagent: SubagentRecord, owner: string, book: SubagentBook, ownerEngine?: Engine, history?: SubagentHistory): SubagentView {
  const raw = subagent.runtime;
  const runtime = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const text = (value: unknown) => typeof value === "string" && value.trim() ? clip(value.trim(), 200) : null;
  const runs = history?.runs ?? [];
  const current = history?.steps ?? subagent.steps;
  return {
    id: subagent.id.slice(0, 200),
    title: clip(subagent.description || "Subagent", 400) ?? "Subagent",
    owner: owner.slice(0, 200),
    status: subagent.status,
    type: clip(subagent.type, 200),
    model: clip(subagent.model, 200),
    engine: runtime?.engine === "agy" || runtime?.engine === "codex" || runtime?.engine === "claude" ? runtime.engine
      : subagent.type === "codex-worker" || subagent.type === "codex" ? "codex" : subagent.type === "agy-worker" ? "agy" : subagent.type === "claude-worker" ? "claude" : ownerEngine ?? "claude",
    runtime: runtime ? { reasoningEffort: text(runtime.reasoningEffort), serviceTier: text(runtime.serviceTier) } : null,
    outputTokens: reportedOutputTokens(subagent),
    tokenSpeed: speedView(readTotals(subagent.speed)),
    waitingOn: book.waitOf(subagent),
    execution: subagent.execution ?? null,
    prompt: clip(subagent.prompt, 20_000) ?? "",
    steps: [
      ...runs.flatMap(({ run, steps }, index) => {
        const execution = readExecution(run.execution);
        const status = typeof run.status === "string" ? run.status : "stopped";
        return [
          { id: `history:${index}`, kind: "message" as const, title: `Previous run${execution ? ` ${execution.run}` : ""} · ${status}\n${executionText(subagent.id, execution)}\n\n${run.prompt ?? ""}`, failed: false, done: true },
          // Agent steps must keep their real drill-through id in history too.
          ...steps.slice(-200).map((step) => ({ ...step, id: step.kind === "subagent" ? step.id : `history:${index}:${step.id}`, done: true })),
          { id: `history:${index}:result`, kind: "text" as const, title: run.result || `Run ${status}.`, failed: status === "failed", done: true },
        ];
      }),
      ...(runs.length ? [{ id: "current-run", kind: "message" as const, title: `Current run${subagent.execution ? ` ${subagent.execution.run}` : ""}\n${executionText(subagent.id, subagent.execution)}\n\n${subagent.prompt}`, failed: false, done: true }] : []),
      ...current,
    ].slice(-500).map((step) => stepView(step, book)),
    result: clip(subagent.result, 20_000),
    startedAt: iso(subagent.startedAt),
    endedAt: subagent.endedAt != null ? iso(subagent.endedAt) : null,
  };
}

/** A chat line as the contract shows it (what 1.x's ChatPayload.Message is built from). */
export function messageView(record: ChatRecord, approval?: { expires: number }, subagents?: Pick<SubagentBook, "get">, displays?: DisplayData[]): MessageView {
  const view: MessageView = { id: record.id, role: record.role, text: record.text.slice(0, 400_000), time: swiftDateISO(record.date) };
  if (record.turnID && /^[A-Za-z0-9_.:-]{1,64}$/.test(record.turnID)) view.turnId = record.turnID;
  if (record.state) view.state = record.state;
  if (record.choices?.length) {
    view.choices = record.choices.slice(0, 20).map(choiceView);
    view.chosen = typeof record.chosen === "number" && record.chosen >= 0 ? record.chosen : null;
    // The legacy status label is presentation only; the persisted record holds system provenance.
    view.answer = typeof record.answer === "string" ? record.answer.slice(0, 4_000) : record.questionInvalidatedAt && !record.ignoredAt ? NO_LONGER_NEEDED : null;
    if (record.ignoredAt) view.ignoredAt = record.ignoredAt;
    const questions = savedQuestions(record.questions);
    if (questions) {
      view.questions = questions.map((question) => ({ question: question.question, multiple: question.multiple, options: question.options.map(choiceView) }));
      const picks = savedPicks(questions, record.picks);
      if (picks) view.picks = picks.map((pick) => ({ options: pick.options, other: pick.other ?? null, skipped: pick.skipped === true, ...(pick.notes ? { notes: { ...pick.notes } } : {}) }));
    }
  }
  if (record.permissionTool) view.approval = { tool: record.permissionTool.slice(0, 200), expires: approval ? new Date(approval.expires).toISOString() : null };
  if (record.steps?.length) view.steps = record.steps.slice(-500).map((step) => stepView(step, subagents));
  if (Array.isArray(record.backgroundTasks) && record.backgroundTasks.length) {
    // Persisted tasks can come from older/newer builds: drop one unrecognized task, never the message.
    view.backgroundTasks = record.backgroundTasks.flatMap((value: unknown) => {
      const task = backgroundTaskView(value);
      return task ? [task] : [];
    });
  }
  if (record.interrupted) view.interrupted = true;
  if (record.attachments?.length) {
    view.attachments = record.attachments.slice(0, 50).filter((file) => typeof file?.url === "string").map((file) => ({
      name: decodeURIComponent(file.url.split("/").pop() ?? "file").slice(0, 400),
      kind: file.kind === "image" || file.kind === "video" ? file.kind : "file",
      url: file.url.slice(0, 4_000),
      // An original attached by its path may have been moved or deleted since.
      ...(attachmentMissing(file.url) ? { missing: true as const } : {}),
    }));
  }
  if (typeof record.replyTo === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(record.replyTo)) view.replyTo = record.replyTo;
  if (typeof record.replyPreview === "string") view.replyPreview = record.replyPreview.slice(0, 2_000);
  if (record.engine === "agy" || record.engine === "claude" || record.engine === "codex") view.engine = record.engine;
  if (record.to === "agy" || record.to === "claude" || record.to === "codex") view.to = record.to;
  if (record.role === "user" && typeof record.via === "string" && record.via) view.via = record.via.slice(0, 200);
  if (Array.isArray(record.seenBy)) {
    const seen = (["claude", "codex", "agy"] as const).filter((engine) => record.seenBy!.includes(engine));
    if (seen.length) view.seenBy = [...seen];
  }
  if (typeof record.decisionID === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(record.decisionID)) view.decisionId = record.decisionID;
  if (isUUID(record.sourceID)) view.sourceId = record.sourceID.toUpperCase();
  if (displays?.length) view.displays = displays.map((display) => ({ ...display, name: display.name.slice(0, 200), data: display.data.slice(0, 1_100_000) }));
  if (Array.isArray(record.reactions) && record.reactions.length) {
    view.reactions = record.reactions.slice(0, 60).filter((r) => typeof r?.emoji === "string" && typeof r?.actor === "string")
      .map((r) => ({ emoji: r.emoji.slice(0, 16), actor: r.actor.slice(0, 200) }));
  }
  return view;
}

/** What a tool approval card asks to run: the text in its fence (`permissionText`), else its first line. */
export function approvalSummary(text: string): string {
  const fenced = /^(~{3,})\n([\s\S]*?)\n\1\s*$/m.exec(text);
  const body = fenced?.[2] ?? text.split(/\r?\n/).find((line) => line.trim()) ?? "";
  const line = body.trim().replace(/\s+/g, " ");
  return line.length > 400 ? `${line.slice(0, 399)}…` : line;
}
