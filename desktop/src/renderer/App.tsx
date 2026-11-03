import { BottomPanels, TOGGLE_BOTTOM_PANEL } from "./BottomPanels";
import { ChatHeaderViews } from "./ChatHeaderViews";
import { ownsCommand } from "../../../Web/src/frame-protocol";
// The app page: React chrome around the reused chat page. The left column lists the bots (as the
// Swift app's sidebar); the chat area hosts Web/src's chat page in a same-origin frame
// (chat-frame/), fed with the state ChatPayload.swift would build (payload.ts). The frame posts
// what the user does (send, a pick on an approval, Stop); this page turns that into contract
// commands. Only this page has the bridge to main.
import { inputTrace } from "./input-trace";
import { ReportViewer } from "./ReportViewer";
import { ShellOverlay } from "./ShellOverlay";
import { nativeEditor, postToChat, observeEditorLayout } from "./editor-surface";
import { TEST_TRACE_QUERY } from "../test-trace";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { status, statusText } from "../contract/bot-status";
import { actionForEvent, bindingsFor, commandBindings, commandForEvent, formatCombo } from "../contract/shortcuts";
import { setShortcutLabels, shellPlatform, shortcutLabel } from "./shortcut-labels";
import { MAINTAINER_BOT_ID, resultLinks, type ApprovalAskView, type BotView, type PluginsView, type ResultView, type SubagentRowView } from "../contract";
import { Client, RequestFailed } from "./client";
import { WorkspaceStore } from "./store";
import { chatState, subagentState } from "./payload";
import { commandRoute, keybindingsOf, menuItems, offered, type PluginMenu } from "./plugin-commands";
import { ChatStateChannel } from "./chat-state-channel";
import { faceURL } from "./avatars";
import { CHAT_ORIGIN, CHAT_PAGE, CHAT_SANDBOX, CHAT_TARGET, type FrameMessage, type ShellMessage } from "./chat-frame/protocol";
import { MainTabFrame, PanelFrame, PluginsButton, SlotFrame, type BuiltinRunner } from "./Plugins";
import { TakeoverPage } from "./TakeoverPage";
import { boardOffered, mainTabsFor, namedBot, rightPanelSectionsFor, shownTab, tabKey, WHITEBOARD_PLUGIN, type MainTab } from "./main-tabs";
import { UpdateEntry } from "./UpdateEntry";
import { BotSettings, SettingsSheet, type SettingsSection } from "./Settings";
import { SidebarSettings } from "./SidebarSettings";
import { TaskDetails } from "./TaskDetails";
import { botCounts, canIdle, idleCounts, idleList, peekCard, railOrder, railSplit } from "./rail-idle";
import { peekHover } from "./peek-hover";
import { AgentMenu, BotMenu, CloseSubBotDialog, NewBotForm, PeekCard, RemoveDialog, StripPeek, SubBotMenu, subBotsOf, useMinuteClock, type AgentMoveTo, type AgentTargets } from "./Rail";
import { Icon, isIconName } from "./icons";
import { useApprovalSheet } from "./ApprovalSheet";
import { asksUser, cardApprove, cardRun } from "./card-approval";

/** What Botling Web (desktop/mobile/) puts in the same chrome: a control at the start of the chat's
 * header (the phone's bot list button) and the left column's foot in place of the desktop's add,
 * plugin and settings controls, which the web has no commands for. The desktop passes neither. */
export interface WebChrome { headerLead?: ReactNode; railFooter: ReactNode }

/** The main view of the main bot: the whiteboard tab unless you last picked Chat or Board (kept for the next start). */
const CHOICE_KEY = "botling.mainWhiteboard";
function useWhiteboardChoice(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => { try { return localStorage.getItem(CHOICE_KEY) !== "0"; } catch { return true; } });
  const choose = useCallback((next: boolean) => {
    setOn(next);
    try { localStorage.setItem(CHOICE_KEY, next ? "1" : "0"); } catch { /* no storage: this session only */ }
  }, []);
  return [on, choose];
}

