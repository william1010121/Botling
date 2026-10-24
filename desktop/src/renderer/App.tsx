// The app page: React chrome around the reused chat page. The left column lists the bots (as the
// Swift app's sidebar); the chat area hosts Web/src's chat page in a same-origin frame
// (chat-frame/), fed with the state ChatPayload.swift would build (payload.ts). The frame posts
// what the user does (send, a pick on an approval, Stop); this page turns that into contract
// commands. Only this page has the bridge to main.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { BotView } from "../contract";
import { Client, RequestFailed } from "./client";
import { WorkspaceStore } from "./store";
import { chatState, subagentState } from "./payload";
import { avatarURL } from "./avatars";
import type { FrameMessage, ShellMessage } from "./chat-frame/protocol";

export function App({ client, store }: { client: Client; store: WorkspaceStore }) {
  const view = useSyncExternalStore(store.subscribe, store.getView);
  const [error, setError] = useState<string | null>(null);
  const chat = view.chat;
  const bot = useMemo(() => view.bots.find((candidate) => candidate.id === chat?.botId) ?? null, [view.bots, chat?.botId]);

  const fail = useCallback((failure: unknown) => {
    setError(failure instanceof RequestFailed ? failure.error.message : String((failure as Error)?.message ?? failure));
  }, []);

  // Reading a chat clears its unread count.
  useEffect(() => {
    if (bot && bot.unread > 0) void client.request({ type: "chat.read", botId: bot.id }).catch(() => {});
  }, [client, bot]);

  return (
    <div className="shell" data-ready={view.ready ? "1" : "0"}>
      <aside className="rail">
        <div className="rail-top drag" />
        <nav className="bots" aria-label="Bots">
          {view.bots.map((candidate) => (
            <BotRow
              key={candidate.id}
              bot={candidate}
              selected={candidate.id === chat?.botId}
              onSelect={() => { setError(null); void store.select(candidate.id); }}
            />
          ))}
        </nav>
        {view.imported && (
          <div className="rail-note" title={view.imported.skipped.join("\n")}>
            Imported {view.imported.bots} bot{view.imported.bots === 1 ? "" : "s"} and {view.imported.messages} message{view.imported.messages === 1 ? "" : "s"} from Botling 1.x (read-only).
          </div>
        )}
      </aside>
      <section className="chat-pane">
        <header className="chat-header drag">
          {bot && <span className="chat-title">{bot.name}</span>}
          {bot && <span className="chat-status" data-status={status(bot)}>{statusText(bot)}</span>}
        </header>
        {bot?.problem && <div className="banner" role="alert">{bot.problem}</div>}
        <ChatFrame client={client} store={store} onError={fail} onSent={() => setError(null)} />
        {error && error !== bot?.problem && <div className="banner bottom" role="alert">{error}</div>}
      </section>
    </div>
  );
}

function status(bot: BotView): string {
  if (bot.working) return "working";
  if (bot.approvals) return "waiting";
  return bot.phase;
}

function statusText(bot: BotView): string {
  if (bot.working && bot.approvals) return "Waiting for your answer";
  if (bot.working) return "Writing…";
  if (bot.phase === "tidying") return "Tidying its notes…";
  if (bot.subagents) return `${bot.subagents} subagent${bot.subagents === 1 ? "" : "s"} at work`;
  if (bot.phase === "awake") return "Awake";
  return "Asleep";
}

function BotRow({ bot, selected, onSelect }: { bot: BotView; selected: boolean; onSelect: () => void }) {
  const asleep = bot.phase === "asleep" && !bot.working;
  const label = [bot.name, statusText(bot), bot.approvals ? `${bot.approvals} waiting on you` : null, bot.unread && !selected ? `${bot.unread} unread` : null].filter(Boolean).join(", ");
  return (
    <button className={`bot-row${selected ? " selected" : ""}${asleep ? " asleep" : ""}`} data-bot={bot.id} aria-current={selected ? "page" : undefined} aria-label={label} onClick={onSelect}>
      <img className="bot-avatar" src={avatarURL(bot.avatar, asleep ? "closed" : "open")} alt="" />
      <span className={`bot-name${bot.role === "main" ? " main" : ""}`}>{bot.name}</span>
      <span className="bot-gap" />
      {bot.working && <span className="bot-dot working" aria-hidden="true" />}
      {bot.approvals > 0 && <span className="badge waiting" aria-hidden="true">{bot.approvals}</span>}
      {bot.unread > 0 && !selected && <span className="badge" aria-hidden="true">{bot.unread}</span>}
    </button>
  );
}

