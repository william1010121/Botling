// The app page: React chrome around the reused chat page. The left column lists the bots (as the
// Swift app's sidebar); the chat area hosts Web/src's chat page in a same-origin frame
// (chat-frame/), fed with the state ChatPayload.swift would build (payload.ts). The frame posts
// what the user does (send, a pick on an approval, Stop); this page turns that into contract
// commands. Only this page has the bridge to main.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { BotView, ResultOf } from "../contract";
import { Client, RequestFailed } from "./client";
import { WorkspaceStore } from "./store";
import { chatState, subagentState } from "./payload";
import { faceURL } from "./avatars";
import { CHAT_ORIGIN, CHAT_PAGE, type FrameMessage, type ShellMessage } from "./chat-frame/protocol";
import { PluginsButton } from "./Plugins";
import { SettingsSheet } from "./Settings";
import { RightPanel } from "./RightPanel";
import { WebPane, WebPanel, WebRail } from "./Web";

export function App({ client, store }: { client: Client; store: WorkspaceStore }) {
  const view = useSyncExternalStore(store.subscribe, store.getView);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** The web AI shown in the chat column instead of a chat, if one is. */
  const [webSite, setWebSite] = useState<string | null>(null);
  const site = webSite ? view.web?.sites.find((candidate) => candidate.id === webSite) ?? null : null;
  // ⌘, (Ctrl+, elsewhere) opens Settings, as in 1.x.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "," && (event.metaKey || event.ctrlKey)) { event.preventDefault(); setSettingsOpen(true); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const chat = view.chat;
  const bot = useMemo(() => view.bots.find((candidate) => candidate.id === chat?.botId) ?? null, [view.bots, chat?.botId]);

  const fail = useCallback((failure: unknown) => {
    setError(failure instanceof RequestFailed ? failure.error.message : String((failure as Error)?.message ?? failure));
  }, []);

  /** A bot's chat again (and no site). */
  const selectBot = useCallback((botId: string) => {
    setError(null);
    if (webSite) { setWebSite(null); void client.request({ type: "web.leave" }).catch(() => {}); }
    void store.select(botId);
  }, [client, store, webSite]);

  // Web AIs: a site's own row (a fresh question unless it shows one), a conversation, New question, a row's ✓, Ask Main bot.
  const openWeb = useCallback((siteId: string, conversationId?: string) => {
    setError(null);
    setWebSite(siteId);
    store.watch(null);
    void client.request({ type: "web.open", site: siteId, ...(conversationId ? { conversationId } : {}) }).catch(fail);
  }, [client, store, fail]);
  const askMainBot = useCallback((siteId: string, conversationId: string) => {
    setError(null);
    void client.request({ type: "web.ask", site: siteId, conversationId }).then((result) => { setWebSite(null); void store.select(result.botId); }, fail);
  }, [client, store, fail]);

  // "Add project": main's folder picker; the new (or existing) project's chat is shown.
  const addProject = useCallback(() => {
    setError(null);
    void client.request({ type: "projects.pick" }).then((result) => { if (result.botId) void store.select(result.botId); }, fail);
  }, [client, store, fail]);

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
              look={view.settings?.botLook ?? "original"}
              selected={!site && candidate.id === chat?.botId}
              waiting={view.waiting.items.some((item) => item.botId === candidate.id)}
              onSelect={() => selectBot(candidate.id)}
            />
          ))}
          {view.web && view.web.sites.length > 0 && (
            <WebRail web={view.web} shown={site?.id ?? null} onOpen={openWeb}
              onSettle={(siteId, conversationId) => void client.request({ type: "web.settle", site: siteId, conversationId }).catch(fail)} />
          )}
        </nav>
        <div className="rail-add">
          <button type="button" className="rail-button" onClick={addProject}>+ Add project</button>
        </div>
        <PluginsButton client={client} plugins={view.plugins} />
        <div className="rail-settings">
          <button type="button" className={`rail-button${settingsOpen ? " on" : ""}`} onClick={() => setSettingsOpen(true)}>Settings</button>
        </div>
        {view.imported && (
          <div className="rail-note" title={view.imported.skipped.join("\n")}>
            Imported {view.imported.bots} bot{view.imported.bots === 1 ? "" : "s"} and {view.imported.messages} message{view.imported.messages === 1 ? "" : "s"} from Botling 1.x (read-only).
          </div>
        )}
      </aside>
      <section className="chat-pane">
        {site && (
          <>
            <header className="chat-header drag"><span className="chat-title">{site.name}</span></header>
            <WebPane client={client} site={site} onError={fail} />
          </>
        )}
        <div className="chat-column" hidden={!!site}>
        <header className="chat-header drag">
          {bot && <span className="chat-title">{bot.name}</span>}
          {bot && (bot.heads.length > 1 || bot.heads[0] === "codex") && (
            <span className="chat-heads" data-heads={bot.heads.join(" ")}>{bot.heads.map((head) => (head === "codex" ? "Codex" : "Claude")).join(" & ")}</span>
          )}
          {bot && <span className="chat-status" data-status={status(bot)}>{statusText(bot)}</span>}
          {bot && chat && (
            <span className="chat-actions">
              {(chat.pins?.length ?? 0) > 0 && (
                <button type="button" className={`header-button${view.board ? " on" : ""}`} aria-pressed={view.board} onClick={() => store.showBoard(!view.board)}>Board</button>
              )}
              <RoutinesButton client={client} botId={bot.id} />
            </span>
          )}
        </header>
        {bot?.problem && <div className="banner" role="alert">{bot.problem}</div>}
        {bot && chat?.heads?.rounds && (
          // The rounds line over the input box (1.x: "Review round 1 of 2 · Stop now"). The chat page
          // in this checkout gets the same data (`rounds`, `handoffs`) but does not draw it.
          <div className="rounds-bar" role="status">
            <span>{chat.heads.rounds.text}</span>
            <button type="button" onClick={() => void client.request({ type: "rounds.stop", botId: bot.id }).catch(fail)}>Stop now</button>
          </div>
        )}
        <ChatFrame client={client} store={store} onError={fail} onSent={() => setError(null)} />
        </div>
        {error && error !== bot?.problem && <div className="banner bottom" role="alert">{error}</div>}
      </section>
      {site && (
        <WebPanel site={site} onOpen={(conversationId) => openWeb(site.id, conversationId)} onAsk={(conversationId) => askMainBot(site.id, conversationId)}
          onNew={() => void client.request({ type: "web.new", site: site.id }).catch(fail)} />
      )}
      {bot && !site && (
        <RightPanel
          bot={bot} bots={view.bots} waiting={view.waiting} look={view.settings?.botLook ?? "original"}
          status={{ key: status(bot), text: statusText(bot) }}
          onSelect={selectBot}
          onIgnore={(item) => void client.request({ type: "waiting.ignore", botId: item.botId, text: item.text }).catch(fail)}
        />
      )}
      {settingsOpen && <SettingsSheet client={client} settings={view.settings} bot={bot} plugins={view.plugins} onClose={() => setSettingsOpen(false)} />}
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

