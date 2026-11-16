import { BottomPanels } from "./BottomPanels";
import { ChatHeaderViews } from "./ChatHeaderViews";
import { useComposerBar, useComposerBarView } from "./ComposerBar";
// The app page: React chrome around the reused chat page, drawn inside shell/ShellFrame (the chat column is botling.chat's contribution to `app/main`).
// The left column lists the bots (as the Swift app's sidebar); the chat area hosts Web/src's chat page in a same-origin
// frame (chat-frame/), fed with the state ChatPayload.swift would build (payload.ts). The frame posts what the user does
// (send, a pick on an approval, Stop); this page turns that into contract commands. Only this page has the bridge to main.
import { ShellFrame } from "./shell/ShellFrame";
import { RailSlot } from "./SidebarRail";
import { RAIL_SLOT } from "./sidebar-names";
import { useRailLayout, type LayoutKey, type RailLayout } from "./sidebar-layout";
import { RegionSlot } from "./shell/regions";
import { openReport } from "./report-opener";
import { askChatToQuote, setComposerQuoter } from "./composer-quote";
import { shellOverlayActive } from "./ShellOverlay";
import { postToChat } from "./editor-surface";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { status, statusText } from "../contract/bot-status";
import { commandBindings, formatCombo } from "../contract/shortcuts";
import { say, setShortcutLabels, shellPlatform, shortcutLabel } from "./shortcut-labels";
import { isMaintainer, resultLinks, type BotView, type ResultView, type RoutineView, type SettingsChange, type SubagentRowView } from "../contract";
import { Client, RequestFailed } from "./client";
import { WorkspaceStore } from "./store";
import { browserTabActions, browserTabAddress, keybindingsOf, menuItems } from "./plugin-commands";
import { browserPlugins, useBrowserSlotsVersion } from "./browser-slot";
import { chatMainTabs, useChatSlotsVersion } from "./chat-slot";
import { sameHeldColors, setBotColors } from "./avatars";
import { MainTabFrame, PanelFrame, SlotFrame } from "./Plugins";
import { TakeoverPage } from "./TakeoverPage";
import { mainTabsFor, rightPanelSectionsFor, shownChat, shownTab, STORAGE_TAB, tabKey, WHITEBOARD_PLUGIN, type MainTab } from "./main-tabs";
import { StorageTab } from "./StorageTab";
import { BotSettings, SettingsSheet, type SettingsSection } from "./Settings";
import { TaskDetails } from "./TaskDetails";
import { idleList } from "./rail-idle";
import { markViewed, readViewedWorkers, seenInChat } from "./rail-workers";
import { SubBotNav } from "./SubBotNav";
import { flashMs, headerNav, leaveMark, movePinned, newSubBotAsk, NEW_SINCE_PREFIX, pinnedTarget, rememberRoom, roomStep, togglePinned, type LastRooms } from "./sub-bot-nav";
import { useAppKeys, useBottomControls, useBuiltinRunner } from "./app-hooks";
import { PINNED_KEYS, leaveMarks, useWhiteboardChoice, type WebChrome } from "./app-shared";
export type { WebChrome } from "./app-shared";
import { ChatFrame } from "./chat-frame/ChatFrame";
import { focusComposer, rowTarget, runPluginCommand, SubBotTitle } from "./rail-parts";
export { BotRow, focusComposer, railMatches, RailStrip, rowTarget, runPluginCommand, SubBotTitle } from "./rail-parts";
import { AgentMenu, BotMenu, CloseSubBotDialog, RemoveDialog, SubBotMenu, useMinuteClock, type AgentMoveTo, type AgentTargets } from "./Rail";
import { Icon, isIconName } from "./icons";
import { useApprovalSheet } from "./ApprovalSheet";
import { WorkerAskBar, WorkersBadge, WorkersMenu } from "./Workers";
import { filesChanged, readSeenFailed, watchedWorker, workersMenuAfterMove, writeSeenFailed, type AskWorker } from "./worker-panel";
import { BrowserPane } from "./BrowserPane";
import { ColumnDivider } from "./ColumnDivider";
import { FloatingChat, useFloatMemory } from "./FloatingChat";
import { lastLine } from "./floating-chat";
import { ChatBody } from "./NoteDock";
import { dockKey, docked as dockShown, keepDock, toggleDock } from "./note-dock";
import { browserStore, useBrowser } from "./browser-state";