export function App({ client, store, web }: { client: Client; store: WorkspaceStore; web?: WebChrome }) {
  const view = useSyncExternalStore(store.subscribe, store.getView);
  const [error, setError] = useState<string | null>(null);
  const [bottomControls, setBottomControls] = useState<HTMLSpanElement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const openSettings = useCallback((section: SettingsSection = "general") => { setSettingsSection(section); setSettingsOpen(true); }, []);
  /** The New bot form, a row's menu, and the bot being asked about before it is removed. */
  const [makingBot, setMakingBot] = useState(false);
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState<{ bot: BotView; x: number; y: number } | null>(null);
  /** A subagent row's "⋯" menu: the bot whose row it is, the row, and where it opens. */
  const [agentMenu, setAgentMenu] = useState<{ botId: string; row: SubagentRowView; x: number; y: number } | null>(null);
  const [removing, setRemoving] = useState<BotView | null>(null);
  /** A sub bot row's "⋯" menu, the sub bot being asked about before it is closed, and the worker rows picked for one new sub bot. */
  const [subBotMenu, setSubBotMenu] = useState<{ botId: string; x: number; y: number } | null>(null);
  const [closingSubBot, setClosingSubBot] = useState<BotView | null>(null);
  const [picking, setPicking] = useState<{ botId: string; ids: string[] } | null>(null);
  /** The task card pressed open in the right panel (`selectedTask`); pressed again, it closes. */
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const selectTask = useCallback((id: string) => setSelectedTask((current) => (current === id ? null : id)), []);
  const now = useMinuteClock();
  /** The main bot's main view: its chat, or the whiteboard plugin's tab (kept for the next start). */
  const [whiteboardOn, setWhiteboardOn] = useWhiteboardChoice();
  const collapsed = view.settings?.rightPanelCollapsed ?? false;
  const toggleRight = useCallback(() => {
    void client.request({ type: "settings.set", change: { key: "rightPanelCollapsed", value: !(store.getView().settings?.rightPanelCollapsed ?? false) } }).catch(() => {});
  }, [client, store]);
  // The left column: folded into a strip of faces (⌃⌘S), its search (⌘K) and the pinned bots (1.x's RailView).
  const railCollapsed = view.settings?.railCollapsed ?? false;
  const toggleRail = useCallback((collapse?: boolean) => {
    const next = collapse ?? !(store.getView().settings?.railCollapsed ?? false);
    void client.request({ type: "settings.set", change: { key: "railCollapsed", value: next } }).catch(() => {});
  }, [client, store]);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const startSearch = useCallback(() => {
    if (store.getView().settings?.railCollapsed) toggleRail(false);
    // After the open column (and its field) is drawn.
    setTimeout(() => search.current?.focus(), 50);
  }, [store, toggleRail]);
  const pinned = useMemo(() => {
    const ids = view.settings?.pinnedBots ?? [];
    return ids.filter((id) => view.bots.some((candidate) => candidate.id === id && candidate.role !== "main" && candidate.id !== MAINTAINER_BOT_ID));
  }, [view.settings?.pinnedBots, view.bots]);
  const togglePin = useCallback((botId: string) => {
    const now = (store.getView().settings?.pinnedBots ?? []).filter((id) => store.getView().bots.some((candidate) => candidate.id === id));
    const next = now.includes(botId) ? now.filter((id) => id !== botId) : [...now, botId];
    void client.request({ type: "settings.set", change: { key: "pinnedBots", value: next } }).catch(() => {});
  }, [client, store]);
  // Idle (the left column's bottom group): only the user sends a bot there, with the clock on its row; the back arrow brings it back.
  const idle = view.settings?.idleBots ?? [];
  const [idleOpen, setIdleOpen] = useState(false);
  const setIdle = useCallback((botId: string, away: boolean) => {
    const now = (store.getView().settings?.idleBots ?? []).filter((id) => store.getView().bots.some((candidate) => candidate.id === id));
    void client.request({ type: "settings.set", change: { key: "idleBots", value: idleList(now, botId, away) } }).catch(() => {});
  }, [client, store]);
  /**
   * The status card beside a bot row (PeekCard): the bot, where its row is, and whether the focus goes into it.
   * It opens on hover (peek-hover.ts: after a short delay, kept while the pointer crosses into it), on keyboard focus,
   * or, where nothing hovers (touch), on a tap. A click on a row only opens the chat.
   */
  const [peek, setPeek] = useState<{ botId: string; top: number; right: number; keyboard: boolean } | null>(null);
  const peekInto = useRef(false);
  const peeking = useMemo(() => peekHover({
    onOpen: (botId, anchor) => { const keyboard = peekInto.current; peekInto.current = false; setPeek({ botId, ...anchor, keyboard }); },
    onClose: () => setPeek(null),
  }), []);
  useEffect(() => () => peeking.dispose(), [peeking]);
  // Focus put back on a row by Escape does not open its card again.
  const peekQuiet = useRef(false);
  const closePeek = useCallback((refocus: boolean) => {
    const botId = peeking.shown();
    peeking.close();
    if (botId && refocus) {
      peekQuiet.current = true;
      document.querySelector<HTMLElement>(`.rail .bot-row[data-bot="${botId}"]`)?.focus();
      peekQuiet.current = false;
    }
  }, [peeking]);
  // The app's keys (Settings > Shortcuts): ⌘, Settings, ⌃⌘I the right panel, ⌃⌘S the left column, ⌘K its search, by default.
  const shortcutBindings = useMemo(() => setShortcutLabels(view.settings?.shortcuts), [view.settings?.shortcuts]);
  // Plugin commands' keys (plugin-platform.md §3.3), after the app's: the same table the chat page relays.
  const pluginKeys = useMemo(() => commandBindings(keybindingsOf(view.plugins), view.settings?.shortcuts), [view.plugins, view.settings?.shortcuts]);
  const runCommand = useCallback((id: string, args: string[] = [], caller?: { from: "frame"; name: string }) => {
    runPluginCommand(client, store.getView().plugins, id, args, (failure) => setError(failure instanceof RequestFailed ? failure.error.message : String((failure as Error)?.message ?? failure)), caller);
  }, [client, store]);
  // A key a panel's frame did not use (a modifier held): runs Botling's shortcuts or that plugin's own bound command (never another plugin's, and never a synthetic window keydown).
  const forwardKey = useCallback((plugin: string, key: { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }) => {
    switch (actionForEvent(key, shortcutBindings)) {
      case "settings": openSettings(); break;
      case "toggleRightPanel": toggleRight(); break;
      case "toggleSidebar": toggleRail(); break;
      case "search": startSearch(); break;
      case null: {
        const command = commandForEvent(key, pluginKeys);
        if (command) runCommand(command, [], { from: "frame", name: plugin });
        break;
      }
    }
  }, [openSettings, toggleRight, toggleRail, startSearch, shortcutBindings, pluginKeys, runCommand]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      switch (actionForEvent(event, shortcutBindings)) {
        case "settings": event.preventDefault(); openSettings(); break;
        case "toggleRightPanel": event.preventDefault(); toggleRight(); break;
        case "toggleSidebar": event.preventDefault(); toggleRail(); break;
        case "search": event.preventDefault(); startSearch(); break;
        case null: {
          const command = event.defaultPrevented ? null : commandForEvent(event, pluginKeys);
          if (command) { event.preventDefault(); runCommand(command); }
          break;
        }
      }
    };
    const onCommand = (event: Event) => {
      switch ((event as CustomEvent).detail) {
        case "settings": openSettings(); break;
        case "rightPanel": toggleRight(); break;
        case "sidebar": toggleRail(); break;
        case "search": startSearch(); break;
      }
    };
    window.addEventListener("botling:chat-command", onCommand);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("botling:chat-command", onCommand); };
  }, [openSettings, toggleRight, toggleRail, startSearch, shortcutBindings, pluginKeys, runCommand]);
  const chat = view.chat;
  const results = useMemo<ResultView[]>(() => (chat ? resultLinks(chat.messages) : []), [chat]);
  const watching = view.subagent?.id ?? null;
  const bot = useMemo(() => view.bots.find((candidate) => candidate.id === chat?.botId) ?? null, [view.bots, chat?.botId]);
  // A plugin's page that a program part opened in the right panel's place (`ui.takeover`), while that bot's chat is shown.
  const takeover = !web && !watching && bot && view.plugins?.takeover?.botId === bot.id ? view.plugins.takeover : null;
  const takeoverView = takeover ? view.plugins?.takeovers?.find((entry) => entry.plugin === takeover.plugin && entry.id === takeover.view) ?? null : null;
  // A plugin's tab in the main area (plan W2), the one this bot showed last; it takes the whiteboard's place too.
  const tabs = useMemo(() => (bot && !web ? mainTabsFor(view.plugins, bot) : []), [bot, web, view.plugins]);
  // botling.whiteboard's tab; with that plugin off there is no whiteboard.
  const boardTab = bot?.role === "main" ? tabs.find((candidate) => candidate.plugin === WHITEBOARD_PLUGIN) ?? null : null;
  const remembered = bot && !watching ? shownTab(tabs, view.settings?.mainTabs?.[bot.id]) : null;
  // The main bot opens on the whiteboard unless you last picked Chat or Board: the choice is kept for the next start.
  const tab = remembered ?? (boardTab && whiteboardOn && !watching ? boardTab : null);

  const fail = useCallback((failure: unknown) => {
    setError(failure instanceof RequestFailed ? failure.error.message : String((failure as Error)?.message ?? failure));
  }, []);
  // A card's command waiting for your OK (from the chat page or a plugin's right panel): this page's own sheet asks.
  const approval = useApprovalSheet(client, view.settings?.effectiveLanguage ?? null, fail);

  /** A bot's chat again. */
  const selectBot = useCallback((botId: string) => {
    setError(null);
    void store.select(botId);
  }, [client, store]);

  // "Add project": main's folder picker; the new (or existing) project's chat is shown.
  const addProject = useCallback(() => {
    setError(null);
    void client.request({ type: "projects.pick" }).then((result) => { if (result.botId) void store.select(result.botId); }, fail);
  }, [client, store, fail]);

  // A subagent's row (left column or Settled): its conversation in the chat's place (its bot's chat first).
  const openSubagent = useCallback((botId: string, row: Pick<SubagentRowView, "id" | "subBot">) => {
    setError(null);
    // A sub bot is a bot of its own: its chat opens, with the input box (a subagent's view is read-only).
    const target = rowTarget(row);
    if (target.kind === "bot") { void store.select(target.botId); return; }
    const show = () => client.request({ type: "subagent.view", botId, subagentId: row.id })
      .then((result) => { if (store.getView().chat?.botId === botId) store.watch(result.subagent); }, fail);
    if (store.getView().chat?.botId === botId) void show();
    else void store.select(botId).then(show);
  }, [client, store, fail]);
  const settleSubagent = useCallback((botId: string, row: SubagentRowView, settled: boolean) => {
    void client.request({ type: "subagent.settle", botId, subagentId: row.id, settled }).catch(fail);
  }, [client, fail]);
  // "Move to…": it keeps running where it is; its row and reports go to the other bot (the chats say so).
  const moveSubagent = useCallback((botId: string, row: SubagentRowView, to: AgentMoveTo) => {
    setAgentMenu(null);
    setError(null);
    void client.request({ type: "agent.move", botId, subagentId: row.id, to }).catch(fail);
  }, [client, fail]);
  const openAgentMenu = useCallback((botId: string, row: SubagentRowView, at: { x: number; y: number }) => setAgentMenu({ botId, row, ...at }), []);
  // Its owner's follow-up and stop: through its host, whatever engine runs it (the chat says what happened).
  const messageSubagent = useCallback((botId: string, row: SubagentRowView, text: string) => {
    setAgentMenu(null);
    setError(null);
    void client.request({ type: "agent.message", botId, subagentId: row.id, text: text.slice(0, 64_000) }).catch(fail);
  }, [client, fail]);
  const stopSubagent = useCallback((botId: string, row: SubagentRowView) => {
    setAgentMenu(null);
    setError(null);
    void client.request({ type: "agent.stop", botId, subagentId: row.id }).catch(fail);
  }, [client, fail]);
  const togglePick = useCallback((botId: string, row: SubagentRowView) => setPicking((current) => {
    if (!current || current.botId !== botId) return { botId, ids: [row.id] };
    return { botId, ids: current.ids.includes(row.id) ? current.ids.filter((id) => id !== row.id) : [...current.ids, row.id].slice(0, 20) };
  }), []);
  const groupSubagents = useCallback((botId: string, name: string) => {
    const ids = picking?.botId === botId ? picking.ids : [];
    if (!ids.length) return;
    setPicking(null);
    setError(null);
    void client.request({ type: "agent.group", botId, subagentIds: ids, name: name.slice(0, 400) })
      .then((result) => { void store.select(result.ownerBotId); }, fail);
  }, [client, store, fail, picking]);
  // "Close sub bot": its agents go back to their host; then its project bot's chat is shown again.
  const closeSubBot = useCallback((target: BotView) => {
    setClosingSubBot(null);
    setError(null);
    const shown = store.getView().chat?.botId === target.id;
    void client.request({ type: "subbot.close", botId: target.id })
      .then((result) => { if (shown || store.getView().chat?.botId === target.id) void store.select(result.parentBotId); }, fail);
  }, [client, store, fail]);

  // "New bot": made, set up (it writes its routines and says hello), and shown.
  const createBot = useCallback((made: { name: string; job: string } | null) => {
    if (!made) { setMakingBot(false); return; }
    setError(null);
    setCreating(true);
    void client.request({ type: "bots.create", name: made.name.slice(0, 400), job: made.job.slice(0, 4_000) })
      .then((result) => { setMakingBot(false); void store.select(result.botId); }, fail)
      .finally(() => setCreating(false));
  }, [client, store, fail]);
  const removeBot = useCallback((target: BotView) => {
    setRemoving(null);
    setError(null);
    void client.request({ type: "bots.remove", botId: target.id }).catch(fail);
  }, [client, fail]);

  /** Shows a plugin tab for a bot, or none (Chat or Board), and keeps it for next time. */
  const chooseTab = useCallback((botId: string, next: MainTab | null) => {
    const key = next ? tabKey(next) : null;
    if ((store.getView().settings?.mainTabs?.[botId] ?? null) === key) return;
    void client.request({ type: "settings.set", change: { key: "mainTab", value: { botId, tab: key } } }).catch(fail);
  }, [client, store, fail]);
  // Botling's own commands a plugin frame may run: a bot's chat (its Chat tab), one of a bot's results.
  const runBuiltin = useCallback<BuiltinRunner>((_plugin, command) => {
    const botId = namedBot(store.getView().bots, command.botId);
    if (!botId) { setError(`No bot "${command.botId.slice(0, 80)}".`); return; }
    if (command.id === "botling.openResult") {
      void client.request({ type: "result.open", botId, url: command.url }).catch(fail);
      return;
    }
    if (command.id === "botling.openLink") {
      void client.request({ type: "link.open", source: "user", botId, url: command.url }).catch(fail);
      return;
    }
    if (command.id === "botling.openTab") {
      const tab = mainTabsFor(store.getView().plugins, { role: store.getView().bots.find((candidate) => candidate.id === botId)?.role ?? "bot", parent: store.getView().bots.find((candidate) => candidate.id === botId)?.parent })
        .find((candidate) => candidate.plugin === command.plugin && candidate.id === command.view);
      if (!tab) { fail(new Error(`No tab "${command.view.slice(0, 80)}".`)); return; }
      selectBot(botId);
      chooseTab(botId, tab);
      return;
    }
    const shown = store.getView().chat?.botId;
    if (shown) chooseTab(shown, null);
    chooseTab(botId, null);
    setWhiteboardOn(false);
    selectBot(botId);
  }, [client, store, fail, chooseTab, setWhiteboardOn, selectBot]);

  // A result opens in the browser or with its own app; main checks it is one of this chat's links.
  const openResult = useCallback((result: ResultView) => {
    if (!chat) return;
    setError(null);
    void client.request({ type: "result.open", botId: chat.botId, url: result.url }).catch(fail);
  }, [client, chat, fail]);

  useEffect(() => { setSelectedTask(null); }, [chat?.botId]);
  // The bot's settings, one level in in the right panel (1.x's DetailPanel `showingSettings`); a new bot shows its overview.
  const [botSettings, setBotSettings] = useState(false);
  useEffect(() => { setBotSettings(false); }, [bot?.id]);
  const openBotSettings = useCallback(() => { if (collapsed) toggleRight(); setBotSettings(true); }, [collapsed, toggleRight]);

  // Reading a chat clears its unread count.
  useEffect(() => {
    if (bot && bot.unread > 0) void client.request({ type: "chat.read", botId: bot.id }).catch(() => {});
  }, [client, bot]);

  return (
    <div className="shell" data-ready={view.ready ? "1" : "0"}>
      {/* A panel a plugin's program part opened (`ui.openView`). */}
      {!web && view.pluginPanel && (
        <PanelFrame key={`${view.pluginPanel.plugin}/${view.pluginPanel.panel}`} client={client} plugin={view.pluginPanel.plugin} panel={view.pluginPanel.panel}
          title={view.pluginPanel.title} onClose={() => store.closePluginPanel()} onBuiltin={runBuiltin} components={view.components} bots={view.bots} ask={approval.ask} />
      )}
      {railCollapsed ? (
        <RailStrip bots={view.bots} pinned={pinned} look={view.settings?.botLook ?? "original"} shown={!watching ? chat?.botId ?? null : null}
          waiting={(id) => view.waiting.items.some((item) => item.botId === id)}
          onSelect={selectBot} onMenu={(candidate, x, y) => setMenu({ bot: candidate, x, y })}
          onExpand={() => toggleRail(false)} onAddProject={addProject} onNewBot={() => { toggleRail(false); setMakingBot(true); }}
          settingsControl={web ? null : <SidebarSettings compact client={client} settings={view.settings} plugins={view.plugins} doctor={view.doctor} settingsOpen={settingsOpen} onOpen={openSettings} />} />
      ) : (
      <aside className="rail">
        <div className="rail-top drag"><RailToggle collapsed={false} onToggle={() => toggleRail(true)} /></div>
        <div className="rail-search">
          <Icon name="search" size={13} className="rail-search-icon" />
          <input ref={search} type="search" placeholder="Search" aria-label="Search bots" value={query} onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.preventDefault(); setQuery(""); search.current?.blur(); focusComposer(); }
              if (event.key === "Enter") { const first = searchHits(view.bots, pinned, query)[0]; if (first) { selectBot(first.id); setQuery(""); focusComposer(); } }
            }} />
          {!query && <span className="rail-search-key" aria-hidden="true">{shortcutLabel("search")}</span>}
        </div>
        <nav className="bots" aria-label="Bots">
          {query.trim() ? (() => {
            const hits = searchHits(view.bots, pinned, query);
            if (!hits.length) return <div className="rail-empty">No bots match</div>;
            return hits.map((candidate) => (
              <div key={candidate.id} className="bot-entry">
                  <BotRow bot={candidate} look={view.settings?.botLook ?? "original"} selected={candidate.id === chat?.botId && !watching}
                    waiting={view.waiting.items.some((item) => item.botId === candidate.id)}
                    counts={botCounts(candidate, view.bots, view.waiting, candidate.id === chat?.botId && !watching)}
                    onSelect={() => { selectBot(candidate.id); setQuery(""); focusComposer(); }} />
              </div>
            ));
          })() : (
            <>
              {(() => {
                const look = view.settings?.botLook ?? "original";
                const split = railSplit(view.bots, pinned, idle);
                const shownId = !watching ? chat?.botId ?? null : null;
                const hasPeek = (candidate: BotView) => { const card = peekCard(candidate, view.bots, view.waiting, now); return card.subBots.length > 0 || card.agents.length > 0; };
                const row = (candidate: BotView, away: boolean) => {
                  const counts = botCounts(candidate, view.bots, view.waiting, candidate.id === shownId);
                  return (
                    <BotRow
                      bot={candidate}
                      look={look}
                      selected={candidate.id === chat?.botId && !watching}
                      waiting={view.waiting.items.some((item) => item.botId === candidate.id)}
                      counts={counts}
                      onSelect={(from) => {
                        selectBot(candidate.id);
                        // A click only opens the chat. Enter on a focused row also takes the focus into its card; a tap
                        // where nothing hovers opens the card (the hover's stand-in).
                        if (!from || !hasPeek(candidate)) return;
                        if (from.keyboard) {
                          if (peeking.shown() === candidate.id) setPeek((current) => (current ? { ...current, keyboard: true } : current));
                          else { peekInto.current = true; peeking.openNow(candidate.id, anchorOf(from.el)); }
                        } else if (!canHover()) peeking.openNow(candidate.id, anchorOf(from.el));
                      }}
                      peek={{
                        enter: (el) => { if (hasPeek(candidate)) peeking.enterRow(candidate.id, () => anchorOf(el)); else peeking.leaveRow(); },
                        leave: () => peeking.leaveRow(),
                        focus: (el) => { if (!peekQuiet.current && hasPeek(candidate)) peeking.openNow(candidate.id, anchorOf(el)); },
                      }}
                      pinned={!away && canIdle(candidate) ? pinned.includes(candidate.id) : undefined}
                      onTogglePin={() => togglePin(candidate.id)}
                      idle={canIdle(candidate) ? { away, onToggle: () => { setIdle(candidate.id, !away); peeking.close(); } } : undefined}
                      onMenu={candidate.role !== "main" && candidate.id !== MAINTAINER_BOT_ID ? (x, y) => setMenu({ bot: candidate, x, y }) : undefined}
                    />
                  );
                };
                const idleNumbers = idleCounts(split.idle, view.bots, view.waiting);
                return <>
                  {split.rows.map(({ bot: candidate, section }) => (
                    <div key={candidate.id} className="bot-entry">
                      {section === "pinned" && <h4 className="rail-section">Pinned</h4>}
                      {section === "rest" && split.rows.some((entry) => entry.section === "pinned") && <div className="rail-rule" />}
                      {row(candidate, false)}
                    </div>
                  ))}
                  {split.idle.length > 0 && <div className="rail-idle">
                    <button type="button" className="rail-idle-row" aria-expanded={idleOpen} onClick={() => setIdleOpen(!idleOpen)}
                      aria-label={`Idle, ${idleNumbers.bots} bot${idleNumbers.bots === 1 ? "" : "s"}${idleNumbers.needsYou ? `, ${idleNumbers.needsYou} waiting on you` : ""}`}>
                      <span className={`rail-idle-chevron${idleOpen ? " open" : ""}`} aria-hidden="true"><Icon name="chevronLeft" size={11} /></span>
                      <span>Idle</span>
                      <span className="bot-gap" />
                      {idleNumbers.needsYou > 0 && <span className="badge waiting" aria-hidden="true">{idleNumbers.needsYou}</span>}
                      <span className="rail-idle-count">{idleNumbers.bots} bot{idleNumbers.bots === 1 ? "" : "s"}</span>
                    </button>
                    {idleOpen && split.idle.map((candidate) => <div key={candidate.id} className="bot-entry">{row(candidate, true)}</div>)}
                  </div>}
                </>;
              })()}
            </>
          )}
        </nav>
        {peek && !query.trim() && (() => {
          const target = view.bots.find((candidate) => candidate.id === peek.botId);
          return target ? <PeekCard key={target.id} bot={target} card={peekCard(target, view.bots, view.waiting, now)} anchor={{ top: peek.top, right: peek.right }} now={now} focusFirst={peek.keyboard}
            onOpenChat={(botId) => { peeking.close(); selectBot(botId); }}
            onOpenAgent={(botId, agentRow) => { peeking.close(); openSubagent(botId, agentRow); }}
            onPointerIn={() => peeking.enterCard()} onPointerOut={() => peeking.leaveCard()}
            onSubBotMenu={(subBotId, at) => setSubBotMenu({ botId: subBotId, ...at })}
            onClose={closePeek} /> : null;
        })()}
        {web ? <div className="rail-settings web-rail-footer">{web.railFooter}</div> : <>
        {makingBot && <NewBotForm onDone={createBot} busy={creating} />}
        <div className="rail-add">
          <button type="button" className="rail-button" onClick={addProject}><Icon name="plus" size={13} />Add project</button>
          <button type="button" className={`rail-button new-bot-button${makingBot ? " on" : ""}`} onClick={() => setMakingBot(!makingBot)}
            title="A bot of its own, with its own memory and routines (a morning news bot, say)"><Icon name="sparkles" size={13} />New bot</button>
        </div>
        <UpdateEntry client={client} />
        <PluginsButton client={client} plugins={view.plugins} onAsked={() => { void store.select(MAINTAINER_BOT_ID); }} />
        <div className="rail-settings">
          <SidebarSettings client={client} settings={view.settings} plugins={view.plugins} doctor={view.doctor} settingsOpen={settingsOpen} onOpen={openSettings} />
        </div>
        </>}
      </aside>
      )}
      <section className="chat-pane">
        <div className={`chat-column${tab ? " main-tab-on" : ""}`}>
        <header className="chat-header drag">
          {web?.headerLead}
          {bot && <span className="chat-title">{bot.parent ? <SubBotTitle bot={bot} parent={view.bots.find((candidate) => candidate.id === bot.parent) ?? null} onOpenParent={selectBot} /> : bot.name}</span>}
          {bot && bot.heads.length > 0 && (
            <span className="chat-heads" data-heads={bot.heads.join(" ")}>{bot.heads.map((head) => ({ claude: "Claude", codex: "Codex", agy: "Antigravity" }[head])).join(" & ")}</span>
          )}
          {bot && <span className="chat-status" data-status={status(bot)}>{statusText(bot)}</span>}
          {!web && <span className="bottom-controls" ref={setBottomControls} />}
          {bot && chat && !web && (
            <span className="chat-actions">
              <ChatHeaderViews client={client} views={view.plugins?.chatHeaderViews ?? []} botId={bot.id} onBuiltin={runBuiltin} components={view.components} bots={view.bots} ask={approval.ask} />
            </span>
          )}
        </header>
        {bot && chat && !watching && (
          // 1.x's BoardSwitch: its own centered bar above the messages, even with no pins.
          <div className="board-switch-bar">
            <div className="board-switch" role="group" aria-label="Chat views">
              <button type="button" aria-pressed={!(view.board && boardOffered(view.plugins)) && !tab} onClick={() => { setWhiteboardOn(false); chooseTab(bot.id, null); store.showBoard(false); }}><Icon name="bubble" size={13} />Chat</button>
              {boardOffered(view.plugins) && <button type="button" aria-pressed={view.board && !tab} onClick={() => { setWhiteboardOn(false); chooseTab(bot.id, null); store.showBoard(true); }}><Icon name="grid" size={13} />Board</button>}
              {tabs.map((candidate) => (
                <button key={tabKey(candidate)} type="button" className={`main-tab-switch${candidate === boardTab ? " whiteboard-switch" : ""}`} data-tab={tabKey(candidate)} aria-pressed={tab === candidate}
                  onClick={() => { setWhiteboardOn(candidate === boardTab); chooseTab(bot.id, candidate); }}>
                  {candidate.icon && isIconName(candidate.icon) && <Icon name={candidate.icon} size={13} />}{candidate.title}
                </button>
              ))}
            </div>
          </div>
        )}
        {view.coreSwap && <div className="core-swap" role="status" data-phase={view.coreSwap}>{view.coreSwap === "draining" ? "Updating Botling's core: finishing replies under way…" : "Updating Botling's core…"}</div>}
        {bot?.problem && <div className="banner" role="alert">{bot.problem}</div>}
        {bot && chat?.heads?.rounds && (
          // The rounds line over the input box (1.x: "Review round 1 of 2 · Stop now"). The chat page
          // in this checkout gets the same data (`rounds`, `handoffs`) but does not draw it.
          <div className="rounds-bar" role="status">
            <span>{chat.heads.rounds.text}</span>
            <button type="button" onClick={() => void client.request({ type: "rounds.stop", botId: bot.id }).catch(fail)}>Stop now</button>
          </div>
        )}
        {tab && bot && <MainTabFrame key={`${bot.id}/${tabKey(tab)}`} client={client} plugin={tab.plugin} view={tab.id} title={tab.title} botId={bot.id} onBuiltin={runBuiltin} components={view.components} bots={view.bots} ask={approval.ask} />}
        {/* Under a plugin's tab the chat page stays loaded (hidden), so going back to Chat is instant. */}
        <ChatFrame client={client} store={store} onError={fail} onSent={() => setError(null)} onSelectTask={selectTask} onAsk={approval.ask} />
        {!web && <BottomPanels client={client} panels={view.plugins?.bottomPanels ?? []} toggleHost={bottomControls} onHide={focusComposer} botId={bot?.id} botIds={view.bots.map(b => b.id)}
          shortcutFor={(command) => (command && pluginKeys[command] ? formatCombo(pluginKeys[command]!, shellPlatform()) : "")} onBuiltin={runBuiltin} onKey={forwardKey} components={view.components} bots={view.bots} ask={approval.ask} />}
        </div>
        {error && error !== bot?.problem && <div className="banner bottom" role="alert">{error}</div>}
      </section>
      {bot && takeover && takeoverView && (
        <TakeoverPage key={`${takeover.plugin}/${takeover.view}/${bot.id}`} client={client} plugin={takeover.plugin} view={takeover.view} title={takeoverView.title} wide={takeover.wide} botId={bot.id}
          plugins={view.plugins} onError={fail} onAsk={approval.ask} />
      )}
      {bot && !(takeover && takeoverView) && (
        <TaskDetails
          onDrawerSettings={() => setBotSettings(true)}
          bot={bot} bots={view.bots} waiting={view.waiting} look={view.settings?.botLook ?? "original"}
          status={{ key: status(bot), text: statusText(bot) }}
          results={results} watching={watching} collapsed={collapsed}
          tasks={chat?.botId === bot.id ? chat.tasks ?? [] : []} messages={chat?.botId === bot.id ? chat.messages : []}
          summarized={chat?.botId === bot.id ? new Set((chat.decorations ?? []).flatMap((decoration) => decoration.fold ?? [])) : undefined}
          selectedTask={selectedTask} onSelectTask={selectTask}
          onCompleteTask={(taskId) => void client.request({ type: "task.complete", botId: bot.id, taskId }).catch(fail)}
          onJumpToTask={(messageId, taskId) => {
            const message: ShellMessage = { botling: "jumpToTask", messageID: messageId, taskID: taskId };
            postToChat(message);
          }}
          onAskForReport={(task, replyTo) => {
            // "Ask it to report" (`askForReport`): a short message of yours to the task's owner, on the task's card.
            const two = bot.heads.length > 1;
            void client.request({ type: "chat.send", botId: bot.id, text: `How is "${task.name}" going? Please report where it stands.`,
              ...(replyTo ? { replyTo } : {}), ...(two && task.owner ? { to: task.owner } : {}) }).catch(fail);
          }}
          onSelect={selectBot}
          onIgnore={(item) => void client.request(item.messageId ? { type: "chat.ignoreQuestion", botId: item.botId, messageId: item.messageId } : { type: "waiting.ignore", botId: item.botId, text: item.text }).catch(fail)}
          onOpenResult={openResult}
          onOpenSubagent={(row) => openSubagent(bot.id, row)}
          onUnsettle={(row) => settleSubagent(bot.id, row, false)}
          onAgentMenu={(row, at) => openAgentMenu(bot.id, row, at)}
          onSettings={openBotSettings}
          showingSettings={botSettings}
          settingsPage={botSettings ? <BotSettings client={client} bot={bot} /> : undefined}
          pluginSections={rightPanelSectionsFor(view.plugins, bot).map((block) => <SlotFrame key={`${bot.id}/${block.plugin}/${block.id}`} client={client} plugin={block.plugin} view={block.id} title={block.title} fontSize={13} botId={bot.id} onBuiltin={runBuiltin} />)}
          onCloseSettings={() => setBotSettings(false)}
          onExpand={toggleRight}
        />
      )}
      {menu && <BotMenu bot={menu.bot} at={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)}
        onRemove={() => { setRemoving(menu.bot); setMenu(null); }}
        pinned={pinned.includes(menu.bot.id)} onTogglePin={() => { togglePin(menu.bot.id); setMenu(null); }}
        lang={view.settings?.effectiveLanguage ?? null} onRestart={() => { const target = menu.bot; setMenu(null); setError(null); void client.request({ type: "bot.restart", botId: target.id }).catch(fail); }}
        commands={menuItems(view.plugins, "bot/context")} onCommand={(id) => { const target = menu.bot; setMenu(null); runCommand(id, [target.id]); }} />}
      {agentMenu && <AgentMenu row={agentMenu.row} at={{ x: agentMenu.x, y: agentMenu.y }} onClose={() => setAgentMenu(null)}
        load={() => client.request({ type: "agent.targets", botId: agentMenu.botId, subagentId: agentMenu.row.id }) as Promise<AgentTargets>}
        onMove={(to) => moveSubagent(agentMenu.botId, agentMenu.row, to)}
        onMessage={(text) => messageSubagent(agentMenu.botId, agentMenu.row, text)}
        onStop={() => stopSubagent(agentMenu.botId, agentMenu.row)}
        onSelectSeveral={() => { setPicking({ botId: agentMenu.botId, ids: [agentMenu.row.id] }); setAgentMenu(null); }} />}
      {subBotMenu && (() => { const target = view.bots.find((candidate) => candidate.id === subBotMenu.botId); return target ? <SubBotMenu name={target.name} at={{ x: subBotMenu.x, y: subBotMenu.y }} onClose={() => setSubBotMenu(null)}
        onCloseSubBot={() => { setClosingSubBot(target); setSubBotMenu(null); }} /> : null; })()}
      {closingSubBot && <CloseSubBotDialog name={closingSubBot.name} onCancel={() => setClosingSubBot(null)} onConfirm={() => closeSubBot(closingSubBot)} />}
      {removing && <RemoveDialog bot={removing} onCancel={() => setRemoving(null)} onRemove={() => removeBot(removing)} />}
      {approval.sheet}
      {settingsOpen && <SettingsSheet client={client} settings={view.settings} bot={bot} bots={view.bots} plugins={view.plugins} initialSection={settingsSection} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

export function BotRow({ bot, selected, onSelect, look, waiting, counts, onMenu, pinned, onTogglePin, idle, peek }: {
  bot: BotView; selected: boolean; look: "original" | "cute"; waiting: boolean; onMenu?: (x: number, y: number) => void;
  /** The row was clicked: the row, and whether the keyboard pressed it (the status card then takes the focus). */
  onSelect: (from?: { el: HTMLElement; keyboard: boolean }) => void;
  /** The two numbers (rail-idle.ts botCounts): blue unread, orange what needs you (its sub bots' included). Absent: its own approvals and unread. */
  counts?: { unread: number; needsYou: number };
  /** Undefined for a row that cannot be pinned (the main bot, Maintainer). */
  pinned?: boolean; onTogglePin?: () => void;
  /** The corner button: a clock sends it to Idle, a back arrow (in Idle) brings it back. Undefined: it cannot go to Idle. */
  idle?: { away: boolean; onToggle: () => void };
  /** Its status card: the pointer came onto the row (corner buttons included) or left it; the keyboard focused the row. */
  peek?: { enter: (row: HTMLElement) => void; leave: () => void; focus: (row: HTMLElement) => void };
}) {
  const asleep = bot.phase === "asleep" && !bot.working;
  const tasks = bot.openTasks ?? 0;
  const unread = counts ? counts.unread : selected ? 0 : bot.unread;
  const needsYou = counts ? counts.needsYou : bot.approvals;
  const label = [bot.name, statusText(bot), needsYou ? `${needsYou} waiting on you` : waiting ? "waiting on you" : null, unread ? `${unread} unread` : null,
    tasks ? `${tasks} task${tasks === 1 ? "" : "s"} under way` : null, pinned ? "pinned" : null, idle?.away ? "in Idle" : null].filter(Boolean).join(", ");
  return (
    <div className={`bot-row-wrap${pinned !== undefined ? " pinnable" : ""}${idle ? " idleable" : ""}`}
      // A touch has no hover: its tap opens the card instead (onSelect).
      onPointerEnter={peek ? (event) => { if (event.pointerType !== "touch") peek.enter(event.currentTarget.querySelector<HTMLElement>(".bot-row") ?? event.currentTarget); } : undefined}
      onPointerLeave={peek ? (event) => { if (event.pointerType !== "touch") peek.leave(); } : undefined}>
      <button className={`bot-row${selected ? " selected" : ""}${asleep ? " asleep" : ""}`} data-bot={bot.id} aria-current={selected ? "page" : undefined} aria-label={label}
        onClick={(event) => onSelect({ el: event.currentTarget, keyboard: event.detail === 0 })}
        onFocus={peek ? (event) => { if (focusVisible(event.currentTarget)) peek.focus(event.currentTarget); } : undefined}
        onBlur={peek ? (event) => { if (!(event.relatedTarget instanceof Element && event.relatedTarget.closest(".rail-peek, .bot-row-wrap"))) peek.leave(); } : undefined}
        onContextMenu={onMenu ? (event) => { event.preventDefault(); onMenu(event.clientX, event.clientY); } : undefined}>
        <img className="bot-avatar" src={faceURL(bot, look, { asleep, working: bot.working, waiting: bot.approvals > 0 })} alt="" />
        <span className={`bot-name${bot.role === "main" ? " main" : ""}`}>{bot.name}</span>
        <span className="bot-gap" />
        {tasks > 0 && <span className="task-count" aria-hidden="true">{tasks} task{tasks === 1 ? "" : "s"}</span>}
        {bot.working && <span className="bot-dot working" aria-hidden="true" />}
        {(unread > 0 || needsYou > 0) && <span className="bot-counts">
          {unread > 0 && <span className="badge" aria-hidden="true">{unread}</span>}
          {needsYou > 0 && <span className="badge waiting" aria-hidden="true">{needsYou}</span>}
        </span>}
      </button>
      {idle && (
        // The clock at the row's top-right corner while the pointer is on it (the settle clock's icon); in Idle, the back arrow.
        <button type="button" className={`bot-idle${idle.away ? " away" : ""}`} onClick={idle.onToggle}
          title={idle.away ? "Back to the list" : "Send to Idle"} aria-label={idle.away ? `Bring ${bot.name} back from Idle` : `Send ${bot.name} to Idle`}>
          <Icon name={idle.away ? "uturn" : "clock"} size={12} />
        </button>
      )}
      {pinned !== undefined && onTogglePin && (
        // The pin glyph at the row's end while the pointer is on it (1.x's BotRow).
        <button type="button" className={`bot-pin${pinned ? " on" : ""}`} onClick={onTogglePin} title={pinned ? "Unpin" : "Pin to the top"} aria-label={pinned ? `Unpin ${bot.name}` : `Pin ${bot.name}`}>
          <Icon name={pinned ? "pinSlash" : "pin"} size={12} />
        </button>
      )}
    </div>
  );
}

export { railOrder } from "./rail-idle";

/** Where a row's card sits: beside the row. */
function anchorOf(row: HTMLElement): { top: number; right: number } {
  const box = row.getBoundingClientRect();
  return { top: box.top, right: box.right };
}

/** Whether the pointer can hover here (a touch screen cannot: a tap opens the card instead). */
function canHover(): boolean {
  return typeof window === "undefined" || typeof window.matchMedia !== "function" || window.matchMedia("(hover: hover)").matches;
}

/** Focus from the keyboard (not the focus a mouse click leaves on the row). */
function focusVisible(el: Element): boolean {
  try { return el.matches(":focus-visible"); } catch { return false; }
}

/** What a click on a subagent row opens: a sub bot's own chat (with the input box), or a subagent's read-only view. */
export function rowTarget(row: Pick<SubagentRowView, "id" | "subBot">): { kind: "bot"; botId: string } | { kind: "subagent"; id: string } {
  return row.subBot ? { kind: "bot", botId: row.subBot } : { kind: "subagent", id: row.id };
}

/** A sub bot's title: the project bot it belongs to (a button back to it), then its own name. */
export function SubBotTitle({ bot, parent, onOpenParent }: { bot: BotView; parent: BotView | null; onOpenParent: (botId: string) => void }) {
  return (
    <>
      {parent && <button type="button" className="chat-parent" title={`Back to ${parent.name}`} onClick={() => onOpenParent(parent.id)}>{parent.name}</button>}
      {parent && <span className="chat-parent-sep" aria-hidden="true"> › </span>}
      <span className="chat-sub-bot" data-sub-bot={bot.id}>{bot.name}</span>
    </>
  );
}

/** `RailLayout.matches`: the name, or a project's folder name, contains the query, ignoring case and accents. */
export function railMatches(query: string, name: string, folder: string | null): boolean {
  const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const wanted = fold(query.trim());
  if (!wanted) return true;
  return fold(name).includes(wanted) || (folder !== null && fold(folder).includes(wanted));
}

/** The rows the search keeps, in the order the column shows them (the main bot, the pinned rows, the rest). */
function searchHits(bots: BotView[], pinned: string[], query: string): BotView[] {
  return railOrder(bots, pinned).map((entry) => entry.bot)
    .filter((bot) => railMatches(query, bot.name, bot.role === "manager" ? bot.folder.split("/").filter(Boolean).pop() ?? null : null));
}

/** The cursor back in the chat's input box (after the search). */
function focusComposer() {
  if (nativeEditor()) { postToChat({ botling: "focus" }); return; }
  const target = (document.getElementById("chat-frame") as HTMLIFrameElement | null)?.contentWindow;
  if (!target) return;
  target.focus();
  const message: ShellMessage = { botling: "focus" };
  target.postMessage(message, CHAT_TARGET);
}

/** The button that folds the left column into a strip of faces and opens it again (1.x's RailToggle, ⌃⌘S). */
function RailToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  return (
    <button type="button" className={`rail-toggle${collapsed ? "" : " on"}`} onClick={onToggle} title={`${label} (${shortcutLabel("toggleSidebar")})`} aria-label={label} aria-pressed={!collapsed}>
      <Icon name="sidebarLeft" size={14} />
    </button>
  );
}