function BotRow({ bot, selected, onSelect, look, waiting }: { bot: BotView; selected: boolean; onSelect: () => void; look: "original" | "cute"; waiting: boolean }) {
  const asleep = bot.phase === "asleep" && !bot.working;
  const label = [bot.name, statusText(bot), bot.approvals ? `${bot.approvals} waiting on you` : waiting ? "waiting on you" : null, bot.unread && !selected ? `${bot.unread} unread` : null].filter(Boolean).join(", ");
  return (
    <button className={`bot-row${selected ? " selected" : ""}${asleep ? " asleep" : ""}`} data-bot={bot.id} aria-current={selected ? "page" : undefined} aria-label={label} onClick={onSelect}>
      <img className="bot-avatar" src={faceURL(bot, look, { asleep, working: bot.working, waiting: bot.approvals > 0 })} alt="" />
      <span className={`bot-name${bot.role === "main" ? " main" : ""}`}>{bot.name}</span>
      <span className="bot-gap" />
      {bot.working && <span className="bot-dot working" aria-hidden="true" />}
      {bot.approvals > 0 && <span className="badge waiting" aria-hidden="true">{bot.approvals}</span>}
      {!bot.approvals && waiting && !bot.working && <span className="bot-dot waiting" aria-hidden="true" />}
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
    const { state, extras } = current.subagent ? subagentState(bot, current.subagent) : chatState(bot, chat, new Date(), quoted, {
      components: current.components, board: current.board, look: current.settings?.botLook ?? "original",
      lang: current.settings?.effectiveLanguage ?? null, chatAvatarSize: current.settings?.chatAvatarSize ?? null,
    });
    const message: ShellMessage = { botling: "state", state, extras };
    target.postMessage(message, CHAT_ORIGIN);
  }, []);

  useEffect(push, [push, view, replying]);

  // Plugins' web parts, asked for again whenever the library changes (only what changed reloads in the page).
  const lastSpecs = useRef("");
  const pushPlugins = useCallback(() => {
    void client.request({ type: "plugins.web" }).then((result) => {
      const text = JSON.stringify(result.specs);
      const target = frame.current?.contentWindow;
      if (!target || !ready.current || text === lastSpecs.current) return;
      lastSpecs.current = text;
      const message: ShellMessage = { botling: "plugins", specs: result.specs };
      target.postMessage(message, CHAT_ORIGIN);
    }, () => {});
  }, [client]);
  useEffect(() => { if (ready.current) pushPlugins(); }, [pushPlugins, view.plugins]);

  // As the window finishes opening, Chromium may move focus from the chat frame to this page and
  // leave it here: someone already typing in the chat's input box would type into nothing. When this
  // page takes focus from the chat frame without anything you did here (no click, no key), focus goes
  // back to the frame, whose page puts it back in the input box (chat-frame/entry.ts).
  useEffect(() => {
    let chatHadFocus = false;
    let lastInput = 0;
    const input = () => { lastInput = Date.now(); };
    const onBlur = () => { chatHadFocus = document.activeElement === frame.current; };
    const onFocus = () => {
      const target = frame.current;
      if (!target || !chatHadFocus || Date.now() - lastInput < 500) return;
      const active = document.activeElement;
      if (active && active !== document.body && active !== target) return;
      setTimeout(() => { if (Date.now() - lastInput >= 500 && document.hasFocus()) target.contentWindow?.focus(); }, 0);
    };
    window.addEventListener("pointerdown", input, true);
    window.addEventListener("keydown", input, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("pointerdown", input, true);
      window.removeEventListener("keydown", input, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  useEffect(() => {
    // A frame's calls (saves, Detail commands, its chip) are paced: 20 at once, then 10 a second.
    const buckets = new Map<string, { tokens: number; at: number }>();
    const paced = (key: string) => {
      const now = Date.now();
      const bucket = buckets.get(key) ?? { tokens: 20, at: now };
      bucket.tokens = Math.min(20, bucket.tokens + ((now - bucket.at) / 1000) * 10);
      bucket.at = now;
      buckets.set(key, bucket);
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    };
    const flags = (action: Record<string, unknown>, names: string[]) => Object.fromEntries(names.filter((name) => typeof action[name] === "boolean").map((name) => [name, action[name]]));
    const pinChange = (id: unknown, change: Extract<import("../contract").Command, { type: "pin.change" }>["change"]) => {
      const chat = latest.current.chat;
      if (chat && typeof id === "string") void client.request({ type: "pin.change", botId: chat.botId, id, change }).catch(onError);
    };
    const onMessage = (event: MessageEvent) => {
      // Only the chat frame itself (never a card inside it, never anything else).
      if (!frame.current || event.source !== frame.current.contentWindow || event.origin !== CHAT_ORIGIN) return;
      const message = event.data as FrameMessage | null;
      if (!message || typeof message !== "object") return;
      const chat = latest.current.chat;
      if (message.botling === "stop") {
        // Every turn under way (with two heads, both may work).
        const runs = chat?.runs?.length ? chat.runs : chat?.running ? [chat.running] : [];
        for (const run of runs) void client.request({ type: "turn.stop", botId: chat!.botId, turnId: run.turnId }).catch(onError);
        return;
      }
      if (message.botling === "page") {
        // A component frame's page: main serves it from botling-card://page/ under its own CSP.
        const answer = (url: string | null) => {
          const reply: ShellMessage = { botling: "page", id: message.id, url };
          frame.current?.contentWindow?.postMessage(reply, CHAT_ORIGIN);
        };
        if (typeof message.html !== "string" || typeof message.id !== "number") return;
        client.request({ type: "card.page", html: message.html }).then((result) => answer(result.url), () => answer(null));
        return;
      }
      if (message.botling === "request") {
        const reply = (ok: boolean, error?: string) => {
          const response: ShellMessage = { botling: "response", id: message.id, ok, ...(error ? { error } : {}) };
          frame.current?.contentWindow?.postMessage(response, CHAT_ORIGIN);
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
          // A page that (re)loaded has no plugins yet.
          lastSpecs.current = "";
          pushPlugins();
          return;
        case "resync":
          push();
          return;
        case "send": {
          // Words, or only the files waiting in the input box.
          if (!chat || typeof action.text !== "string" || (!action.text.trim() && !chat.pendingFiles?.length)) return;
          onSent();
          const reply = replyingRef.current?.botId === chat.botId ? replyingRef.current.id : undefined;
          setReplying(null);
          const to = action.to === "both" || action.to === "claude" || action.to === "codex" ? { to: action.to as "both" | "claude" | "codex" } : {};
          void client.request({ type: "chat.send", botId: chat.botId, text: action.text, ...(reply ? { replyTo: reply } : {}), ...to }).catch(onError);
          return;
        }
        case "setAnswerWith": {
          if (!chat || (action.to !== "both" && action.to !== "claude" && action.to !== "codex") || typeof action.requestID !== "number") return;
          const botId = chat.botId;
          const requestID = action.requestID;
          void client.request({ type: "heads.answerWith", botId, to: action.to })
            .then((result) => {
              const saved: ShellMessage = { botling: "answerWithSaved", botID: botId, requestID, chosen: result.answerWith };
              frame.current?.contentWindow?.postMessage(saved, CHAT_ORIGIN);
            })
            .catch(onError);
          return;
        }
        case "stopRounds":
          if (chat) void client.request({ type: "rounds.stop", botId: chat.botId }).catch(onError);
          return;
        case "stopHandoff":
          if (chat && typeof action.handoffID === "string") void client.request({ type: "handoff.stop", botId: chat.botId, handoffId: action.handoffID }).catch(onError);
          return;
        case "choose": {
          if (!chat || typeof action.messageID !== "string" || typeof action.index !== "number") return;
          const notes = typeof action.text === "string" && action.text.trim() ? { text: action.text } : {};
          void client.request({ type: "chat.choose", botId: chat.botId, messageId: action.messageID, index: action.index, ...notes }).catch(onError);
          return;
        }
        case "answer": {
          // A component's answer may bring pictures (`{name, base64}`), kept as attachments by the core.
          const images = Array.isArray(action.images) ? (action.images as unknown[]).flatMap((entry) => {
            const image = entry as { name?: unknown; base64?: unknown };
            return typeof image?.name === "string" && typeof image.base64 === "string" && image.base64 ? [{ name: image.name.slice(0, 255) || "picture.png", base64: image.base64 }] : [];
          }).slice(0, 10) : [];
          if (!chat || typeof action.messageID !== "string" || typeof action.text !== "string" || (!action.text.trim() && !images.length)) return;
          void client.request({ type: "chat.answer", botId: chat.botId, messageId: action.messageID, text: action.text, ...(images.length ? { images } : {}) }).catch(onError);
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
        case "catchUpRetry":
          if (chat && action.botID === chat.botId) void client.request({ type: "catchup.retry", botId: chat.botId, ...(typeof action.key === "string" && action.key ? { key: action.key } : {}) }).catch(onError);
          return;
        case "catchUpManual":
          if (chat && action.botID === chat.botId && typeof action.userMessageID === "string") void client.request({ type: "catchup.interval", botId: chat.botId, userMessageId: action.userMessageID }).catch(onError);
          return;
        // Components and pins: each becomes a contract command the core checks again (the card, its
        // command, the folder it showed); a frame's calls are paced so one cannot flood the core.
        case "componentCommand":
          if (chat && typeof action.messageID === "string" && typeof action.index === "number" && typeof action.command === "string" && typeof action.folder === "string") {
            void client.request({ type: "component.command", botId: chat.botId, messageId: action.messageID, index: action.index, command: action.command, folder: action.folder,
              ...(typeof action.detail === "string" ? { detail: action.detail } : {}), ...flags(action, ["approve", "force", "live"]) }).catch(onError);
          }
          return;
        case "componentDetail": {
          if (!chat || typeof action.requestID !== "number" || typeof action.name !== "string" || typeof action.folder !== "string") return;
          const requestID = action.requestID;
          const reply = (ok: boolean, value: string) => {
            const answer: ShellMessage = { botling: "detailReply", requestID, ok, value };
            frame.current?.contentWindow?.postMessage(answer, CHAT_ORIGIN);
          };
          if (!paced(`detail:${action.name}`)) { reply(false, "Too many Detail calls: wait a moment."); return; }
          const values = action.values && typeof action.values === "object" && !Array.isArray(action.values) ? action.values as Record<string, string | number> : {};
          client.request({ type: "component.detail", botId: chat.botId, name: action.name, folder: action.folder, values,
            ...(typeof action.card === "string" ? { card: action.card } : {}), ...(typeof action.command === "string" ? { command: action.command } : {}) })
            .then((result) => reply(result.ok, result.value), (failure) => reply(false, failure instanceof RequestFailed ? failure.error.message : String(failure)));
          return;
        }
        case "componentSave":
          if (chat && typeof action.messageID === "string" && typeof action.index === "number" && typeof action.data === "string" && paced(`save:${action.messageID}/${action.index}`)) {
            void client.request({ type: "component.save", botId: chat.botId, messageId: action.messageID, index: action.index, data: action.data }).catch(onError);
          }
          return;
        case "pin":
          if (chat && typeof action.id === "string" && (action.refresh === "shown" || action.refresh === "interval" || action.refresh === "manual") && typeof action.minutes === "number") {
            void client.request({ type: "pin.add", botId: chat.botId, id: action.id, refresh: action.refresh, minutes: action.minutes,
              ...(typeof action.messageID === "string" ? { messageId: action.messageID } : {}), ...(typeof action.index === "number" ? { index: action.index } : {}),
              ...(typeof action.name === "string" ? { name: action.name } : {}), ...(typeof action.seconds === "number" ? { seconds: action.seconds } : {}) }).catch(onError);
          }
          return;
        case "unpin": pinChange(action.id, { kind: "remove" }); return;
        case "movePin": if (typeof action.to === "number") pinChange(action.id, { kind: "move", to: action.to }); return;
        case "resizePin": if (typeof action.size === "string") pinChange(action.id, { kind: "resize", size: action.size }); return;
        case "setPinHeight": pinChange(action.id, { kind: "height", height: typeof action.height === "number" ? Math.round(action.height) : null }); return;
        case "pinStatus":
          if (typeof action.id === "string" && paced(`status:${action.id}`)) pinChange(action.id, { kind: "status", text: typeof action.text === "string" ? action.text.slice(0, 400) : null, tone: typeof action.tone === "string" ? action.tone.slice(0, 40) : null });
          return;
        case "pinSave": if (typeof action.data === "string" && paced(`save:${String(action.id)}`)) pinChange(action.id, { kind: "save", data: action.data }); return;
        case "floatPin": if (typeof action.floating === "boolean") pinChange(action.id, { kind: "float", floating: action.floating }); return;
        case "setPinFloat":
          pinChange(action.id, { kind: "floatAt", ...(typeof action.corner === "string" && ["topRight", "topLeft", "bottomRight", "bottomLeft"].includes(action.corner) ? { corner: action.corner as "topRight" } : {}),
            ...(typeof action.width === "number" ? { width: Math.round(action.width) } : {}), ...(typeof action.height === "number" ? { height: Math.round(action.height) } : {}),
            ...(typeof action.collapsed === "boolean" ? { collapsed: action.collapsed } : {}) });
          return;
        case "setPinRefresh":
          if (action.refresh === "shown" || action.refresh === "interval" || action.refresh === "manual") {
            pinChange(action.id, { kind: "refresh", refresh: action.refresh, ...(typeof action.minutes === "number" ? { minutes: action.minutes } : {}), ...(typeof action.seconds === "number" ? { seconds: action.seconds } : {}) });
          }
          return;
        case "arrangePins":
          if (chat && Array.isArray(action.places)) {
            const places = (action.places as unknown[]).flatMap((entry) => {
              const place = entry as { id?: unknown; col?: unknown; row?: unknown; size?: unknown };
              return typeof place.id === "string" && typeof place.col === "number" && typeof place.row === "number"
                ? [{ id: place.id, col: Math.max(0, Math.round(place.col)), row: Math.max(0, Math.round(place.row)), ...(typeof place.size === "string" ? { size: place.size } : {}) }] : [];
            }).slice(0, 200);
            void client.request({ type: "pin.arrange", botId: chat.botId, places }).catch(onError);
          }
          return;
        case "pinCommand":
          if (chat && typeof action.id === "string") {
            void client.request({ type: "pin.command", botId: chat.botId, id: action.id, ...(typeof action.command === "string" ? { command: action.command } : {}),
              ...(typeof action.folder === "string" ? { folder: action.folder } : {}), ...(typeof action.detail === "string" ? { detail: action.detail } : {}), ...flags(action, ["approve", "force"]) }).catch(onError);
          }
          return;
        case "pinShown":
          if (chat) void client.request({ type: "pin.shown", botId: chat.botId, ids: Array.isArray(action.ids) ? (action.ids as unknown[]).filter((id): id is string => typeof id === "string").slice(0, 200) : null }).catch(() => {});
          return;
        case "pinsVisible":
          if (chat && Array.isArray(action.ids)) void client.request({ type: "pin.shown", botId: chat.botId, visible: true, ids: (action.ids as unknown[]).filter((id): id is string => typeof id === "string").slice(0, 200) }).catch(() => {});
          return;
        case "closeSubagent":
          store.watch(null);
          return;
        // Files for the next message: main's picker, a pasted or dropped file the page read, taking one out.
        case "pickFiles":
          if (chat) void client.request({ type: "files.pick", botId: chat.botId }).catch(onError);
          return;
        case "addFileData":
          if (chat && typeof action.name === "string" && typeof action.base64 === "string" && action.base64) {
            void client.request({ type: "files.data", botId: chat.botId, name: action.name.slice(0, 255) || "file", base64: action.base64 }).catch(onError);
          }
          return;
        case "removeFile":
          if (chat && typeof action.id === "string") void client.request({ type: "files.remove", botId: chat.botId, id: action.id }).catch(onError);
          return;
        // Plugins' web parts in the page (`PluginBridge` in 1.x).
        case "pluginLoaded":
          if (typeof action.name === "string" && action.name !== "ccb-latex") void client.request({ type: "plugins.loaded", name: action.name }).catch(() => {});
          return;
        case "pluginError":
          if (typeof action.name === "string" && action.name !== "ccb-latex") {
            void client.request({ type: "plugins.failed", name: action.name, message: typeof action.message === "string" ? action.message.slice(0, 4_000) : "" }).catch(() => {});
          }
          return;
        case "pluginNotice":
          if (typeof action.name === "string" && typeof action.text === "string" && action.text.trim() && paced(`notice:${action.name}`)) {
            void client.request({ type: "plugins.notice", name: action.name, text: action.text.slice(0, 4_000) }).catch(() => {});
          }
          return;
        case "command":
          if (typeof action.id === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(action.id)) void client.request({ type: "plugins.command", id: action.id }).catch(onError);
          return;
        case "hostCall": {
          if (typeof action.plugin !== "string" || typeof action.method !== "string" || typeof action.callID !== "number") return;
          const callID = action.callID;
          const answer = (ok: boolean, value: unknown) => {
            const reply: ShellMessage = { botling: "hostReply", callID, ok, value };
            frame.current?.contentWindow?.postMessage(reply, CHAT_ORIGIN);
          };
          if (!paced(`host:${action.plugin}`)) { answer(false, "Too many calls: wait a moment."); return; }
          client.request({ type: "plugins.call", name: action.plugin, method: action.method.slice(0, 200), params: action.params ?? null })
            .then((result) => answer(true, result.result), (failure) => answer(false, failure instanceof RequestFailed ? failure.error.message : String(failure)));
          return;
        }
        default:
          // Drafts, files, reactions, components, pins… are not in 2.0 yet.
          return;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [client, onError, onSent, push, pushPlugins, store]);

  return <iframe id="chat-frame" ref={frame} src={CHAT_PAGE} title="Chat" />;
}

/**
 * The bot's routines (routines.cron and the app's own schedules), with Pause / Resume / Cancel —
 * a small stand-in until 2.0 has 1.x's Settings → Routines page.
 */
function RoutinesButton({ client, botId }: { client: Client; botId: string }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ResultOf<"routines.list"> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(() => {
    void client.request({ type: "routines.list", botId }).then(setList, (failure) => setProblem(String((failure as Error)?.message ?? failure)));
  }, [client, botId]);
  useEffect(() => { if (open) load(); }, [open, load]);
  useEffect(() => { setOpen(false); setList(null); }, [botId]);
  const change = (operation: "pause" | "resume" | "cancel", id: string) => {
    setProblem(null);
    void client.request({ type: "routines.change", botId, operation, id }).then(setList, (failure) => setProblem(failure instanceof RequestFailed ? failure.error.message : String(failure)));
  };
  const paused = (status: string) => status === "paused";
  return (
    <span className="routines">
      <button type="button" className={`header-button${open ? " on" : ""}`} aria-expanded={open} onClick={() => setOpen(!open)}>Routines</button>
      {open && (
        <div className="routines-panel" role="dialog" aria-label="Routines">
          {list?.error && <p className="routines-problem">{list.error}</p>}
          {problem && <p className="routines-problem">{problem}</p>}
          {list && !list.routines.length && <p className="routines-empty">No routines yet. Ask the bot to schedule one.</p>}
          <ul>
            {list?.routines.map((routine) => (
              <li key={routine.id} data-status={routine.status}>
                <div className="routine-title">{routine.title}</div>
                <div className="routine-when">
                  {routine.kind === "once" ? new Date(routine.schedule).toLocaleString() : routine.schedule}
                  {routine.timezone !== "system_local" ? ` · ${routine.timezone}` : ""} · {routine.status.replace("_", " ")}
                  {routine.next ? ` · next ${new Date(routine.next).toLocaleString()}` : ""}
                </div>
                <div className="routine-buttons">
                  {(routine.status === "pending" || routine.status === "enabled" || routine.status === "due") && <button type="button" onClick={() => change("pause", routine.id)}>Pause</button>}
                  {paused(routine.status) && <button type="button" onClick={() => change("resume", routine.id)}>Resume</button>}
                  {routine.status !== "fired" && routine.status !== "cancelled" && routine.status !== "delivery_uncertain" && <button type="button" onClick={() => change("cancel", routine.id)}>Cancel</button>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </span>
  );
}