/** The reused chat page, in a frame. */
function ChatFrame({ client, store, onError, onSent }: { client: Client; store: WorkspaceStore; onError: (failure: unknown) => void; onSent: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const view = useSyncExternalStore(store.subscribe, store.getView);
  const latest = useRef(view);
  latest.current = view;
  // The line the next message answers (the page's Reply), per chat.
  const [replying, setReplying] = useState<{ botId: string; id: string } | null>(null);
  const replyingRef = useRef(replying);
  replyingRef.current = replying;

  const push = useCallback(() => {
    const target = frame.current?.contentWindow;
    const current = latest.current;
    const chat = current.chat;
    const bot = current.bots.find((candidate) => candidate.id === chat?.botId);
    if (!target || !ready.current || !chat || !bot) return;
    let quoted: { id: string; who: string; preview: string } | null = null;
    const reply = replyingRef.current;
    if (reply?.botId === chat.botId) {
      const line = chat.messages.find((message) => message.id === reply.id);
      if (line) quoted = { id: line.id, who: line.role === "user" ? "Reply to yourself" : `Reply to ${bot.name}`, preview: (line.text.split("\n").find(Boolean) ?? "").slice(0, 60) };
    }
    const { state, extras } = current.subagent ? subagentState(bot, current.subagent) : chatState(bot, chat, new Date(), quoted);
    const message: ShellMessage = { botling: "state", state, extras };
    target.postMessage(message, location.origin);
  }, []);

  useEffect(push, [push, view, replying]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Only the chat frame itself (never a card inside it, never anything else).
      if (!frame.current || event.source !== frame.current.contentWindow || event.origin !== location.origin) return;
      const message = event.data as FrameMessage | null;
      if (!message || typeof message !== "object") return;
      const chat = latest.current.chat;
      if (message.botling === "stop") {
        if (chat?.running) void client.request({ type: "turn.stop", botId: chat.botId, turnId: chat.running.turnId }).catch(onError);
        return;
      }
      if (message.botling === "request") {
        const reply = (ok: boolean, error?: string) => {
          const response: ShellMessage = { botling: "response", id: message.id, ok, ...(error ? { error } : {}) };
          frame.current?.contentWindow?.postMessage(response, location.origin);
        };
        const cmd = message.cmd;
        if (cmd?.type !== "card.save" && cmd?.type !== "card.action") {
          reply(false, "forbidden: only card saves and actions come from the chat page");
          return;
        }
        client.request(cmd).then(() => reply(true), (failure) => reply(false, failure instanceof RequestFailed ? `${failure.error.code}: ${failure.error.message}` : String(failure)));
        return;
      }
      if (message.botling !== "action") return;
      const action = message.action;
      switch (action?.type) {
        case "ready":
          ready.current = true;
          push();
          return;
        case "resync":
          push();
          return;
        case "send": {
          if (!chat || typeof action.text !== "string" || !action.text.trim()) return;
          onSent();
          const reply = replyingRef.current?.botId === chat.botId ? replyingRef.current.id : undefined;
          setReplying(null);
          void client.request({ type: "chat.send", botId: chat.botId, text: action.text, ...(reply ? { replyTo: reply } : {}) }).catch(onError);
          return;
        }
        case "choose": {
          if (!chat || typeof action.messageID !== "string" || typeof action.index !== "number") return;
          const notes = typeof action.text === "string" && action.text.trim() ? { text: action.text } : {};
          void client.request({ type: "chat.choose", botId: chat.botId, messageId: action.messageID, index: action.index, ...notes }).catch(onError);
          return;
        }
        case "answer": {
          if (!chat || typeof action.messageID !== "string" || typeof action.text !== "string" || !action.text.trim()) return;
          void client.request({ type: "chat.answer", botId: chat.botId, messageId: action.messageID, text: action.text }).catch(onError);
          return;
        }
        case "setReaction": {
          if (!chat || typeof action.messageID !== "string" || typeof action.emoji !== "string" || typeof action.present !== "boolean") return;
          void client.request({ type: "chat.react", botId: chat.botId, messageId: action.messageID, emoji: action.emoji, present: action.present }).catch(onError);
          return;
        }
        case "reply":
          if (chat && typeof action.messageID === "string") setReplying({ botId: chat.botId, id: action.messageID });
          return;
        case "cancelReply":
          setReplying(null);
          return;
        case "openSubagent": {
          if (!chat || typeof action.id !== "string") return;
          const botId = chat.botId;
          void client.request({ type: "subagent.view", botId, subagentId: action.id })
            .then((result) => { if (latest.current.chat?.botId === botId) store.watch(result.subagent); })
            .catch(onError);
          return;
        }
        case "closeSubagent":
          store.watch(null);
          return;
        default:
          // Drafts, files, reactions, components, pins… are not in 2.0 yet.
          return;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [client, onError, onSent, push, store]);

  return <iframe id="chat-frame" ref={frame} src="chat.html" title="Chat" />;
}