/** How long a face's tip or peek stays after the pointer or focus leaves it, so the pointer can cross into the peek. */
const PEEK_GRACE_MS = 200;

/**
 * The left column folded (1.x's RailStrip): faces only, the pinned ones first; hover (or focus) a face for a peek
 * (StripPeek) with its name and status and, for a bot with sub bots, those sub bots, each opening its chat.
 * The chat is a native view above the shell, so an open peek covers it as one shell overlay across faces.
 */
export function RailStrip({ bots, pinned, look, shown, waiting, onSelect, onMenu, onExpand, onAddProject, onNewBot, settingsControl }: {
  bots: BotView[]; pinned: string[]; look: "original" | "cute"; shown: string | null; waiting: (id: string) => boolean;
  onSelect: (id: string) => void; onMenu: (bot: BotView, x: number, y: number) => void; onExpand: () => void; onAddProject: () => void; onNewBot: () => void; settingsControl: ReactNode;
}) {
  const [tip, setTip] = useState<{ botId: string; top: number } | null>(null);
  const [adding, setAdding] = useState(false);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Focus put back on a face by Escape does not open its peek again.
  const quiet = useRef(false);
  const keep = useCallback(() => { if (closing.current) { clearTimeout(closing.current); closing.current = null; } }, []);
  const hide = useCallback((soon: boolean) => {
    keep();
    if (soon) closing.current = setTimeout(() => { closing.current = null; setTip(null); }, PEEK_GRACE_MS);
    else setTip(null);
  }, [keep]);
  useEffect(() => keep, [keep]);
  const order = railOrder(bots, pinned);
  const pinnedCount = pinned.length;
  const faces = useRef(new Map<string, HTMLButtonElement>());
  return (
    <aside className="rail-strip" aria-label="Bots (folded)">
      <div className="rail-top drag"><RailToggle collapsed onToggle={onExpand} /></div>
      <nav className="strip-bots" aria-label="Bots">
        {order.map(({ bot }, index) => {
          const asleep = bot.phase === "asleep" && !bot.working;
          const unread = bot.unread > 0 && bot.id !== shown;
          const parts = [statusText(bot), waiting(bot.id) ? "waiting on you" : null, unread ? `${bot.unread > 99 ? "99+" : bot.unread} unread` : null].filter(Boolean);
          const subs = subBotsOf(bot, bots);
          const open = tip?.botId === bot.id;
          const show = (face: HTMLElement) => { keep(); setTip({ botId: bot.id, top: face.getBoundingClientRect().top }); };
          return (
            <div key={bot.id} className="strip-entry">
              {index === 1 && <div className="strip-rule" />}
              {pinnedCount > 0 && index === 1 + pinnedCount && <div className="strip-rule short" />}
              <button type="button" ref={(face) => { if (face) faces.current.set(bot.id, face); else faces.current.delete(bot.id); }} className={`strip-bot${bot.id === shown ? " selected" : ""}${asleep ? " asleep" : ""}${bot.working ? " working" : ""}${bot.connection ? " disconnected" : ""}`} data-bot={bot.id}
                aria-label={[bot.name, ...parts, subs.length ? `${subs.length} sub bot${subs.length === 1 ? "" : "s"}` : null].filter(Boolean).join(", ")}
                aria-expanded={subs.length ? open : undefined} onClick={() => onSelect(bot.id)}
                onMouseEnter={(event) => show(event.currentTarget)} onMouseLeave={() => hide(true)}
                onFocus={(event) => { if (!quiet.current) show(event.currentTarget); }}
                onBlur={(event) => { if (!(event.relatedTarget instanceof Node && event.currentTarget.parentElement?.contains(event.relatedTarget))) hide(true); }}
                onKeyDown={(event) => { if (event.key === "Escape" && open) { event.preventDefault(); hide(false); } }}
                onContextMenu={bot.role !== "main" && bot.id !== MAINTAINER_BOT_ID ? (event) => { event.preventDefault(); onMenu(bot, event.clientX, event.clientY); } : undefined}>
                <img src={faceURL(bot, look, { asleep, working: bot.working, waiting: bot.approvals > 0 })} alt="" />
                {bot.connection && <span className="strip-disconnected" aria-hidden="true">!</span>}
                {unread && <span className="strip-unread" aria-hidden="true" />}
              </button>
              {open && tip && (
                <StripPeek bot={bot} subs={subs} detail={parts.join(" · ")} look={look} top={tip.top} shown={shown}
                  onOpen={(id) => { hide(false); onSelect(id); }} onEnter={keep} onLeave={() => hide(true)}
                  onDismiss={() => {
                    quiet.current = true;
                    faces.current.get(bot.id)?.focus();
                    quiet.current = false;
                    hide(false);
                  }} />
              )}
            </div>
          );
        })}
      </nav>
      <ShellOverlay active={tip !== null}>{null}</ShellOverlay>
      <div className="strip-add">
        <button type="button" className="strip-plus" title="Add a project or a bot" aria-label="Add a project or a bot" aria-expanded={adding} onClick={() => setAdding(!adding)}><Icon name="plus" size={13} /></button>
        {adding && (
          <ShellOverlay><div className="strip-add-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => { setAdding(false); onAddProject(); }}>Add project…</button>
            <button type="button" role="menuitem" onClick={() => { setAdding(false); onNewBot(); }}>New bot…</button>
          </div></ShellOverlay>
        )}
      </div>
      {settingsControl}
    </aside>
  );
}