export function App({ client, store, web }: { client: Client; store: WorkspaceStore; web?: WebChrome }) {
  const view = useSyncExternalStore(store.subscribe, store.getView);
  const chatSlots = useChatSlotsVersion(); // the main tabs come from the kernel's `main/tab` slot (chat-slot.ts `chatMainTabs`): draw again when it changes
  useBrowserSlotsVersion(); // the pane's toolbar buttons come from the kernel's `browser/tab` slot (browser-slot.ts): draw again when it changes
  // The left column's layout (folded into a strip of faces, ⌃⌘S; the pinned bots; Idle: 1.x's RailView) is the sidebar plugin's (M7-05a): kept in
  // the shell's storage while the plugin is up, in the settings keys otherwise. Read first: the bot colours below settle by the pinned bots.
  const writeLayout = useCallback((key: LayoutKey, value: RailLayout[LayoutKey]) => {
    void client.request({ type: "settings.set", change: { key, value } as SettingsChange }).catch(() => {});
  }, [client]);
  const { layout, read: readLayout, change: changeLayout } = useRailLayout(view.settings, !web, writeLayout);
  const railCollapsed = layout.railCollapsed;
  const toggleRail = useCallback((collapse?: boolean) => {
    changeLayout((now) => ({ railCollapsed: collapse ?? !now.railCollapsed }));
  }, [changeLayout]);
  // Bots whose colours clash get the least clashing one (avatars.ts); before any face below is drawn.
  // Once settled a colour is held in settings.json `botColors`, so nothing later moves it.
  const heldColors = setBotColors(view.bots, layout.pinnedBots, view.settings?.botColors);
  const heldToWrite = view.settings && !web && view.bots.length > 0 && !sameHeldColors(view.settings.botColors, heldColors) ? heldColors : null;
  useEffect(() => {
    if (heldToWrite) void client.request({ type: "settings.set", change: { key: "botColors", value: heldToWrite } }).catch(() => {});
  }, [client, heldToWrite]);
  const [error, setError] = useState<string | null>(null);
  const [bottomControls, setBottomControls] = useBottomControls();
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
  const now = useMinuteClock();
  /** The main bot's main view: its chat, or the whiteboard plugin's tab (kept for the next start). */
  const [whiteboardOn, setWhiteboardOn] = useWhiteboardChoice();
  const collapsed = view.settings?.rightPanelCollapsed ?? false;
  const toggleRight = useCallback(() => {
    void client.request({ type: "settings.set", change: { key: "rightPanelCollapsed", value: !(store.getView().settings?.rightPanelCollapsed ?? false) } }).catch(() => {});
  }, [client, store]);
  // Navigation v5: the workers badge's menu (open for the bot on screen) and the failed workers whose log you opened
  // (the badge stops showing them as failed). A worker opens in the main area, like a left-column click.
  const [workersMenu, setWorkersMenu] = useState<string | null>(null);
  // ⌘⇧W on a watched worker: the menu to keep open once the chat is back (the move would otherwise close it).
  const workersMenuPending = useRef<string | null>(null);
  const [seenFailed, setSeenFailed] = useState<ReadonlySet<string>>(() => readSeenFailed());
  const seeWorker = useCallback((workerId: string) => setSeenFailed((seen) => {
    if (seen.has(workerId)) return seen;
    const next = new Set(seen).add(workerId);
    writeSeenFailed(next);
    return next;
  }), []);
  // "Ask <owner>": the worker shown as a reference in that owner's input box until you send or ×.
  const [askAbout, setAskAbout] = useState<{ botId: string; worker: AskWorker; ownerName: string } | null>(null);
  // The badge and ⌘⇧W open or close the menu; ⌘⇧W on a worker shown in the main area goes back to the chat with the menu open.
  const toggleWorkers = useCallback(() => {
    const shown = store.getView().chat?.botId;
    if (!shown) return;
    if (store.getView().subagent) { workersMenuPending.current = shown; store.watch(null); setWorkersMenu(shown); return; }
    setWorkersMenu((open) => (open === shown ? null : shown));
  }, [store]);
  // The Browser button in the chat header and ⌘⇧B: the in-app browser pane of the bot on screen, shown or hidden.
  const toggleBrowser = useCallback(() => {
    const current = store.getView();
    if (web || !current.chat?.botId) return;
    browserStore.toggle(current.chat.botId);
  }, [store, web]);
  // The left column's search (⌘K); its layout (folded, pinned, Idle) is read above, next to the bot colours that depend on the pinned bots.
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const startSearch = useCallback(() => {
    if (readLayout().railCollapsed) toggleRail(false);
    // After the open column (and its field) is drawn.
    setTimeout(() => search.current?.focus(), 50);
  }, [readLayout, toggleRail]);
  const pinned = useMemo(() => {
    return layout.pinnedBots.filter((id) => view.bots.some((candidate) => candidate.id === id && candidate.role !== "main" && !isMaintainer(candidate)));
  }, [layout.pinnedBots, view.bots]);
  const togglePin = useCallback((botId: string) => {
    changeLayout((current) => {
      const now = current.pinnedBots.filter((id) => store.getView().bots.some((candidate) => candidate.id === id));
      return { pinnedBots: now.includes(botId) ? now.filter((id) => id !== botId) : [...now, botId] };
    });
  }, [changeLayout, store]);
  // Idle (the left column's bottom group): only the user sends a bot there, with the clock on its row; the back arrow brings it back.
  const idle = layout.idleBots;
  const setIdle = useCallback((botId: string, away: boolean) => {
    changeLayout((current) => ({ idleBots: idleList(current.idleBots.filter((id) => store.getView().bots.some((candidate) => candidate.id === id)), botId, away) }));
  }, [changeLayout, store]);
  // Finished workers you opened (the left column's worker lists, rail-workers.ts).
  const [viewedWorkers, setViewedWorkers] = useState<ReadonlySet<string>>(() => readViewedWorkers());
  // Navigation v5: the Sub bots menu left of Chat | Storage (⌘⇧S), and ⌘[ / ⌘] between a project bot and the
  // sub bot last shown under it (kept for this window only, never in a bot's context).
  const [subBotsOpen, setSubBotsOpen] = useState(false);
  const lastRooms = useRef<LastRooms>({});
  const toggleSubBots = useCallback(() => {
    const current = store.getView();
    const shown = current.bots.find((candidate) => candidate.id === current.chat?.botId);
    // Only where the header has the button or the breadcrumb (a bot with sub bots, or a sub bot).
    if (shown && headerNav(shown, current.bots, current.waiting, Date.now()).kind !== "none") setSubBotsOpen((open) => !open);
  }, [store]);
  const stepRoom = useCallback((direction: "back" | "forward") => {
    const current = store.getView();
    const shown = current.bots.find((candidate) => candidate.id === current.chat?.botId);
    const target = shown ? roomStep(direction, shown, current.bots, lastRooms.current) : null;
    if (target) { setSubBotsOpen(false); setError(null); void store.select(target); }
  }, [store]);
  // Pinned sub bots (the menu's Pinned section, ⌘⌥1–9), kept in settings in the order dragged.
  const pinnedSubBots = view.settings?.pinnedSubBots ?? [];
  const setPinnedSubBots = useCallback((change: (now: string[]) => string[]) => {
    const now = (store.getView().settings?.pinnedSubBots ?? []).filter((id) => store.getView().bots.some((candidate) => candidate.id === id));
    void client.request({ type: "settings.set", change: { key: "pinnedSubBots", value: change(now) } }).catch(() => {});
  }, [client, store]);
  const openPinned = useCallback((n: number) => {
    const current = store.getView();
    const shown = current.bots.find((candidate) => candidate.id === current.chat?.botId);
    const target = shown ? pinnedTarget(n, shown, current.bots, current.settings?.pinnedSubBots ?? []) : null;
    if (target && target !== shown?.id) { setSubBotsOpen(false); setError(null); void store.select(target); }
  }, [store]);
  // Routines of the sub bots in the menu (read-only, each from its own routines.cron), asked for whenever the menu opens.
  const [subBotRoutines, setSubBotRoutines] = useState<Record<string, RoutineView[]>>({});
  // The app's keys (Settings > Shortcuts): ⌘, Settings, ⌃⌘I the right panel, ⌃⌘S the left column, ⌘K its search, by default.
  const shortcutBindings = useMemo(() => setShortcutLabels(view.settings?.shortcuts), [view.settings?.shortcuts]);
  // Plugin commands' keys (plugin-platform.md §3.3), after the app's: the same table the chat page relays.
  const pluginKeys = useMemo(() => commandBindings(keybindingsOf(view.plugins), view.settings?.shortcuts), [view.plugins, view.settings?.shortcuts]);
  const runCommand = useCallback((id: string, args: string[] = [], caller?: { from: "frame"; name: string }) => {
    runPluginCommand(client, store.getView().plugins, id, args, (failure) => setError(failure instanceof RequestFailed ? failure.error.message : String((failure as Error)?.message ?? failure)), caller);
  }, [client, store]);
  const forwardKey = useAppKeys({ openSettings, toggleRight, toggleWorkers, toggleBrowser, toggleRail, startSearch, toggleSubBots, stepRoom, openPinned, shortcutBindings, pluginKeys, runCommand });
  const chat = view.chat;
  const results = useMemo<ResultView[]>(() => (chat ? resultLinks(chat.messages) : []), [chat]);
  const watching = view.subagent?.id ?? null;
  const bot = useMemo(() => view.bots.find((candidate) => candidate.id === chat?.botId) ?? null, [view.bots, chat?.botId]);
  // A plugin's page that a program part opened in the right panel's place (`ui.takeover`), while that bot's chat is shown.
  const takeover = !web && !watching && bot && view.plugins?.takeover?.botId === bot.id ? view.plugins.takeover : null;
  const takeoverView = takeover ? view.plugins?.takeovers?.find((entry) => entry.plugin === takeover.plugin && entry.id === takeover.view) ?? null : null;
  // A plugin's tab in the main area (plan W2), the one this bot showed last; it takes the whiteboard's place too.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tabs = useMemo(() => (bot && !web ? mainTabsFor(chatMainTabs(view.plugins), bot) : []), [bot, web, view.plugins, chatSlots]);
  // botling.whiteboard's tab; with that plugin off there is no whiteboard.
  const boardTab = bot?.role === "main" ? tabs.find((candidate) => candidate.plugin === WHITEBOARD_PLUGIN) ?? null : null;
  const remembered = bot && !watching ? shownTab(tabs, view.settings?.mainTabs?.[bot.id]) : null;
  // The app's own Storage tab (StorageTab.tsx), right of the plugins' tabs; not in Botling Web.
  const storageOn = !!bot && !web && !watching && view.settings?.mainTabs?.[bot.id] === STORAGE_TAB;
  // The main bot opens on the whiteboard unless you last picked Chat (or Storage): the choice is kept for the next start.
  const tab = storageOn ? null : remembered ?? (boardTab && whiteboardOn && !watching ? boardTab : null);
  // The header's left side (navigation v5): this bot's Sub bots button, or inside a sub bot the way back.
  const nav = useMemo(() => (bot && !web ? headerNav(bot, view.bots, view.waiting, now, subBotRoutines) : { kind: "none" as const }), [bot, web, view.bots, view.waiting, now, subBotRoutines]);
  const navIds = nav.kind === "none" ? "" : nav.rows.map((row) => row.id).join(",");
  useEffect(() => {
    if (!subBotsOpen || !navIds) return;
    let live = true;
    for (const botId of navIds.split(",")) {
      void client.request({ type: "routines.list", botId }).then((result) => {
        if (live) setSubBotRoutines((known) => ({ ...known, [botId]: result.routines }));
      }, () => {});
    }
    return () => { live = false; };
  }, [subBotsOpen, navIds, client]);
  // Back in a project bot from its sub bot: the Sub bots button rings blue for 600 ms and "⌘] <sub bot>" shows beside it.
  const [cameBack, setCameBack] = useState<{ botId: string; from: string; flash: boolean } | null>(null);
  const previousBot = useRef<{ id: string; parent: string | null } | null>(null);
  // The newest line of the chat on screen, read when you leave it (for "New while you were in X").
  const newestLine = useRef<{ botId: string; id: string | null } | null>(null);
  useEffect(() => {
    const before = previousBot.current;
    previousBot.current = bot ? { id: bot.id, parent: bot.parent ?? null } : null;
    setSubBotsOpen(false);
    if (!bot) return;
    if (before && before.id !== bot.id) {
      const lastId = newestLine.current?.botId === before.id ? newestLine.current.id : null;
      leaveMarks.current = leaveMark(leaveMarks.current, { id: before.id, parent: before.parent, lastId }, bot);
    }
    lastRooms.current = rememberRoom(lastRooms.current, bot);
    if (before?.parent !== bot.id) { setCameBack(null); return; }
    setCameBack({ botId: bot.id, from: before.id, flash: true });
    // With Reduce motion the ring stays still for 1.2 s instead of 600 ms.
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = setTimeout(() => setCameBack((shown) => (shown?.botId === bot.id ? { ...shown, flash: false } : shown)), flashMs(reduced));
    return () => clearTimeout(timer);
  }, [bot?.id]);
  useEffect(() => {
    if (chat) newestLine.current = { botId: chat.botId, id: chat.messages.findLast((message) => !message.id.startsWith(NEW_SINCE_PREFIX))?.id ?? null };
  }, [chat]);
  const cameFrom = cameBack && cameBack.botId === bot?.id ? view.bots.find((candidate) => candidate.id === cameBack.from && candidate.parent === bot.id) ?? null : null;

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
  // A worker in the main area (the watched subagent is one of the shown bot's workers): "Ask <owner>" under it,
  // and opening a failed one counts as seen.
  const shownWorker = useMemo(() => watchedWorker(bot, view.subagent ?? null), [bot, view.subagent]);
  useEffect(() => { if (shownWorker?.status === "failed") seeWorker(shownWorker.id); }, [shownWorker?.id, shownWorker?.status, seeWorker]);
  // A finished worker opened in the main area is viewed: its blue dot goes, and it leaves the list once you move on.
  useEffect(() => { if (shownWorker && shownWorker.status !== "running") setViewedWorkers(markViewed(shownWorker.id)); }, [shownWorker?.id, shownWorker?.status]);
  // A bot's chat open counts its finished workers' reports as seen: they leave the list (a sub bot's, in its own chat).
  const seenNow = !watching && bot ? seenInChat(bot, viewedWorkers) : [];
  useEffect(() => { if (seenNow.length) setViewedWorkers(markViewed(...seenNow)); }, [seenNow.join(",")]);
  useEffect(() => {
    setWorkersMenu(workersMenuAfterMove(workersMenuPending.current, chat?.botId));
    workersMenuPending.current = null;
  }, [chat?.botId, watching]);
  const askOwner = useCallback((ownerId: string, worker: AskWorker) => {
    const owner = store.getView().bots.find((candidate) => candidate.id === ownerId);
    if (!owner) return;
    setAskAbout({ botId: ownerId, worker, ownerName: owner.name });
    store.watch(null);
    if (store.getView().chat?.botId !== ownerId) selectBot(ownerId);
    setTimeout(focusComposer, 0);
  }, [store, selectBot]);
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

  // "+ New sub bot…" (Navigation v5): only a project bot opens sub bots, so it is asked in its chat, as you would yourself.
  const newSubBot = useCallback(async (projectId: string, name: string, purpose: string) => {
    await client.request({ type: "chat.send", botId: projectId, text: newSubBotAsk(name, purpose) });
    setSubBotsOpen(false);
    if (store.getView().chat?.botId !== projectId) void store.select(projectId);
  }, [client, store]);

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

  /** Shows a plugin tab for a bot, the Storage tab (`STORAGE_TAB`), or none (Chat), and keeps it for next time. */
  const chooseTab = useCallback((botId: string, next: MainTab | typeof STORAGE_TAB | null) => {
    const key = next === STORAGE_TAB ? STORAGE_TAB : next ? tabKey(next) : null;
    if ((store.getView().settings?.mainTabs?.[botId] ?? null) === key) return;
    void client.request({ type: "settings.set", change: { key: "mainTab", value: { botId, tab: key } } }).catch(fail);
  }, [client, store, fail]);
  // Botling's own commands a plugin frame may run: a bot's chat (its Chat tab), one of a bot's results.
  const runBuiltin = useBuiltinRunner({ client, store, fail, setError, chooseTab, setWhiteboardOn, selectBot, dockNow: () => quoteNow.current });
  // A plugin's program part asked to show a bot with one of its tabs (`ui.showTab(…, { open: true })`): as its frame's openTab would.
  const openTabSeq = view.openTab?.seq ?? 0;
  useEffect(() => {
    const asked = store.getView().openTab;
    if (web || !asked) return;
    runBuiltin(asked.plugin, { id: "botling.openTab", botId: asked.botId, plugin: asked.plugin, view: asked.view });
  }, [openTabSeq]);
  // A plugin's view at the right end of the row above the input box (`composerBar`), drawn in the chat page.
  useComposerBar({ client, view: useComposerBarView(view.plugins, bot && !web ? bot : null), botId: bot?.id ?? null, onBuiltin: runBuiltin, components: view.components, bots: view.bots, ask: approval.ask });

  // A result opens in the browser, the app's Markdown preview or with its own app; main checks it is one of this chat's links.
  const openResult = useCallback((result: ResultView) => {
    if (!chat) return;
    setError(null);
    // A Markdown result comes back as a report page (main never hands .md to the system's app).
    const botId = chat.botId;
    void client.request({ type: "result.open", botId, url: result.url })
      .then((opened) => { if (opened.previewURL) openReport(botId, opened.previewURL); }).catch(fail);
  }, [client, chat, fail]);

  // The bot's settings, one level in in the right panel (1.x's DetailPanel `showingSettings`); a new bot shows its overview.
  const [botSettings, setBotSettings] = useState(false);
  // Settings → Models & workers → "Open" on a bot with its own settings: that bot, with its settings panel open.
  const openingBotSettings = useRef<string | null>(null);
  useEffect(() => { setBotSettings(!!bot && openingBotSettings.current === bot.id); openingBotSettings.current = null; }, [bot?.id]);
  const openBotSettings = useCallback(() => { if (collapsed) toggleRight(); setBotSettings(true); }, [collapsed, toggleRight]);

  // The core learns what the main window shows, for plugins' `workspace.current`; said again after every snapshot
  // (a restarted core knows nothing). Botling Web's page never says it: it is not the main window.
  const shownTabKey = tab ? tabKey(tab) : null;
  useEffect(() => {
    if (web || !view.ready) return;
    void client.request(shownChat(bot?.id ?? null, { subagent: !!watching, tab, storage: storageOn })).catch(() => {});
  }, [client, web, view.ready, view.resyncs, bot?.id, watching, shownTabKey, storageOn]);

  // The in-app browser pane beside the chat (BrowserPane.tsx): open for this bot once a link opened in it. While it is
  // open the right panel folds to its strip unless you open it again; full screen hides everything else but the pane
  // (and the chat, docked beside it, when you open it from the bot's bubble).
  const browser = useBrowser();
  const browserState = bot ? browser.states[bot.id] : undefined;
  // The Browser button (⌘⇧B) opens it with no tabs too: an empty new tab with the address bar focused.
  const paneOpen = !web && !!bot && !!browser.open[bot.id];
  const browserFull = paneOpen && browser.full;
  const [miniChat, setMiniChat] = useState(false);
  // The floating chat (FloatingChat.tsx): each place floats the chat over its page, or docks it beside as before.
  const floatMemory = useFloatMemory();
  const browserDocked = browserFull && miniChat && floatMemory.browser.docked;
  const browserFloat = browserFull && miniChat && !floatMemory.browser.docked;
  // The strip's line: the bot's newest line in the chat on screen.
  const chatMessages = chat && bot && chat.botId === bot.id ? chat.messages : null;
  const stripLine = useMemo(() => lastLine(chatMessages ?? []), [chatMessages]);
  const [rightWithPane, setRightWithPane] = useState(false);
  useEffect(() => { if (!paneOpen) { setRightWithPane(false); if (browser.full) browserStore.setFull(false); } }, [paneOpen]);
  useEffect(() => { if (!browserFull) setMiniChat(false); }, [browserFull]);
  // The Note tab's strip (note-dock.ts, FloatingChat.tsx): opens this bot's chat floating over the Note, or docked
  // beside it when that was chosen in the panel's header; another tab or bot closes it.
  const noteKey = web || browserFull ? null : dockKey(bot?.id, tab, !!watching);
  const [noteDockAt, setNoteDockAt] = useState<string | null>(null);
  const noteOpen = dockShown(noteDockAt, noteKey);
  const noteDocked = noteOpen && floatMemory.note.docked;
  useEffect(() => { setNoteDockAt((open) => keepDock(open, noteKey)); }, [noteKey]);
  const openNoteChat = useCallback((open: boolean) => {
    if (open === noteOpen) return;
    setNoteDockAt((now) => toggleDock(now, noteKey));
  }, [noteOpen, noteKey]);
  const noteArea = useCallback(() => document.querySelector<HTMLElement>(".chat-column .main-tab"), []);
  // A plugin frame's `ccb.composer.insertQuote` (the Note's "ask about this block", composer-quote.ts): the text goes into
  // the bot's input box in the chat page; to focus it while the Note fills the chat column, its floating (or docked) chat
  // opens first.
  const quoteNow = useRef({ botId: bot?.id ?? null, noteKey, noteOpen, openNoteChat });
  quoteNow.current = { botId: bot?.id ?? null, noteKey, noteOpen, openNoteChat };
  useEffect(() => setComposerQuoter(async (botId, text, focus) => {
    const now = quoteNow.current;
    const opening = focus && !!now.noteKey && now.botId === botId && !now.noteOpen;
    if (opening) now.openNoteChat(true);
    const inserted = await askChatToQuote(postToChat, botId, text, focus);
    // Opening the chat focuses its input box once it has its place; already open, it is focused here.
    if (inserted && focus && !opening) focusComposer();
    return inserted;
  }), []);
  // Open: the input box gets the focus once the chat has its place; Esc (in the app's own page) closes it.
  useEffect(() => {
    if (!noteOpen) return;
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => focusComposer()); });
    const settle = setTimeout(focusComposer, 120);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || shellOverlayActive()) return;
      event.preventDefault();
      setNoteDockAt(null);
    };
    window.addEventListener("keydown", onKey);
    return () => { cancelAnimationFrame(frame); clearTimeout(settle); window.removeEventListener("keydown", onKey); };
  }, [noteOpen]);
  const rightFolded = collapsed || (paneOpen && !rightWithPane);
  const toggleRightHere = useCallback(() => {
    if (!paneOpen) { toggleRight(); return; }
    if (rightFolded) { setRightWithPane(true); if (collapsed) toggleRight(); } else setRightWithPane(false);
  }, [paneOpen, rightFolded, collapsed, toggleRight]);

  // Reading a chat clears its unread count.
  useEffect(() => {
    if (bot && bot.unread > 0) void client.request({ type: "chat.read", botId: bot.id }).catch(() => {});
  }, [client, bot]);

  // The regions of the page that are slots of the shell (shell/regions.tsx): drawn where the page places its `<RegionSlot>`.
  const bottomRegion = web ? null : (
    <BottomPanels client={client} panels={view.plugins?.bottomPanels ?? []} toggleHost={bottomControls} onHide={focusComposer} botId={bot?.id} botIds={view.bots.map(b => b.id)}
      shortcutFor={(command) => (command && pluginKeys[command] ? formatCombo(pluginKeys[command]!, shellPlatform()) : "")} onBuiltin={runBuiltin} onKey={forwardKey} components={view.components} bots={view.bots} ask={approval.ask} />
  );
  const sideRegion = (
    <>
    {bot && takeover && takeoverView && (
      <TakeoverPage key={`${takeover.plugin}/${takeover.view}/${bot.id}`} client={client} plugin={takeover.plugin} view={takeover.view} title={takeoverView.title} wide={takeover.wide} botId={bot.id}
        plugins={view.plugins} onError={fail} onAsk={approval.ask} />
    )}
    {bot && !(takeover && takeoverView) && (
      <TaskDetails
        onDrawerSettings={() => setBotSettings(true)}
        bot={bot} bots={view.bots} waiting={view.waiting} look={view.settings?.botLook ?? "original"}
        status={{ key: status(bot), text: statusText(bot) }}
        results={results} watching={watching} collapsed={rightFolded}
        onSelect={selectBot}
        onIgnore={(item) => void client.request(item.messageId ? { type: "chat.ignoreQuestion", botId: item.botId, messageId: item.messageId } : { type: "waiting.ignore", botId: item.botId, text: item.text }).catch(fail)}
        onOpenResult={openResult}
        onOpenSubagent={(row) => openSubagent(bot.id, row)}
        onUnsettle={(row) => settleSubagent(bot.id, row, false)}
        onAgentMenu={(row, at) => openAgentMenu(bot.id, row, at)}
        onSettings={openBotSettings}
        showingSettings={botSettings}
        settingsPage={botSettings ? <BotSettings client={client} bot={bot} settings={view.settings} onOpenAppSettings={() => openSettings("models")} /> : undefined}
        pluginSections={rightPanelSectionsFor(view.plugins, bot).map((block) => <SlotFrame key={`${bot.id}/${block.plugin}/${block.id}`} client={client} plugin={block.plugin} view={block.id} title={block.title} fontSize={13} botId={bot.id} onBuiltin={runBuiltin} />)}
        onCloseSettings={() => setBotSettings(false)}
        onExpand={toggleRightHere}
      />
    )}
    </>
  );

  // The parts of the chat column that the shell's fallback screen keeps when `botling.chat` is away (shell/Fallback.tsx, M7-07c): drawn in the column below, and
  // handed to the fallback as `regions.away.parts`, so the tab switch (Storage stays reachable), the alert lines, the worker bar and the error bar go on without the plugin.
  const bottomControlsSlot = !web ? <span className="bottom-controls" ref={setBottomControls} /> : null;
  // The Chat / tabs switch (1.x's BoardSwitch bar): its own centered bar above the messages.
  const switchBar = bot && chat && !watching ? (
    <div className="board-switch-bar">
      <span className="workers-badge-slot">
        <WorkersBadge bot={bot} bots={view.bots} seen={seenFailed} on={workersMenu === bot.id} onClick={() => setWorkersMenu(workersMenu === bot.id ? null : bot.id)} />
        {workersMenu === bot.id && <WorkersMenu bot={bot} bots={view.bots} onClose={() => setWorkersMenu(null)} onOpen={(ownerId, row) => { setWorkersMenu(null); openSubagent(ownerId, row); }} />}
      </span>
      {/* Navigation v5: sub bots left of the switch; the workers' badge sits at the right. */}
      <div className="board-switch-left">
        <SubBotNav nav={nav} open={subBotsOpen} onOpenChange={setSubBotsOpen} onOpen={selectBot}
          flash={!!cameFrom && !!cameBack?.flash} forward={cameFrom ? { name: cameFrom.name } : null}
          keys={{ menu: shortcutLabel("subBots"), back: shortcutLabel("roomBack"), forward: shortcutLabel("roomForward") }}
          pinned={pinnedSubBots} pinKeys={PINNED_KEYS.map((id) => shortcutLabel(id))}
          onPin={(botId) => setPinnedSubBots((now) => togglePinned(now, botId))} onMovePin={(botId, to) => setPinnedSubBots((now) => movePinned(now, botId, to))}
          canAdd={bot.role === "manager" && !bot.parent}
          onNew={(name, purpose) => newSubBot(bot.parent ?? bot.id, name, purpose)}
          onArchive={(botId) => { const target = view.bots.find((candidate) => candidate.id === botId); if (target) setClosingSubBot(target); }} />
      </div>
      <div className="board-switch" role="group" aria-label="Chat views">
        <button type="button" aria-pressed={!tab && !storageOn} onClick={() => { setWhiteboardOn(false); chooseTab(bot.id, null); }}><Icon name="bubble" size={13} />Chat</button>
        {tabs.map((candidate) => (
          <button key={tabKey(candidate)} type="button" className={`main-tab-switch${candidate === boardTab ? " whiteboard-switch" : ""}`} data-tab={tabKey(candidate)} aria-pressed={tab === candidate}
            onClick={() => { setWhiteboardOn(candidate === boardTab); chooseTab(bot.id, candidate); }}>
            {candidate.icon && isIconName(candidate.icon) && <Icon name={candidate.icon} size={13} />}{candidate.title}
          </button>
        ))}
        {!web && <button type="button" className="main-tab-switch storage-switch" data-tab={STORAGE_TAB} aria-pressed={storageOn}
          onClick={() => { setWhiteboardOn(false); chooseTab(bot.id, STORAGE_TAB); }}><Icon name="tray" size={13} />{say(view.settings?.effectiveLanguage, "storage.tab")}</button>}
      </div>
    </div>
  ) : null;
  const alerts = (
    <>
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
    </>
  );
  const workerBar = bot && shownWorker && view.subagent ? (
    <WorkerAskBar key={shownWorker.id} owner={bot} worker={shownWorker} files={filesChanged(view.subagent.steps)} onAsk={askOwner}
      onOpenFile={(path) => { void client.request({ type: "worker.file", botId: bot.id, subagentId: shownWorker.id, path }).catch(fail); }} />
  ) : null;
  const storagePage = storageOn && bot ? (
    <div className="main-tab storage-main" role="region" aria-label={say(view.settings?.effectiveLanguage, "storage.tab")}>
      <StorageTab key={bot.id} client={client} botId={bot.id} botName={bot.name} lang={view.settings?.effectiveLanguage} onError={fail} />
    </div>
  ) : null;
  const errorBar = error && error !== bot?.problem ? <div className="banner bottom" role="alert">{error}</div> : null;

  // The chat column (header, Chat / tab / Storage switch, the tab or Storage page, the chat frame): `botling.chat`'s contribution to `app/main`.
  const mainRegion = (
    <section className="chat-pane">
      <div className={`chat-column${tab || storageOn ? " main-tab-on" : ""}`}>
      <header className="chat-header drag">
        {web?.headerLead}
        {bot && <span className="chat-title">{bot.parent ? <SubBotTitle bot={bot} parent={view.bots.find((candidate) => candidate.id === bot.parent) ?? null} onOpenParent={selectBot} /> : bot.name}</span>}
        {bot && bot.heads.length > 0 && (
          <span className="chat-heads" data-heads={bot.heads.join(" ")}>{bot.heads.map((head) => ({ claude: "Claude", codex: "Codex", agy: "Antigravity" }[head])).join(" & ")}</span>
        )}
        {bot && <span className="chat-status" data-status={status(bot)}>{statusText(bot)}</span>}
        {bottomControlsSlot}
        {bot && chat && !web && (
          <span className="chat-actions">
            <button type="button" className={`header-button${paneOpen ? " on" : ""}`} aria-pressed={paneOpen} onClick={toggleBrowser}
              title={`${say(view.settings?.effectiveLanguage, "browser.headerHint")} (${shortcutLabel("toggleBrowser")})`}>{say(view.settings?.effectiveLanguage, "browser.header")}</button>
            <ChatHeaderViews client={client} views={view.plugins?.chatHeaderViews ?? []} botId={bot.id} onBuiltin={runBuiltin} components={view.components} bots={view.bots} ask={approval.ask} />
          </span>
        )}
      </header>
      {switchBar}
      {alerts}
      <ChatBody docked={noteDocked}>
      {tab && bot ? <MainTabFrame key={`${bot.id}/${tabKey(tab)}`} client={client} plugin={tab.plugin} view={tab.id} title={tab.title} botId={bot.id} onBuiltin={runBuiltin} components={view.components} bots={view.bots} ask={approval.ask}
        overlay={noteKey ? <FloatingChat place="note" bot={bot} look={view.settings?.botLook ?? "original"} open={noteOpen} onOpen={openNoteChat} line={stripLine} area={noteArea} /> : null} />
        : storagePage}
      {/* Under a plugin's tab the chat page stays loaded (hidden), so going back to Chat is instant. */}
      <ChatFrame client={client} store={store} onError={fail} onSent={() => setError(null)} onAsk={approval.ask}
        onOpenChat={(botId, messageId) => runBuiltin("page", { id: "botling.openChat", botId, ...(messageId ? { messageId } : {}) })}
        bubbleBot={bot && !paneOpen && (!(tab || storageOn) || noteDocked || !floatMemory.preview.docked) ? bot : null} look={view.settings?.botLook ?? "original"} stripLine={stripLine}
        askAbout={askAbout} onAskDone={() => setAskAbout(null)} />
      </ChatBody>
      {workerBar}
      {/* The bottom panels: drawn from `app/bottom` (shell/regions.tsx), where the page hands them in (`regions.bottom`). */}
      <RegionSlot region="bottom" />
      </div>
      {errorBar}
    </section>
  );

  return <ShellFrame plugins={view.plugins} client={client} regions={{ main: mainRegion, side: sideRegion, bottom: bottomRegion, away: { source: { client, store }, parts: { lead: web?.headerLead, header: bottomControlsSlot, bar: switchBar, alerts, page: storagePage, worker: workerBar, error: errorBar } } }} inline={[RAIL_SLOT]} legacy={(
    <div className={`shell${paneOpen ? " browser-on" : ""}${browserFull ? " browser-full" : ""}${browserDocked ? " browser-mini" : ""}${browserFloat ? " browser-float" : ""}`} data-ready={view.ready ? "1" : "0"}>
      {/* A panel a plugin's program part opened (`ui.openView`). */}
      {!web && view.pluginPanel && (
        <PanelFrame key={`${view.pluginPanel.plugin}/${view.pluginPanel.panel}`} client={client} plugin={view.pluginPanel.plugin} panel={view.pluginPanel.panel}
          title={view.pluginPanel.title} onClose={() => store.closePluginPanel()} onBuiltin={runBuiltin} components={view.components} bots={view.bots} ask={approval.ask} />
      )}
      {/* The left column: the sidebar plugin's contribution to `app/rail` (SidebarRail.tsx), drawn here, inside the page's own layout. */}
      <RailSlot value={{
        client, view, web, now, collapsed: railCollapsed, pinned, idle, chatBotId: chat?.botId ?? null, bot, watching,
        query, setQuery, search, makingBot, setMakingBot, creating, viewedWorkers, settingsOpen,
        onOpenSettings: openSettings, onCreateBot: createBot, onSelectBot: selectBot, onAddProject: addProject, onToggleRail: toggleRail, onTogglePin: togglePin, onSetIdle: setIdle,
        onMenu: (candidate, x, y) => setMenu({ bot: candidate, x, y }), onOpenSubagent: openSubagent, onSettleSubagent: settleSubagent,
        onAsked: () => { const maintainer = store.getView().bots.find(isMaintainer); if (maintainer) void store.select(maintainer.id); },
        onShowMain: () => { const main = view.bots.find((one) => one.role === "main"); if (main) void store.select(main.id); },
      }} />
      {!railCollapsed && <ColumnDivider column="rail" />}
      {/* The chat column: botling.chat's contribution to `app/main` (shell/regions.tsx), handed in as `regions.main`. */}
      <RegionSlot region="main" />
      {paneOpen && bot && !browserFull && <ColumnDivider column="browser" />}
      {paneOpen && bot && (
        <BrowserPane bot={bot} state={browserState ?? { botId: bot.id, tabs: [], active: null }} full={browserFull} look={view.settings?.botLook ?? "original"}
          miniChat={miniChat} onMiniChat={setMiniChat} line={stripLine} layoutKey={`${railCollapsed}/${rightFolded}/${!!takeover}/${floatMemory.browser.docked}`}
          onAskTool={async (text) => { await client.request({ type: "chat.send", botId: bot.id, text }); }}
          tabActions={browserTabActions(browserPlugins(view.plugins), browserTabAddress(browserState?.tabs.find((candidate) => candidate.id === browserState.active) ?? browserState?.tabs[0]), view.settings?.effectiveLanguage)
            .map((action) => ({ ...action, icon: action.icon && isIconName(action.icon) ? <Icon name={action.icon} size={15} /> : undefined }))}
          onTabAction={(command, tab) => { void client.request({ type: "plugins.tabCommand", id: command, botId: bot.id, tabId: tab.id, url: browserTabAddress(tab) ?? tab.url }).catch(fail); }} />
      )}
      {/* The right panel (or a takeover in its place): the column of botling.bot-panel's `app/side` (shell/regions.tsx), handed in as `regions.side`. */}
      <RegionSlot region="side" />
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
      {settingsOpen && <SettingsSheet client={client} settings={view.settings} bot={bot} bots={view.bots} plugins={view.plugins} initialSection={settingsSection} onClose={() => setSettingsOpen(false)}
        onOpenBot={(botId) => { if (botId === bot?.id) openBotSettings(); else { openingBotSettings.current = botId; if (collapsed) toggleRight(); selectBot(botId); } }} />}
    </div>
  )} />;
}

export { railOrder } from "./rail-idle";
