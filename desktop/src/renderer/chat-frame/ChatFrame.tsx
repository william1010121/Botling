// The reused chat page in a frame: the app page's side of it (moved out of App.tsx; the lines below are unchanged).
import { chatAnswerCommand, sendChatAnswer } from "./card-answer";
import { composerBarMessage } from "../ComposerBar";
import { inputTrace } from "../input-trace";
import { ReportViewer } from "../ReportViewer";
import { setReportOpener } from "../report-opener";
import { chatQuoteAnswered } from "../composer-quote";
import { shellOverlayActive } from "../ShellOverlay";
import { nativeEditor, postToChat, observeEditorLayout } from "../editor-surface";
import { TEST_TRACE_QUERY } from "../../test-trace";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { cardImageOf } from "../../contract/attachment-url";
import { bindingsFor, commandBindings } from "../../contract/shortcuts";
import { type ApprovalAskView, type BotView } from "../../contract";
import { Client, RequestFailed } from "../client";
import { DELIVERY_UNCONFIRMED } from "../delivery";
import { WorkspaceStore } from "../store";
import { chatState, subagentState } from "../payload";
import { chatPlugins, useChatSlotsVersion } from "../chat-slot";
import { chatLinkOffered, keybindingsOf, offered, type PluginMenu } from "../plugin-commands";
import { ChatStateChannel } from "../chat-state-channel";
import { CHAT_ORIGIN, CHAT_PAGE, CHAT_FRAME_ALLOW, CHAT_SANDBOX, CHAT_TARGET, type FrameMessage, type ShellMessage } from "./protocol";
import { newSinceMark, withNewSince } from "../sub-bot-nav";
import { askOwnerText, askReference, type AskWorker } from "../worker-panel";
import { asksUser, cardApprove, cardRun } from "../card-approval";
import { FloatingChat, floatChatMessage, resendFloatChrome } from "../FloatingChat";
import { focusComposer, runPluginCommand } from "../rail-parts";
import { leaveMarks, pinnedNumber } from "../app-shared";
import { setComponentTokens } from "../../../../Web/src/component-tokens";