/** The reused chat page, in a frame. */
/**
 * A plugin command from a key, the / menu or a menu: in the plugin host (the app page asks, so the core runs any),
 * or in the chat page when a web part there registered it.
 */
function runPluginCommand(client: Client, plugins: PluginsView | null | undefined, id: string, args: string[], onError: (failure: unknown) => void, caller?: { from: "frame"; name: string }) {
  if (caller?.from === "frame" && !ownsCommand(caller.name, id)) return;
  const route = commandRoute(plugins, id);
  // A bottom panel's toggle command is the page's own to run (it shows or hides the panel of the bot on screen), whichever way it
  // arrived: a key pressed in this page, or one the chat frame relays (where focus usually is).
  if (route === "bottomPanel") window.dispatchEvent(new CustomEvent(TOGGLE_BOTTOM_PANEL, { detail: id }));
  else if (route === "host") void client.request({ type: "plugins.command", id, ...(caller ?? {}), ...(args.length ? { args } : {}) }).catch(onError);
  else postToChat({ botling: "runCommand", id });
}

function ChatFrame({ client, store, onError, onSent, onSelectTask, onAsk }: { client: Client; store: WorkspaceStore; onError: (failure: unknown) => void; onSent: () => void; onSelectTask: (id: string) => void;
  onAsk: (view: ApprovalAskView, approve: import("../contract").Command, done?: (allowed: boolean) => void) => void }) {
  const [report, setReport] = useState<{botId: string; url: string} | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const placeholder = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<{image:string;revision:number} | null>(null);
  useEffect(() => {
    const bridge = nativeEditor();
    if (bridge && placeholder.current) return observeEditorLayout(placeholder.current, bridge, () => true);
  }, []);
  const ready = useRef(false);
  const widthDragging = useRef(false);
  const view = useSyncExternalStore(store.subscribeChat, store.getChatView);
  useEffect(() => { setReport(null); }, [view.chat?.botId]);
  // The line the next message answers (the page's Reply), per chat.
  const [replying, setReplying] = useState<{ botId: string; id: string } | null>(null);
  const replyingRef = useRef(replying);
  replyingRef.current = replying;

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
    const { state, extras } = current.subagent ? subagentState(bot, current.subagent) : chatState(bot, chat, new Date(), quoted, {
      components: current.components, board: current.board, look: current.settings?.botLook ?? "original",
      lang: current.settings?.effectiveLanguage ?? null, chatAvatarSize: current.settings?.chatAvatarSize ?? null, bots: current.bots,
      // Developer mode with Botling's source among the projects: replies get "not right" (`feedback`).
      feedback: !!current.settings?.developerMode && current.bots.some((candidate) => candidate.id === current.settings?.developerProject && candidate.role === "manager"),
      plugins: current.plugins,
    });
    const traceId = inputTrace()?.mark("shell.state.send", () => ({ chat: state.botID, ...inputTrace()!.snapshot() }));
    return { state, extras, libraryVersion: current.libraryVersion, resyncs: current.resyncs,
      messageColumnWidth: current.settings?.messageColumnWidth ?? null, ...(traceId ? { traceId } : {}) };
  }, postToChat), [store]);
  const push = useCallback(() => channel.flush(true), [channel]);
  useEffect(() => { channel.schedule(); }, [channel, view, replying]);
  useEffect(() => channel.reset, [channel]);

  useEffect(() => {
    // Chromium can deliver pointerup to the shell after a captured pointer leaves its iframe.
    // Forward shell-side events in frame coordinates until the drag finishes or is cancelled.
    const widthPointer = (kind: "move" | "up" | "cancel", event?: PointerEvent) => {
      if (!widthDragging.current) return;
      const box = (placeholder.current ?? frame.current)?.getBoundingClientRect();
      const message: ShellMessage = { botling: "messageWidthPointer", kind, pointerId: event?.pointerId ?? 0, x: (event?.clientX ?? 0) - (box?.left ?? 0) };
      postToChat(message);
      if (kind !== "move") widthDragging.current = false;
    };
    const widthMove = (event: PointerEvent) => widthPointer("move", event);
    const widthUp = (event: PointerEvent) => widthPointer("up", event);
    const widthCancel = () => widthPointer("cancel");
    window.addEventListener("pointermove", widthMove);
    window.addEventListener("pointerup", widthUp);
    window.addEventListener("pointercancel", widthCancel);
    return () => {
      widthCancel();
      window.removeEventListener("pointermove", widthMove);
      window.removeEventListener("pointerup", widthUp);
      window.removeEventListener("pointercancel", widthCancel);
    };
  }, []);

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
      if (message.botling === "messageWidthDrag") {
        widthDragging.current = message.active === true;
        return;
      }
      if (message.botling === "messageWidth") {
        // The contract validates the number again in main and core; a card cannot impersonate this frame.
        void client.request({ type: "settings.set", change: { key: "messageColumnWidth", value: message.value } }).catch((failure) => {
          onError(failure);
          postToChat({botling:"widthRejected",value:message.value,actual:store.getView().settings?.messageColumnWidth ?? null});
          push();
        });
        return;
      }
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
      const composerFailure = (error: unknown) => { composerReply(false, error instanceof Error ? error.message : String(error)); onError(error); };
      switch (action?.type) {
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
          if (nativeEditor() && ["settings", "rightPanel", "sidebar", "search"].includes(String(action.command))) {
            window.dispatchEvent(new CustomEvent("botling:chat-command", { detail: action.command }));
          }
          return;
        case "ready":
          ready.current = true;
          push();
          // A page that (re)loaded has no plugins yet.
          lastSpecs.current = "";
          pushPlugins();
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
          void client.request({ type: "chat.send", botId, text: action.text, ...(reply ? { replyTo: reply } : {}), ...to }).then(result => {
            if (result.stoppedBy) { composerReply(false, `Plugin ${result.stoppedBy} stopped the message.`); return; }
            onSent();
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
        // A task chip under a reply: its card opens in the right panel.
        case "selectTask":
          if (typeof action.id === "string") onSelectTask(action.id);
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
          if (chat && typeof action.url === "string" && action.url) void client.request({ type: "link.open", ...(message.reportPreview === true && action.type === "openURL" ? {preview: true} : {}), ...(action.type === "revealFile" ? { reveal: true } : {}), source: message.linkSource === "user" ? "user" : "component", ...(typeof message.linkMessageId === "string" ? {messageId:message.linkMessageId} : {}), ...(typeof message.linkPinId === "string" ? {pinId:message.linkPinId} : {}), botId: chat.botId, url: action.url.slice(0, 8_000) }).then(result => { if (result.previewURL && store.getChatView().chat?.botId === chat.botId) setReport({botId: chat.botId, url: result.previewURL}); }).catch(onError);
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
      else if ("bound" in packet) { ready.current = true; lastSpecs.current = ""; push(); pushPlugins(); }
      else if ("snapshot" in packet) setSnapshot(packet.snapshot ? {image:packet.snapshot,revision:packet.revision} : null);
      else receive(packet.message as FrameMessage);
    });
    const onMessage = (event: MessageEvent) => {
      if (frame.current && event.source === frame.current.contentWindow && event.origin === CHAT_ORIGIN) receive(event.data);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [client, onError, onSent, onSelectTask, onAsk, push, pushPlugins, store, channel]);

  const viewer = report && report.botId === view.chat?.botId ? <ReportViewer url={report.url} onClose={() => setReport(null)} /> : null;
  if (nativeEditor()) return <>{viewer}<div id="chat-frame" ref={placeholder} aria-label="Chat" style={{ position: "relative", overflow: "hidden" }}>
    {snapshot && <img data-native-chat-snapshot="" src={snapshot.image} onLoad={() => nativeEditor()?.snapshotReady(snapshot.revision)} alt="" aria-hidden="true" style={{ width: "100%", height: "100%", position: "absolute", inset: 0, pointerEvents: "none" }} />}
  </div></>;
  return <>{viewer}<iframe id="chat-frame" ref={frame} src={inputTrace() ? `${CHAT_PAGE}?${TEST_TRACE_QUERY}=1` : CHAT_PAGE} sandbox={CHAT_SANDBOX} allow={CHAT_SANDBOX ? "clipboard-write" : undefined} title="Chat" /></>;
}
