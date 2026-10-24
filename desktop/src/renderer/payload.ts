// The chat page from Web/src (the Swift app's chat surface) draws a `ChatState`, which the Swift
// side builds in ChatPayload.swift. Here the same state is built from the contract's views, so the
// page runs unchanged. What 2.0 has no data for yet (components, pins, heads, tasks, Catch-up) is
// left out, which the page treats as "none".
import type { BotView, CardView, MessageView } from "../contract";
import type { ChatState, ChoiceView as WebChoice, FileView, MessageView as WebMessage, StepView as WebStep } from "../../../Web/src/types";
import type { ChatView } from "./store";
import { avatarURL } from "./avatars";

/** What the chat frame needs besides the page's own state: Phase 0 cards and turn states. */
export interface FrameExtras {
  botId: string;
  running: boolean;
  /** Each message's cards (sandboxed frames the desktop draws into its bubble). */
  cards: Record<string, CardView[]>;
  /** Each message's turn state, for `data-state` on its row. */
  states: Record<string, string>;
}

const MINUTE = 60_000;

function timeOfDay(date: Date): string {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** "Today 8:15 AM" above a message that comes 30+ minutes after the one before it (ChatPayload.stamp). */
export function stamp(messages: MessageView[], index: number, now: Date): string | null {
  const date = new Date(messages[index]!.time);
  if (index > 0 && date.getTime() - new Date(messages[index - 1]!.time).getTime() < 30 * MINUTE) return null;
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(date, now)) return `Today ${timeOfDay(date)}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return `Yesterday ${timeOfDay(date)}`;
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function step(view: NonNullable<MessageView["steps"]>[number]): WebStep {
  return {
    id: view.id, kind: view.kind === "message" ? "text" : view.kind, tool: view.tool, title: view.title,
    detail: view.detail, output: view.output, failed: view.failed, done: view.done, status: null, count: null,
  };
}

export function placeholder(bot: BotView): string {
  return bot.role === "main" ? "Make a wish, or ask how things are going…" : `Message ${bot.name}…`;
}

export function chatState(bot: BotView, chat: ChatView, now = new Date()): { state: ChatState; extras: FrameExtras } {
  const face = avatarURL(bot.avatar);
  const running = chat.running;
  const extras: FrameExtras = { botId: bot.id, running: !!running, cards: {}, states: {} };
  // The running reply shows once it has words; before that the typing bubble shows its steps.
  const shown = chat.messages.filter((message) => !(running && message.id === running.messageId && !message.text && !message.cards?.length));
  const runningShown = !!running && shown.some((message) => message.id === running.messageId);
  const messages: WebMessage[] = shown.map((message, index) => {
    if (message.cards?.length) extras.cards[message.id] = message.cards;
    if (message.state) extras.states[message.id] = message.state;
    const isRunning = running?.messageId === message.id;
    const choices: WebChoice[] | null = message.choices?.map((choice) => ({ label: choice.label, detail: choice.detail, recommended: choice.recommended, action: choice.action })) ?? null;
    const steps = isRunning ? chat.live : message.steps;
    return {
      id: message.id,
      role: message.role,
      text: message.role === "bot" && message.state === "failed" && !message.text ? "(The reply did not finish.)" : message.text,
      stamp: stamp(shown, index, now),
      avatar: message.role === "bot" || message.role === "notice" ? face : null,
      choices,
      chosen: message.chosen ?? null,
      answer: message.answer ?? null,
      open: !!choices && message.chosen == null && message.answer == null,
      attachments: message.attachments?.map((file): FileView => ({ name: file.name, kind: file.kind, url: file.url })) ?? null,
      replyTo: null,
      replyPreview: message.replyPreview ?? null,
      openable: false,
      steps: steps?.length ? steps.map(step) : null,
      // Stopped or cut off: its words so far stay, and it says so.
      interrupted: message.role === "bot" && (message.interrupted || message.state === "stopped" || message.state === "failed") ? true : null,
      sourceAuthor: message.role === "bot" ? bot.name : null,
      sourceEngine: message.role === "bot" ? "claude" : null,
    };
  });
  const state: ChatState = {
    botID: bot.id,
    botName: bot.name,
    messages,
    working: !!running,
    avatar: avatarURL(bot.avatar, "open"),
    placeholder: placeholder(bot),
    replyingTo: null,
    pendingFiles: [],
    components: {},
    live: running && !runningShown ? chat.live.map(step) : [],
    slashCommands: [],
  };
  return { state, extras };
}