/** The reused chat page, in a frame. */
export function ChatFrame({ client, store, onError, onSent, onAsk, onOpenChat, askAbout = null, onAskDone, bubbleBot = null, look = "original", stripLine = "" }: { client: Client; store: WorkspaceStore; onError: (failure: unknown) => void; onSent: () => void;
  /** A plugin's `ccb.page.openChat`: show that bot's chat (at that line, when given). The app page checks the bot. */
  onOpenChat?: (botId: string, messageId?: string) => void;
  /** The bot's newest line, for the report preview's strip (FloatingChat). */
  stripLine?: string;
  /** The bot whose strip the report preview offers (ReportViewer): only while its native chat can show there, i.e. the
   * chat floats over the preview, or the chat column shows the chat (not under a tab, unless docked beside it), and no
   * browser pane would show its page over the report. */
  bubbleBot?: BotView | null; look?: "original" | "cute";
  askAbout?: { botId: string; worker: AskWorker; ownerName: string } | null; onAskDone?: () => void;
  onAsk: (view: ApprovalAskView, approve: import("../../contract").Command, done?: (allowed: boolean) => void) => void }) {
  const [report, setReport] = useState<{botId: string; url: string} | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const placeholder = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<{image:string;revision:number} | null>(null);
  useEffect(() => {
    const bridge = nativeEditor();
    if (bridge && placeholder.current) return observeEditorLayout(placeholder.current, bridge, () => true);
  }, []);
  const ready = useRef(false);
  const view = useSyncExternalStore(store.subscribeChat, store.getChatView);
  useEffect(() => { setReport(null); }, [view.chat?.botId]);
  // The report preview's bubble (the same BotBubble as the Note tab and the browser's full screen): shows this bot's real
  // chat over the page; closed whenever the preview closes or changes. Open: the input box gets the focus; Esc in the
  // app's own page (the native chat forwards it) hides it again.
  const bubble = report && bubbleBot && bubbleBot.id === report.botId ? bubbleBot : null;
  const [reportChat, setReportChat] = useState(false);
  const chatOverReport = reportChat && !!bubble;
  useEffect(() => { setReportChat(false); }, [report?.url, report?.botId, !!bubble]);
  useEffect(() => {
    if (!chatOverReport) return;
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => focusComposer()); });
    const settle = setTimeout(focusComposer, 120);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || shellOverlayActive()) return;
      event.preventDefault();
      setReportChat(false);
    };
    window.addEventListener("keydown", onKey);
    return () => { cancelAnimationFrame(frame); clearTimeout(settle); window.removeEventListener("keydown", onKey); };
  }, [chatOverReport]);
  // A plugin frame's `ccb.openLink` of a Markdown file (the Note tab): the same report preview, for the bot it names.
  useEffect(() => setReportOpener((botId, url) => setReport({ botId, url })), []);
  // The line the next message answers (the page's Reply), per chat.
  const [replying, setReplying] = useState<{ botId: string; id: string } | null>(null);
  const replyingRef = useRef(replying);
  replyingRef.current = replying;
  const askRef = useRef(askAbout);
  askRef.current = askAbout;

  const channel = useMemo(() => new ChatStateChannel(() => {
    const target = frame.current?.contentWindow;
    const current = store.getChatView();
    const chat = current.chat;
    const bot = current.bots.find((candidate) => candidate.id === chat?.botId);
    if ((!nativeEditor() && !target) || !ready.current || !chat || !bot) return null;
    let quoted: { id: string; who: string; preview: string } | null = null;
    const reply = replyingRef.current;
    if (reply?.botId === chat.botId) {
      const line = chat.messages.find((message) => message.id === reply.id);
      if (line) quoted = { id: line.id, who: line.role === "user" ? "Reply to yourself" : `Reply to ${bot.name}`, preview: (line.text.split("\n").find(Boolean) ?? "").slice(0, 60) };
    }
    // "Ask <owner>" under a worker in the main area: the worker as the input box's reference (the same bar, its × drops it).
    if (!quoted && askRef.current?.botId === chat.botId) quoted = askReference(askRef.current.worker, askRef.current.ownerName);
    const { state, extras } = current.subagent ? subagentState(bot, current.subagent) : chatState(bot, chat, new Date(), quoted, {
      components: current.components, look: current.settings?.botLook ?? "original",
      lang: current.settings?.effectiveLanguage ?? null, chatAvatarSize: current.settings?.chatAvatarSize ?? null, bots: current.bots,
      // Developer mode with Botling's source among the projects: replies get "not right" (`feedback`).
      feedback: !!current.settings?.developerMode && current.bots.some((candidate) => candidate.id === current.settings?.developerProject && candidate.role === "manager"),
      // The chat's menus are what the kernel slots of `botling.chat` hold (chat-slot.ts).
      plugins: chatPlugins(current.plugins),
    });
    // Back in a project bot from its sub bot: "New while you were in Release" over what came meanwhile.
    if (!current.subagent) {
      state.messages = withNewSince(state.messages, newSinceMark(leaveMarks.current[bot.id], state.messages), (id, text) => ({
        id, role: "divider", text, stamp: null, avatar: null, choices: null, chosen: null, answer: null, open: false,
        attachments: null, replyTo: null, replyPreview: null, openable: false, reactionEnabled: false }));
    }
    const traceId = inputTrace()?.mark("shell.state.send", () => ({ chat: state.botID, ...inputTrace()!.snapshot() }));
    return { state, extras, libraryVersion: current.libraryVersion, resyncs: current.resyncs,
      ...(traceId ? { traceId } : {}) };
  }, postToChat), [store]);
  const push = useCallback(() => channel.flush(true), [channel]);
  // A slot of the kernel changed (the chat plugin came or went, the feed caught up with a new plugin list): the menus are sent again.
  const slots = useChatSlotsVersion();
  useEffect(() => { channel.schedule(); }, [channel, view, replying, askAbout, slots]);
  useEffect(() => channel.reset, [channel]);

  // Plugins' web parts, asked for again whenever the library changes (only what changed reloads in the page).
  const plugins = useSyncExternalStore(store.subscribe, () => store.getView().plugins);
  const lastSpecs = useRef("");
  const pushPlugins = useCallback(() => {
    void client.request({ type: "plugins.web" }).then((result) => {
      const text = JSON.stringify(result.specs);
      const target = frame.current?.contentWindow;
      if ((!nativeEditor() && !target) || !ready.current || text === lastSpecs.current) return;
      lastSpecs.current = text;
      const message: ShellMessage = { botling: "plugins", specs: result.specs };
      postToChat(message);
    }, () => {});
  }, [client]);
  useEffect(() => { if (ready.current) pushPlugins(); }, [pushPlugins, plugins]);
  // The component tokens plugins set: this page's own pages (the Note tab's cards) are built with them from now on, and the chat page, which
  // draws the chat's, Board's and pins' frames, is told the whole set (again when it reloads), so frames on screen change at once.
  const tokenText = JSON.stringify(plugins?.componentTokens ?? {});
  const pushTokens = useCallback(() => postToChat({ botling: "componentTokens", tokens: store.getView().plugins?.componentTokens ?? {} }), [store]);
  useEffect(() => { setComponentTokens(JSON.parse(tokenText)); if (ready.current) pushTokens(); }, [pushTokens, tokenText]);
  // The chat page relays the app's keys too, so it is told which they are (again when it reloads).
  const savedShortcuts = useSyncExternalStore(store.subscribe, () => store.getView().settings?.shortcuts);
  const shortcutBindings = useMemo(() => bindingsFor(savedShortcuts), [savedShortcuts]);
  const pluginKeys = useMemo(() => commandBindings(keybindingsOf(plugins), savedShortcuts), [plugins, savedShortcuts]);
  const pushShortcuts = useCallback(() => postToChat({ botling: "shortcuts", bindings: shortcutBindings, commands: pluginKeys }), [shortcutBindings, pluginKeys]);
  useEffect(() => { if (ready.current) pushShortcuts(); }, [pushShortcuts]);

  // The frame owns loss detection and text input. The shell only restores its window before
  // typing, never serializes a key, and keeps explicit shell targets authoritative.
  useEffect(() => {
    if (nativeEditor()) return;
    let recoveryUntil = Date.now() + 3_000;
    let composerIntended = true;
    let shellTargetChosen = false;
    let lastShellIntentAt = 0;
    let frameStartedAt = 0;
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    let traceTimerPending = false;
    const element = frame.current;
    const mark = (event: string, extra: Record<string, unknown> = {}) => inputTrace()?.mark(event, () => ({
      recoveryUntil, composerIntended, shellTargetChosen, lastShellIntentAt, frameStartedAt,
      now: Date.now(), ...inputTrace()!.snapshot(), ...extra,
    }));
    const recoverFocus = () => {
      mark("shell.recover.check");
      if (!composerIntended || shellTargetChosen || Date.now() >= recoveryUntil || !document.hasFocus()) {
        mark("shell.recover.blocked"); return;
      }
      const active = document.activeElement;
      if (active !== document.body && active !== document.documentElement && active !== element) {
        mark("shell.recover.explicitTarget"); return;
      }
      mark("shell.recover.focus.before");
      element?.contentWindow?.focus();
      mark("shell.recover.focus.after");
      const traceId = mark("shell.recover.send");
      const message: ShellMessage = { botling: "recoverFocus", ...(traceId ? { traceId } : {}) };
      element?.contentWindow?.postMessage(message, CHAT_TARGET);
    };
    const focusChanged = () => {
      if (traceTimerPending) mark("shell.recover.timer.cancel");
      clearTimeout(focusTimer);
      const cause = mark("shell.recover.timer.schedule");
      traceTimerPending = true;
      focusTimer = setTimeout(() => { traceTimerPending = false; mark("shell.recover.timer.fire", { cause }); recoverFocus(); }, 0);
    };
    const loaded = () => {
      mark("shell.frame.load");
      // New document time precedes its scripts/load. An old shell click must not disable the new
      // frame; a new click/Tab while it loads must still win, even if its intent arrives later.
      shellTargetChosen = lastShellIntentAt >= frameStartedAt;
      focusChanged();
    };
    const intent = (event: MessageEvent) => {
      if (event.source !== element?.contentWindow || event.origin !== CHAT_ORIGIN || event.data?.botling !== "composerIntent") return;
      mark("shell.composerIntent.receive", { traceId: event.data.traceId, value: event.data.value,
        receivedStartedAt: event.data.startedAt, receivedRecoveryUntil: event.data.recoveryUntil });
      if (typeof event.data.startedAt !== "number" || event.data.startedAt < frameStartedAt) {
        mark("shell.composerIntent.stale"); return;
      }
      if (event.data.startedAt > frameStartedAt) {
        frameStartedAt = event.data.startedAt;
        shellTargetChosen = lastShellIntentAt >= frameStartedAt;
      }
      composerIntended = event.data.value === true;
      recoveryUntil = typeof event.data.recoveryUntil === "number" ? event.data.recoveryUntil : 0;
      mark("shell.composerIntent.applied");
      if (recoveryUntil) focusChanged();
    };
    const chooseShell = () => {
      shellTargetChosen = true; lastShellIntentAt = performance.timeOrigin + performance.now();
      mark("shell.intent.explicit");
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Tab" || event.key === "Escape") chooseShell(); };
    element?.addEventListener("load", loaded);
    window.addEventListener("message", intent);
    window.addEventListener("pointerdown", chooseShell, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("focus", focusChanged);
    window.addEventListener("focusin", focusChanged);
    return () => {
      if (traceTimerPending) mark("shell.recover.timer.cancel", { cleanup: true });
      clearTimeout(focusTimer);
      element?.removeEventListener("load", loaded);
      window.removeEventListener("message", intent);
      window.removeEventListener("pointerdown", chooseShell, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("focus", focusChanged);
      window.removeEventListener("focusin", focusChanged);
    };
  }, []);

  // The handlers the app passes are new functions at each of its renders (every 30 s for the column's clock, and at each
  // event): the frame's listener below reads them here, so it is not made again, and a native chat that is already bound
  // is not sent the whole state and asked for plugins again each time (its `subscribe` says "bound" to a new listener).
  const handlers = useRef({ onError, onSent, onAsk, onOpenChat });
  handlers.current = { onError, onSent, onAsk, onOpenChat };
  useEffect(() => {
    const onError = (failure: unknown) => handlers.current.onError(failure);
    const onSent = () => handlers.current.onSent();
    const onAsk: typeof handlers.current.onAsk = (view, approve, done) => handlers.current.onAsk(view, approve, done);
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
    // A card's command (a card, a spec's built card): the page only asks to run it; one not allowed yet
    // answers what this page's ApprovalSheet asks about (card-approval.ts), and only the sheet allows it.
    const runCard = (action: Record<string, unknown>, botId: string | null) => {
      const run = cardRun(action, botId);
      if (!run) return;
      void client.request(run).then((result) => {
        const approve = result.needsApproval && asksUser(action) ? cardApprove(run, result.needsApproval) : null;
        if (approve) onAsk(result.needsApproval!, approve);
      }).catch(onError);
    };
    const receive = (message: FrameMessage | null) => {
      if (!message || typeof message !== "object") return;
      const chat = store.getView().chat;
      if (message.botling === "stop") {
        // Every turn under way (with two heads, both may work).
        const runs = chat?.runs?.length ? chat.runs : chat?.running ? [chat.running] : [];
        for (const run of runs) void client.request({ type: "turn.stop", botId: chat!.botId, turnId: run.turnId }).catch(onError);
        return;
      }
      if (composerBarMessage(message)) return;
      if (floatChatMessage(message)) return;
      if (message.botling === "page") {
        // A component frame's page: main serves it from botling-card://page/ under its own CSP.
        const answer = (url: string | null) => {
          const reply: ShellMessage = { botling: "page", id: message.id, url };
          postToChat(reply);
        };
        if (typeof message.html !== "string" || typeof message.id !== "number") return;
        client.request({ type: "card.page", html: message.html }).then((result) => answer(result.url), () => answer(null));
        return;
      }
      if (message.botling !== "action") return;
      const action = message.action;
      const composerReply = (ok: boolean, error?: string) => {
        if (typeof action.requestID === "string") postToChat({ botling: "composerResult", requestID: action.requestID, ok, ...(error ? { error: error.slice(0, 4096) } : {}) });
      };
      // The words alone (not the wire code: "Not sent: core_unavailable: …" told nothing). A message whose delivery could
      // not be confirmed (the phone) is the composer's unconfirmed state, not a failure.
      const composerFailure = (error: unknown) => {
        const wire = error instanceof RequestFailed ? error.error : null;
        if (wire?.message === DELIVERY_UNCONFIRMED) {
          if (typeof action.requestID === "string") postToChat({ botling: "composerResult", requestID: action.requestID, ok: false, uncertain: true });
          return;
        }
        composerReply(false, wire ? wire.message : error instanceof Error ? error.message : String(error)); onError(error);
      };
      switch (action?.type) {
        case "composerQuoteResult":
          chatQuoteAnswered(action.requestID, action.inserted);
          return;
        case "composerModels": {
          const requestID = action.requestID;
          if (!Number.isSafeInteger(requestID) || typeof requestID !== 'number' || requestID < 1) return;
          const reply = (value?: unknown, error?: string) => postToChat({botling:'composerModelsResult',requestID,...(error ? {error:error.slice(0,4096)} : {value})});
          if (!chat || action.botID !== chat.botId) {reply(undefined,'Chat changed. Reopen the selector.');return;}
          const botId = chat.botId;
          const run = async () => {
            if (action.operation === 'settings') return client.request({type:'bot.settings',botId});
            if (action.operation === 'catalog' && ['claude','codex','agy'].includes(String(action.value)))
              return client.request({type:'engine.models',botId,engine:action.value as 'claude'|'codex'|'agy'});
            if (action.operation === 'save') {
              const change = action.value;
              if (!change || typeof change !== 'object' || Array.isArray(change) || !Object.keys(change).length || Object.keys(change).some(key=>!['model','codexModel','agyModel','effort'].includes(key))) throw new Error('Invalid model setting');
              // Core command validation remains authoritative for IDs and effort values.
              return client.request({type:'bot.configure',botId,...change});
            }
            throw new Error('Invalid model operation');
          };
          void run().then(value=>reply(value),error=>reply(undefined,String(error)));
          return;
        }
        case "searchProjectFiles":
        case "previewProjectFile": {
          if (!chat || action.botID !== chat.botId || typeof action.requestID !== "number" || typeof action.value !== "string") return;
          const requestID = action.requestID;
          const cmd = action.type === "searchProjectFiles"
            ? { type: "project.files" as const, botId: chat.botId, query: action.value.slice(0, 200) }
            : { type: "project.preview" as const, botId: chat.botId, path: action.value.slice(0, 4096) };
          void client.request(cmd).then(value => postToChat({botling: "projectFilesResult", requestID, value}), error => postToChat({botling: "projectFilesResult", requestID, error: String(error).slice(0,4096)}));
          return;
        }
        case "shellCommand":
          if (nativeEditor() && (["settings", "rightPanel", "workers", "browser", "sidebar", "search", "subBots", "roomBack", "roomForward"].includes(String(action.command)) || pinnedNumber(String(action.command)) !== null)) {
            window.dispatchEvent(new CustomEvent("botling:chat-command", { detail: action.command }));
          }
          return;
        case "ready":
          ready.current = true;
          push();
          resendFloatChrome();
          // A page that (re)loaded has no plugins yet.
          lastSpecs.current = "";
          pushPlugins();
          pushTokens();
          pushShortcuts();
          return;
        case "resync":
          push();
          return;
        case "loadHistory":
          void store.loadOlder(typeof action.until === "string" ? action.until : undefined);
          return;
        case "send": {
          // Words, or only the files waiting in the input box.
          if (!chat || typeof action.text !== "string") { composerReply(false, "Chat is not ready."); return; }
          const botId = typeof action.botID === "string" ? action.botID : chat.botId;
          const reply = replyingRef.current?.botId === botId ? replyingRef.current.id : undefined;
          const to = action.to === "agy" || action.to === "claude" || action.to === "codex" ? { to: action.to as "agy" | "claude" | "codex" } : {};
          // A worker reference ("Ask <owner>") and no reply: the words go to this bot naming the worker.
          const about = !reply && action.text.trim() && askRef.current?.botId === botId ? askRef.current : null;
          const text = about ? askOwnerText(about.worker, action.text) : action.text;
          void client.request({ type: "chat.send", botId, text, ...(reply ? { replyTo: reply } : {}), ...to }).then(result => {
            if (result.stoppedBy) { composerReply(false, `Plugin ${result.stoppedBy} stopped the message.`); return; }
            onSent();
            if (about) onAskDone?.();
            setReplying(current => current?.botId === botId && current.id === reply ? null : current);
            composerReply(true);
          }).catch(composerFailure);
          return;
        }
        case "setAnswerWith": {
          if (!chat || (action.to !== "agy" && action.to !== "claude" && action.to !== "codex") || typeof action.requestID !== "number") return;
          const botId = chat.botId;
          const requestID = action.requestID;
          void client.request({ type: "heads.answerWith", botId, to: action.to })
            .then((result) => {
              const saved: ShellMessage = { botling: "answerWithSaved", botID: botId, requestID, chosen: result.answerWith };
              postToChat(saved);
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
        case "ignoreQuestion":
          if (chat && typeof action.messageID === "string") void client.request({ type: "chat.ignoreQuestion", botId: chat.botId, messageId: action.messageID }).catch(onError);
          return;
        case "answer": {
          // The card answer (a tool approval is one): sent only while the chat plugin is the code the build shipped (card-answer.ts, Q-M7-C5).
          const command = chatAnswerCommand(action, chat?.botId);
          if (command) sendChatAnswer(command, { client, onError });
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
          if (!replyingRef.current && askRef.current) onAskDone?.();
          setReplying(null);
          return;
        case "taskOutput": {
          if (!chat || typeof action.messageID !== "string" || typeof action.taskID !== "string") return;
          const botId = chat.botId, messageId = action.messageID, taskId = action.taskID;
          void client.request({ type: "task.output", botId, messageId, taskId }).then((result) => {
            if (store.getView().chat?.botId !== botId) return;
            const response: ShellMessage = { botling: "taskOutput", botID: botId, messageID: messageId, taskID: taskId, text: result.text };
            frame.current?.contentWindow?.postMessage(response, CHAT_TARGET);
          }).catch(onError);
          return;
        }
        case "cardSend": {
          // A worker card's reply box: the words go to its worker, as "Send a message…" on its row does (the core checks the owner again).
          if (!chat || typeof action.taskID !== "string" || typeof action.text !== "string" || !action.text.trim()) return;
          void client.request({ type: "agent.message", botId: chat.botId, subagentId: action.taskID, text: action.text.slice(0, 64_000) }).catch(onError);
          return;
        }
        case "openSubagent": {
          if (!chat || typeof action.id !== "string") return;
          const botId = chat.botId;
          void client.request({ type: "subagent.view", botId, subagentId: action.id })
            .then((result) => { if (store.getView().chat?.botId === botId) store.watch(result.subagent); })
            .catch(onError);
          return;
        }
        // Components and pins: each becomes a contract command the core checks again (the card, its
        // command, the folder it showed); a frame's calls are paced so one cannot flood the core.
        case "componentCommand":
          runCard(action, chat?.botId ?? null);
          return;
        case "componentDetail": {
          if (!chat || typeof action.requestID !== "number" || typeof action.name !== "string" || typeof action.folder !== "string") return;
          const requestID = action.requestID;
          const reply = (ok: boolean, value: string) => {
            const answer: ShellMessage = { botling: "detailReply", requestID, ok, value };
            postToChat(answer);
          };
          if (!paced(`detail:${action.name}`)) { reply(false, "Too many Detail calls: wait a moment."); return; }
          const values = action.values && typeof action.values === "object" && !Array.isArray(action.values) ? action.values as Record<string, string | number> : {};
          client.request({ type: "component.detail", botId: chat.botId, name: action.name, folder: action.folder, values,
            ...(typeof action.card === "string" ? { card: action.card } : {}), ...(typeof action.command === "string" ? { command: action.command } : {}) })
            .then((result) => reply(result.ok, result.value), (failure) => reply(false, failure instanceof RequestFailed ? failure.error.message : String(failure)));
          return;
        }
        // A card's ⋯ menu: "Report a problem…" or a change asked of Maintainer; main adds the card's screenshot.
        case "componentReport": {
          if (!chat || typeof action.name !== "string" || typeof action.text !== "string" || !paced(`report:${action.name}`)) return;
          const images = Array.isArray(action.images) ? (action.images as unknown[]).flatMap((entry) => {
            const image = entry as { name?: unknown; base64?: unknown };
            return typeof image?.name === "string" && typeof image.base64 === "string" && image.base64 ? [{ name: image.name.slice(0, 255) || "picture.png", base64: image.base64 }] : [];
          }).slice(0, 10) : [];
          const raw = action.rect as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null | undefined;
          const box = (placeholder.current ?? frame.current)?.getBoundingClientRect();
          const rect = raw && box && [raw.x, raw.y, raw.width, raw.height].every((value) => typeof value === "number" && Number.isFinite(value)) && (raw.width as number) > 0 && (raw.height as number) > 0
            ? { x: box.left + (raw.x as number), y: box.top + (raw.y as number), width: Math.min(raw.width as number, 10_000), height: Math.min(raw.height as number, 10_000) } : null;
          void client.request({ type: "component.report", botId: chat.botId, name: action.name.slice(0, 200), text: action.text.slice(0, 20_000), images, rect,
            problem: action.problem === true, ...(typeof action.pinID === "string" ? { pinId: action.pinID } : {}) }).catch(onError);
          return;
        }
        // A link or a component's ccb.open(url): opened as the results list opens it, main checks it is one of this chat's (Phase 5c).
        case "openExternal":
        case "openURL":
        case "revealFile":
          if (chat && typeof action.url === "string" && action.url) void client.request({ type: "link.open", ...(action.type === "openExternal" || message.linkExternal === true ? { external: true } : {}), ...(message.reportPreview === true && action.type === "openURL" ? {preview: true} : {}), ...(action.type === "revealFile" ? { reveal: true } : {}), ...(cardImageOf(action.shown) ? { cardImage: cardImageOf(action.shown)! } : {}), source: message.linkSource === "user" ? "user" : "component", ...(typeof message.linkMessageId === "string" ? {messageId:message.linkMessageId} : {}), ...(typeof message.linkPinId === "string" ? {pinId:message.linkPinId} : {}), botId: chat.botId, url: action.url.slice(0, 8_000) }).then(result => { if (result.previewURL && store.getChatView().chat?.botId === chat.botId) setReport({botId: chat.botId, url: result.previewURL}); }).catch(onError);
          return;
        // A local file's link or picture dragged out of the chat: main checks it is this chat's file and starts an OS file drag.
        case "dragFile":
          if (chat && typeof action.url === "string" && action.url) void client.request({ type: "link.drag", botId: chat.botId, url: action.url.slice(0, 4_000) }).catch(onError);
          return;
        // "Not right" on a reply (developer mode): main adds the chat frame as you saw it.
        case "feedback": {
          if (!chat || typeof action.messageID !== "string" || typeof action.text !== "string" || !paced("feedback")) return;
          const images = Array.isArray(action.images) ? (action.images as unknown[]).flatMap((entry) => {
            const image = entry as { name?: unknown; base64?: unknown };
            return typeof image?.name === "string" && typeof image.base64 === "string" && image.base64 ? [{ name: image.name.slice(0, 255) || "picture.png", base64: image.base64 }] : [];
          }).slice(0, 10) : [];
          const box = (placeholder.current ?? frame.current)?.getBoundingClientRect();
          const rect = box && box.width > 0 && box.height > 0 ? { x: box.left, y: box.top, width: box.width, height: box.height } : null;
          void client.request({ type: "chat.feedback", botId: chat.botId, messageId: action.messageID, text: action.text.slice(0, 20_000), images, rect }).catch(onError);
          return;
        }
        // "Make it a visual report" on a reply: the page's words (with your suggestion) go to this bot as your own line, quoting that reply.
        case "regather": {
          if (!chat || typeof action.messageID !== "string" || typeof action.text !== "string" || !action.text.trim() || !paced("regather")) return;
          const botId = chat.botId;
          void client.request({ type: "chat.send", botId, text: action.text.slice(0, 20_000), replyTo: action.messageID }).then((result) => {
            if (result.stoppedBy) { onError(new Error(`Plugin ${result.stoppedBy} stopped the message.`)); return; }
            onSent();
          }).catch(onError);
          return;
        }
        case "componentRevert":
          if (typeof action.name === "string") void client.request({ type: "component.revert", name: action.name.slice(0, 200) }).catch(onError);
          return;
        case "componentSave":
          if (chat && typeof action.messageID === "string" && typeof action.index === "number" && typeof action.data === "string" && paced(`save:${action.messageID}/${action.index}`)) {
            void client.request({ type: "component.save", botId: chat.botId, messageId: action.messageID, index: action.index, data: action.data }).catch(onError);
          }
          return;
        case "closeSubagent":
          store.watch(null);
          return;
        // Files for the next message: main's picker, a pasted or dropped file the page read, taking one out.
        case "pickFiles":
          if (chat) void client.request({ type: "files.pick", botId: typeof action.botID === "string" ? action.botID : chat.botId }).then(() => composerReply(true)).catch(composerFailure);
          else composerReply(false, "Chat is not ready.");
          return;
        case "addFileData":
          if (chat && typeof action.name === "string" && typeof action.base64 === "string" && action.base64) {
            void client.request({ type: "files.data", botId: typeof action.botID === "string" ? action.botID : chat.botId, name: action.name.slice(0, 255) || "file", base64: action.base64 }).then(() => composerReply(true)).catch(composerFailure);
          } else composerReply(false, "Chat or attachment is not ready.");
          return;
        case "removeFile":
          if (chat && typeof action.id === "string") void client.request({ type: "files.remove", botId: chat.botId, id: action.id }).catch(onError);
          return;
        // Plugins' web parts in the page (`PluginBridge` in 1.x).
        case "pluginLoaded":
          if (typeof action.name === "string") void client.request({ type: "plugins.loaded", name: action.name }).catch(() => {});
          return;
        case "pluginError":
          if (typeof action.name === "string") {
            void client.request({ type: "plugins.failed", name: action.name, message: typeof action.message === "string" ? action.message.slice(0, 4_000) : "" }).catch(() => {});
          }
          return;
        case "pluginNotice":
          if (typeof action.name === "string" && typeof action.text === "string" && action.text.trim() && paced(`notice:${action.name}`)) {
            void client.request({ type: "plugins.notice", name: action.name, text: action.text.slice(0, 4_000) }).catch(() => {});
          }
          return;
        // A plugin command from a key, the / menu or a reply's menu: only one that is offered that way now.
        case "runCommand": {
          const via = action.via === "key" || action.via === "slash" || action.via === "menu" ? action.via : null;
          const menu: PluginMenu | undefined = action.menu === "message/context" || action.menu === "message/preview" ? action.menu : undefined;
          const current = store.getView().plugins;
          if (!via || typeof action.id !== "string" || !offered(current, action.id, via, menu)) return;
          // A reply's menu passes its bot and message; a result page's preview card also which of the reply's cards.
          const args = menu && chat && typeof action.messageID === "string"
            ? [chat.botId, action.messageID.slice(0, 200), ...(menu === "message/preview" && typeof action.preview === "number" && Number.isInteger(action.preview) && action.preview >= 0 && action.preview <= 2 ? [String(action.preview)] : [])]
            : [];
          runPluginCommand(client, current, action.id, args, onError);
          return;
        }
        // A plugin's button beside a link in a message (chat/link): only an entry that is offered now and matches the link; the core
        // checks again, and that the link is in that line, then runs it with { botId, messageId, url, path }.
        case "linkCommand": {
          const current = store.getView().plugins;
          if (!chat || typeof action.id !== "string" || typeof action.messageID !== "string" || typeof action.url !== "string" || !action.url) return;
          if (!chatLinkOffered(current, action.id, action.url)) return;
          void client.request({ type: "plugins.linkCommand", id: action.id, botId: chat.botId, messageId: action.messageID.slice(0, 200), url: action.url.slice(0, 8_000) }).catch(onError);
          return;
        }
        // A web part's command or call: the core takes it only for plugins whose web part runs in the page.
        case "command":
          if (typeof action.id === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(action.id)) void client.request({ type: "plugins.command", id: action.id, from: "chat" }).catch(onError);
          return;
        // A web part's ask to allow a command (the component studio's chips): this page's own ApprovalSheet shows what the core says, and only its Allow allows.
        case "pluginApproval": {
          if (typeof action.plugin !== "string" || typeof action.callID !== "number" || typeof action.botId !== "string" || typeof action.command !== "string" || typeof action.folder !== "string") return;
          const plugin = action.plugin;
          const callID = action.callID;
          const reply = (ok: boolean, value: unknown) => { const message: ShellMessage = { botling: "hostReply", callID, ok, value }; postToChat(message); };
          if (!paced(`approval:${plugin}`)) { reply(false, "Too many calls: wait a moment."); return; }
          const card = typeof action.card === "string" && action.card ? action.card.slice(0, 200) : undefined;
          const detail = typeof action.detail === "string" && action.detail ? action.detail.slice(0, 20_000) : undefined;
          client.request({ type: "plugins.approvalAsk", name: plugin, botId: action.botId.slice(0, 128), command: action.command.slice(0, 20_000), folder: action.folder.slice(0, 4_000), from: "chat", ...(card ? { card } : {}), ...(detail ? { detail } : {}) })
            .then((asked) => {
              const view = asked.needsApproval;
              if (!view) { reply(true, { allowed: true }); return; }
              onAsk(view, { type: "plugins.approve", name: plugin, botId: (action.botId as string).slice(0, 128), command: view.command, folder: view.folder, ...(view.detail ? { detail: view.detail } : {}) }, (allowed) => reply(true, { allowed }));
            }, (failure) => reply(false, failure instanceof RequestFailed ? failure.error.message : String(failure)));
          return;
        }
        // A web part's `ccb.page.openChat` (the Pin area's digest: "DAFAWU waits for you"): the app page shows that bot's chat, as a plugin frame's botling.openChat does.
        case "openChat":
          if (typeof action.botID === "string" && action.botID && action.botID.length <= 200 && paced("openChat")) {
            handlers.current.onOpenChat?.(action.botID, typeof action.messageID === "string" && action.messageID ? action.messageID.slice(0, 200) : undefined);
          }
          return;
        case "hostCall": {
          if (typeof action.plugin !== "string" || typeof action.method !== "string" || typeof action.callID !== "number") return;
          const callID = action.callID;
          const answer = (ok: boolean, value: unknown) => {
            const reply: ShellMessage = { botling: "hostReply", callID, ok, value };
            postToChat(reply);
          };
          if (!paced(`host:${action.plugin}`)) { answer(false, "Too many calls: wait a moment."); return; }
          client.request({ type: "plugins.call", name: action.plugin, method: action.method.slice(0, 200), params: action.params ?? null, from: "chat" })
            .then((result) => answer(true, result.result), (failure) => answer(false, failure instanceof RequestFailed ? failure.error.message : String(failure)));
          return;
        }
        // A built-in plugin's web part (botling.board's pins) asks the user to allow a card's command: the core says what the sheet shows
        // (`plugins.approvalAsk`, never what the page says) and only the sheet's Allow sends `plugins.approve`; the page hears how it ended.
        case "approvalRequest": {
          if (typeof action.plugin !== "string" || typeof action.requestId !== "number" || typeof action.command !== "string" || typeof action.folder !== "string" || typeof action.component !== "string") return;
          const requestId = action.requestId, plugin = action.plugin, command = action.command, component = action.component;
          const botId = typeof action.botId === "string" ? action.botId : chat?.botId;
          const reply = (allowed: boolean) => postToChat({ botling: "approvalReply", requestId, allowed } satisfies ShellMessage);
          if (!botId) { reply(false); return; }
          client.request({ type: "plugins.approvalAsk", name: plugin, botId, command, folder: action.folder, component, ...(typeof action.card === "string" ? { card: action.card.slice(0, 200) } : {}) }).then((asked) => {
            const view = asked.needsApproval;
            if (!view) { reply(true); return; }
            onAsk(view, { type: "plugins.approve", name: plugin, botId, command: view.command, folder: view.folder, component, detail: view.detail }, reply);
          }, (failure) => { reply(false); onError(failure); });
          return;
        }
        default:
          // Drafts, files, reactions, components… are not in 2.0 yet.
          return;
      }
    };
    const bridge = nativeEditor();
    if (bridge) return bridge.subscribe(packet => {
      if ("unbound" in packet) { ready.current = false; lastSpecs.current = ""; channel.reset(); }
      else if ("bound" in packet) { ready.current = true; lastSpecs.current = ""; push(); pushPlugins(); pushTokens(); }
      else if ("snapshot" in packet) setSnapshot(packet.snapshot ? {image:packet.snapshot,revision:packet.revision} : null);
      else receive(packet.message as FrameMessage);
    });
    const onMessage = (event: MessageEvent) => {
      if (frame.current && event.source === frame.current.contentWindow && event.origin === CHAT_ORIGIN) receive(event.data);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [client, push, pushPlugins, pushTokens, store, channel]);

  const viewer = report && report.botId === view.chat?.botId ? <ReportViewer url={report.url} onClose={() => setReport(null)}
    bubble={bubble ? { bot: bubble, look, on: reportChat, onOpen: setReportChat, line: stripLine } : undefined} /> : null;
  if (nativeEditor()) return <>{viewer}<div id="chat-frame" ref={placeholder} aria-label="Chat" style={{ position: "relative", overflow: "hidden" }}>
    {snapshot && <img data-native-chat-snapshot="" src={snapshot.image} onLoad={() => nativeEditor()?.snapshotReady(snapshot.revision)} alt="" aria-hidden="true" style={{ width: "100%", height: "100%", position: "absolute", inset: 0, pointerEvents: "none" }} />}
  </div></>;
  return <>{viewer}<iframe id="chat-frame" ref={frame} src={inputTrace() ? `${CHAT_PAGE}?${TEST_TRACE_QUERY}=1` : CHAT_PAGE} sandbox={CHAT_SANDBOX} allow={CHAT_FRAME_ALLOW} title="Chat" /></>;
}
