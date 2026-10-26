// The app page: React chrome around the reused chat page. The left column lists the bots (as the
// Swift app's sidebar); the chat area hosts Web/src's chat page in a same-origin frame
// (chat-frame/), fed with the state ChatPayload.swift would build (payload.ts). The frame posts
// what the user does (send, a pick on an approval, Stop); this page turns that into contract
// commands. Only this page has the bridge to main.
import { inputTrace } from "./input-trace";
import { TEST_TRACE_QUERY } from "../test-trace";
import { UpdateBanner } from "./Updates";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { MAINTAINER_BOT_ID, resultLinks, type BotView, type ResultOf, type ResultView, type SubagentRowView } from "../contract";
import { Client, RequestFailed } from "./client";
import { WorkspaceStore } from "./store";
import { chatState, subagentState } from "./payload";
import { faceURL } from "./avatars";
import { CHAT_ORIGIN, CHAT_PAGE, type FrameMessage, type ShellMessage } from "./chat-frame/protocol";
import { PluginsButton } from "./Plugins";
import { SettingsSheet, type SettingsSection } from "./Settings";
import { SidebarSettings } from "./SidebarSettings";
import { RightPanel, RightToggle } from "./RightPanel";
import { BotMenu, DeleteGroupDialog, GroupFace, GroupForm, GroupRow, NewBotForm, RemoveDialog, SubagentRows, useMinuteClock } from "./Rail";
import { Icon } from "./icons";
import { WebPane, WebPanel, WebRail } from "./Web";
import { SpecFrame } from "./SpecFrame";

export function App({ client, store }: { client: Client; store: WorkspaceStore }) {
  const view = useSyncExternalStore(store.subscribe, store.getView);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const openSettings = useCallback((section: SettingsSection = "general") => { setSettingsSection(section); setSettingsOpen(true); }, []);
  /** The web AI shown in the chat column instead of a chat, if one is. */
  const [webSite, setWebSite] = useState<string | null>(null);
  const site = webSite ? view.web?.sites.find((candidate) => candidate.id === webSite) ?? null : null;
  /** The New bot form, a row's menu, and the bot being asked about before it is removed. */
  const [makingBot, setMakingBot] = useState(false);
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState<{ bot: BotView; x: number; y: number } | null>(null);
  const [removing, setRemoving] = useState<BotView | null>(null);
  /** The group being made (null: a new one) or changed, and the one being asked about before it is deleted. */
  const [editingGroup, setEditingGroup] = useState<{ group: BotView | null } | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<BotView | null>(null);
  /** The task card pressed open in the right panel (`selectedTask`); pressed again, it closes. */
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const selectTask = useCallback((id: string) => setSelectedTask((current) => (current === id ? null : id)), []);
  const now = useMinuteClock();
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
  // ⌘, (Ctrl+, elsewhere) opens Settings, as in 1.x; ⌃⌘I folds or opens the right panel; ⌃⌘S the left column; ⌘K searches it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "," && (event.metaKey || event.ctrlKey)) { event.preventDefault(); openSettings(); }
      if ((event.key === "i" || event.key === "I") && event.metaKey && event.ctrlKey) { event.preventDefault(); toggleRight(); }
      if ((event.key === "s" || event.key === "S") && event.metaKey && event.ctrlKey) { event.preventDefault(); toggleRail(); }
      if ((event.key === "k" || event.key === "K") && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) { event.preventDefault(); startSearch(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSettings, toggleRight, toggleRail, startSearch]);
  const chat = view.chat;
  const results = useMemo<ResultView[]>(() => (chat ? resultLinks(chat.messages) : []), [chat]);
  // The spec open in the right panel, when it is made from a line of the chat on screen.
  const openSpec = view.spec && chat?.messages.some((message) => message.specs?.some((chip) => chip.id === view.spec!.id)) ? view.spec : null;
  const watching = view.subagent?.id ?? null;
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

  // A subagent's row (left column or Settled): its conversation in the chat's place (its bot's chat first).
  const openSubagent = useCallback((botId: string, row: Pick<SubagentRowView, "id">) => {
    setError(null);
    const show = () => client.request({ type: "subagent.view", botId, subagentId: row.id })
      .then((result) => { if (store.getView().chat?.botId === botId) store.watch(result.subagent); }, fail);
    if (webSite) { setWebSite(null); void client.request({ type: "web.leave" }).catch(() => {}); }
    if (store.getView().chat?.botId === botId) void show();
    else void store.select(botId).then(show);
  }, [client, store, fail, webSite]);
  const settleSubagent = useCallback((botId: string, row: SubagentRowView, settled: boolean) => {
    void client.request({ type: "subagent.settle", botId, subagentId: row.id, settled }).catch(fail);
  }, [client, fail]);

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

  // Group chats: made (and shown), changed, deleted with their conversation.
  const saveGroup = useCallback((made: { name: string; members: string[] } | null) => {
    const editing = editingGroup;
    setEditingGroup(null);
    if (!made || !editing) return;
    setError(null);
    if (editing.group) void client.request({ type: "groups.edit", groupId: editing.group.id, name: made.name.slice(0, 400), members: made.members }).catch(fail);
    else void client.request({ type: "groups.create", name: made.name.slice(0, 400), members: made.members }).then((result) => { void store.select(result.groupId); }, fail);
  }, [client, store, fail, editingGroup]);
  const deleteGroup = useCallback((target: BotView) => {
    setDeletingGroup(null);
    setError(null);
    void client.request({ type: "groups.delete", groupId: target.id }).catch(fail);
  }, [client, fail]);

  // A result opens in the browser or with its own app; main checks it is one of this chat's links.
  const openResult = useCallback((result: ResultView) => {
    if (!chat) return;
    setError(null);
    void client.request({ type: "result.open", botId: chat.botId, url: result.url }).catch(fail);
  }, [client, chat, fail]);

  useEffect(() => { setSelectedTask(null); }, [chat?.botId]);

  // Reading a chat clears its unread count.
  useEffect(() => {
    if (bot && bot.unread > 0) void client.request({ type: "chat.read", botId: bot.id }).catch(() => {});
  }, [client, bot]);

  return (
    <div className="shell" data-ready={view.ready ? "1" : "0"}>
      {railCollapsed ? (
        <RailStrip bots={view.bots} pinned={pinned} look={view.settings?.botLook ?? "original"} shown={!site && !watching ? chat?.botId ?? null : null}
          waiting={(id) => view.waiting.items.some((item) => item.botId === id)}
          onSelect={selectBot} onMenu={(candidate, x, y) => setMenu({ bot: candidate, x, y })}
          onExpand={() => toggleRail(false)} onAddProject={addProject} onNewBot={() => { toggleRail(false); setMakingBot(true); }} onNewGroup={() => setEditingGroup({ group: null })}
          settingsControl={<SidebarSettings compact client={client} settings={view.settings} plugins={view.plugins} settingsOpen={settingsOpen} onOpen={openSettings} />} />
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
          {!query && <span className="rail-search-key" aria-hidden="true">⌘K</span>}
        </div>
        <nav className="bots" aria-label="Bots">
          {query.trim() ? (() => {
            const hits = searchHits(view.bots, pinned, query);
            if (!hits.length) return <div className="rail-empty">No bots match</div>;
            return hits.map((candidate) => (
              <div key={candidate.id} className="bot-entry">
                {candidate.role === "group" ? (
                  <GroupRow group={candidate} bots={view.bots} selected={!site && candidate.id === chat?.botId && !watching} waiting={view.waiting.items.some((item) => item.groupId === candidate.id)}
                    onSelect={() => { selectBot(candidate.id); setQuery(""); focusComposer(); }} onMenu={(x, y) => setMenu({ bot: candidate, x, y })} />
                ) : (
                  <BotRow bot={candidate} look={view.settings?.botLook ?? "original"} selected={!site && candidate.id === chat?.botId && !watching}
                    waiting={view.waiting.items.some((item) => item.botId === candidate.id)}
                    onSelect={() => { selectBot(candidate.id); setQuery(""); focusComposer(); }} />
                )}
              </div>
            ));
          })() : (
            <>
              {railOrder(view.bots, pinned).map(({ bot: candidate, section }) => (
                <div key={candidate.id} className="bot-entry">
                  {section === "pinned" && <h4 className="rail-section">Pinned</h4>}
                  {section === "rest" && pinned.length > 0 && <div className="rail-rule" />}
                  {candidate.role === "group" ? (
                    <GroupRow group={candidate} bots={view.bots} selected={!site && candidate.id === chat?.botId && !watching} waiting={view.waiting.items.some((item) => item.groupId === candidate.id)}
                      onSelect={() => selectBot(candidate.id)} onMenu={(x, y) => setMenu({ bot: candidate, x, y })} />
                  ) : <BotRow
                    bot={candidate}
                    look={view.settings?.botLook ?? "original"}
                    selected={!site && candidate.id === chat?.botId && !watching}
                    waiting={view.waiting.items.some((item) => item.botId === candidate.id)}
                    onSelect={() => selectBot(candidate.id)}
                    pinned={candidate.role !== "main" && candidate.id !== MAINTAINER_BOT_ID ? pinned.includes(candidate.id) : undefined}
                    onTogglePin={() => togglePin(candidate.id)}
                    onMenu={candidate.role !== "main" && candidate.id !== MAINTAINER_BOT_ID ? (x, y) => setMenu({ bot: candidate, x, y }) : undefined}
                  />}
                  <SubagentRows bot={candidate} look={view.settings?.botLook ?? "original"} now={now} watching={chat?.botId === candidate.id ? watching : null}
                    onOpen={(row) => openSubagent(candidate.id, row)} onSettle={(row) => settleSubagent(candidate.id, row, true)} />
                </div>
              ))}
              {view.web && view.web.sites.length > 0 && (
                <WebRail web={view.web} shown={site?.id ?? null} onOpen={openWeb}
                  onSettle={(siteId, conversationId) => void client.request({ type: "web.settle", site: siteId, conversationId }).catch(fail)} />
              )}
            </>
          )}
        </nav>
        {makingBot && <NewBotForm onDone={createBot} busy={creating} />}
        <div className="rail-add">
          <button type="button" className="rail-button" onClick={addProject}><Icon name="plus" size={13} />Add project</button>
          <button type="button" className={`rail-button new-bot-button${makingBot ? " on" : ""}`} onClick={() => setMakingBot(!makingBot)}
            title="A bot of its own, with its own memory and routines (a morning news bot, say)"><Icon name="sparkles" size={13} />New bot</button>
          <button type="button" className="rail-button new-group-button" onClick={() => setEditingGroup({ group: null })}
            title="A group chat with some of your bots"><Icon name="plus" size={13} />New group</button>
        </div>
        <PluginsButton client={client} plugins={view.plugins} />
        <div className="rail-settings">
          <SidebarSettings client={client} settings={view.settings} plugins={view.plugins} settingsOpen={settingsOpen} onOpen={openSettings} />
        </div>
      </aside>
      )}
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
              {bot.role !== "group" && <RoutinesButton client={client} botId={bot.id} />}
            </span>
          )}
        </header>
        {bot && chat && !watching && (
          // 1.x's BoardSwitch: its own centered bar above the messages, even with no pins.
          <div className="board-switch-bar">
            <div className="board-switch" role="group" aria-label="Chat or Board">
              <button type="button" aria-pressed={!view.board} onClick={() => store.showBoard(false)}><Icon name="bubble" size={13} />Chat</button>
              <button type="button" aria-pressed={view.board} onClick={() => store.showBoard(true)}><Icon name="grid" size={13} />Board</button>
            </div>
          </div>
        )}
        <UpdateBanner client={client} enabled={view.settings?.updateCheck} />
        {bot?.problem && <div className="banner" role="alert">{bot.problem}</div>}
        {bot && chat?.heads?.rounds && (
          // The rounds line over the input box (1.x: "Review round 1 of 2 · Stop now"). The chat page
          // in this checkout gets the same data (`rounds`, `handoffs`) but does not draw it.
          <div className="rounds-bar" role="status">
            <span>{chat.heads.rounds.text}</span>
            <button type="button" onClick={() => void client.request({ type: "rounds.stop", botId: bot.id }).catch(fail)}>Stop now</button>
          </div>
        )}
        <ChatFrame client={client} store={store} onError={fail} onSent={() => setError(null)} onSelectTask={selectTask} />
        </div>
        {error && error !== bot?.problem && <div className="banner bottom" role="alert">{error}</div>}
      </section>
      {site && (
        <WebPanel site={site} onOpen={(conversationId) => openWeb(site.id, conversationId)} onAsk={(conversationId) => askMainBot(site.id, conversationId)}
          onNew={() => void client.request({ type: "web.new", site: site.id }).catch(fail)} />
      )}
      {/* The open component spec takes the right panel's place, while its chat is shown (1.x's `openSpec(in:)`). */}
      {bot && !site && openSpec && <SpecFrame client={client} spec={openSpec} lang={view.settings?.effectiveLanguage ?? null} onError={fail} />}
      {bot && !site && !openSpec && (
        <RightPanel
          bot={bot} bots={view.bots} waiting={view.waiting} look={view.settings?.botLook ?? "original"}
          status={{ key: status(bot), text: statusText(bot) }}
          results={results} teams={view.teams} watching={watching} collapsed={collapsed}
          tasks={chat?.botId === bot.id ? chat.tasks ?? [] : []} messages={chat?.botId === bot.id ? chat.messages : []}
          summarized={chat?.botId === bot.id ? new Set([...(chat.catchUp?.ids ?? []), ...(chat.intervalSummaries ?? []).flatMap((summary) => summary.ids)]) : undefined}
          selectedTask={selectedTask} onSelectTask={selectTask}
          onCompleteTask={(taskId) => void client.request({ type: "task.complete", botId: bot.id, taskId }).catch(fail)}
          onJumpToTask={(messageId, taskId) => {
            const target = (document.getElementById("chat-frame") as HTMLIFrameElement | null)?.contentWindow;
            const message: ShellMessage = { botling: "jumpToTask", messageID: messageId, taskID: taskId };
            target?.postMessage(message, CHAT_ORIGIN);
          }}
          onEditGroup={() => setEditingGroup({ group: bot })}
          onAskForReport={(task, replyTo) => {
            // "Ask it to report" (`askForReport`): a short message of yours to the task's owner, on the task's card.
            const two = bot.heads.length > 1;
            void client.request({ type: "chat.send", botId: bot.id, text: `How is "${task.name}" going? Please report where it stands.`,
              ...(replyTo ? { replyTo } : {}), ...(two && task.owner ? { to: task.owner } : {}) }).catch(fail);
          }}
          onSelect={selectBot}
          onIgnore={(item) => void client.request({ type: "waiting.ignore", botId: item.botId, text: item.text }).catch(fail)}
          onOpenResult={openResult}
          onOpenSubagent={(row) => openSubagent(bot.id, row)}
          onUnsettle={(row) => settleSubagent(bot.id, row, false)}
          onSettings={() => openSettings()}
          onExpand={toggleRight}
        />
      )}
      {bot && !site && !openSpec && <RightToggle collapsed={collapsed} onToggle={toggleRight} />}
      {menu && <BotMenu bot={menu.bot} at={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)}
        onRemove={() => { if (menu.bot.role === "group") setDeletingGroup(menu.bot); else setRemoving(menu.bot); setMenu(null); }}
        pinned={pinned.includes(menu.bot.id)} onTogglePin={() => { togglePin(menu.bot.id); setMenu(null); }}
        onEditGroup={() => { setEditingGroup({ group: menu.bot }); setMenu(null); }} />}
      {editingGroup && <GroupForm group={editingGroup.group} bots={view.bots} look={view.settings?.botLook ?? "original"} onDone={saveGroup}
        faceOf={(candidate) => faceURL(candidate, view.settings?.botLook ?? "original", {})} />}
      {deletingGroup && <DeleteGroupDialog group={deletingGroup} onCancel={() => setDeletingGroup(null)} onDelete={() => deleteGroup(deletingGroup)} />}
      {removing && <RemoveDialog bot={removing} onCancel={() => setRemoving(null)} onRemove={() => removeBot(removing)} />}
      {settingsOpen && <SettingsSheet client={client} settings={view.settings} bot={bot} bots={view.bots} plugins={view.plugins} initialSection={settingsSection} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function status(bot: BotView): string {
  if (bot.working) return "working";
  if (bot.approvals) return "waiting";
  return bot.phase;
}

function statusText(bot: BotView): string {
  if (bot.role === "group") return `${bot.members?.length ?? 0} bot${bot.members?.length === 1 ? "" : "s"}`;
  if (bot.working && bot.approvals) return "Waiting for your answer";
  if (bot.working) return "Writing…";
  if (bot.phase === "tidying") return "Tidying its notes…";
  if (bot.phase === "switching") return "Writing handoff";
  if (bot.subagents) return `${bot.subagents} subagent${bot.subagents === 1 ? "" : "s"} at work`;
  if (bot.phase === "awake") return "Awake";
  return "Asleep";
}

export function BotRow({ bot, selected, onSelect, look, waiting, onMenu, pinned, onTogglePin }: {
  bot: BotView; selected: boolean; onSelect: () => void; look: "original" | "cute"; waiting: boolean; onMenu?: (x: number, y: number) => void;
  /** Undefined for a row that cannot be pinned (the main bot, Maintainer). */
  pinned?: boolean; onTogglePin?: () => void;
}) {
  const asleep = bot.phase === "asleep" && !bot.working;
  const tasks = bot.openTasks ?? 0;
  const label = [bot.name, statusText(bot), bot.approvals ? `${bot.approvals} waiting on you` : waiting ? "waiting on you" : null, bot.unread && !selected ? `${bot.unread} unread` : null,
    tasks ? `${tasks} task${tasks === 1 ? "" : "s"} under way` : null, pinned ? "pinned" : null].filter(Boolean).join(", ");
  return (
    <div className={`bot-row-wrap${pinned !== undefined ? " pinnable" : ""}`}>
      <button className={`bot-row${selected ? " selected" : ""}${asleep ? " asleep" : ""}`} data-bot={bot.id} aria-current={selected ? "page" : undefined} aria-label={label} onClick={onSelect}
        onContextMenu={onMenu ? (event) => { event.preventDefault(); onMenu(event.clientX, event.clientY); } : undefined}>
        <img className="bot-avatar" src={faceURL(bot, look, { asleep, working: bot.working, waiting: bot.approvals > 0 })} alt="" />
        <span className={`bot-name${bot.role === "main" ? " main" : ""}`}>{bot.name}</span>
        <span className="bot-gap" />
        {tasks > 0 && <span className="task-count" aria-hidden="true">{tasks} task{tasks === 1 ? "" : "s"}</span>}
        {bot.working && <span className="bot-dot working" aria-hidden="true" />}
        {bot.approvals > 0 && <span className="badge waiting" aria-hidden="true">{bot.approvals}</span>}
        {bot.unread > 0 && !selected && <span className="badge" aria-hidden="true">{bot.unread}</span>}
      </button>
      {pinned !== undefined && onTogglePin && (
        // The pin glyph at the row's end while the pointer is on it (1.x's BotRow).
        <button type="button" className={`bot-pin${pinned ? " on" : ""}`} onClick={onTogglePin} title={pinned ? "Unpin" : "Pin to the top"} aria-label={pinned ? `Unpin ${bot.name}` : `Pin ${bot.name}`}>
          <Icon name={pinned ? "pinSlash" : "pin"} size={12} />
        </button>
      )}
    </div>
  );
}

/**
 * The left column's rows (1.x's RailView): the main bot and Maintainer, then the pinned ones in the order
 * they were pinned, then the rest — groups, projects and bots together — the one with the newest line
 * first, as in Messages (`entries`, `RailLayout.pinnedFirst`).
 */
export function railOrder(bots: BotView[], pinned: string[]): { bot: BotView; section: "main" | "pinned" | "rest" | null }[] {
  const main = bots.filter((bot) => bot.role === "main" || bot.id === MAINTAINER_BOT_ID).sort((a, b) => (a.role === "main" ? -1 : b.role === "main" ? 1 : 0));
  const top = pinned.map((id) => bots.find((bot) => bot.id === id && bot.role !== "main" && bot.id !== MAINTAINER_BOT_ID)).filter((bot): bot is BotView => !!bot);
  const when = (bot: BotView) => (bot.lastActivity ? Date.parse(bot.lastActivity) : -Infinity);
  const rest = bots.map((bot, offset) => ({ bot, offset }))
    .filter(({ bot }) => bot.role !== "main" && bot.id !== MAINTAINER_BOT_ID && !pinned.includes(bot.id))
    .sort((a, b) => when(b.bot) - when(a.bot) || a.offset - b.offset).map(({ bot }) => bot);
  return [
    ...main.map((bot) => ({ bot, section: null })),
    ...top.map((bot, index) => ({ bot, section: index === 0 ? "pinned" as const : null })),
    ...rest.map((bot, index) => ({ bot, section: index === 0 ? "rest" as const : null })),
  ];
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
  const target = (document.getElementById("chat-frame") as HTMLIFrameElement | null)?.contentWindow;
  if (!target) return;
  target.focus();
  const message: ShellMessage = { botling: "focus" };
  target.postMessage(message, CHAT_ORIGIN);
}

/** The button that folds the left column into a strip of faces and opens it again (1.x's RailToggle, ⌃⌘S). */
function RailToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  return (
    <button type="button" className={`rail-toggle${collapsed ? "" : " on"}`} onClick={onToggle} title={`${label} (⌃⌘S)`} aria-label={label} aria-pressed={!collapsed}>
      <Icon name="sidebarLeft" size={14} />
    </button>
  );
}

/** The left column folded (1.x's RailStrip): faces only, the pinned ones first; hover for name and status. */
function RailStrip({ bots, pinned, look, shown, waiting, onSelect, onMenu, onExpand, onAddProject, onNewBot, onNewGroup, settingsControl }: {
  bots: BotView[]; pinned: string[]; look: "original" | "cute"; shown: string | null; waiting: (id: string) => boolean;
  onSelect: (id: string) => void; onMenu: (bot: BotView, x: number, y: number) => void; onExpand: () => void; onAddProject: () => void; onNewBot: () => void; onNewGroup: () => void; settingsControl: ReactNode;
}) {
  const [tip, setTip] = useState<{ bot: BotView; y: number } | null>(null);
  const [adding, setAdding] = useState(false);
  const order = railOrder(bots, pinned);
  const pinnedCount = pinned.length;
  return (
    <aside className="rail-strip" aria-label="Bots (folded)">
      <div className="rail-top drag"><RailToggle collapsed onToggle={onExpand} /></div>
      <nav className="strip-bots" aria-label="Bots">
        {order.map(({ bot }, index) => {
          const asleep = bot.phase === "asleep" && !bot.working;
          const unread = bot.unread > 0 && bot.id !== shown;
          const parts = [statusText(bot), waiting(bot.id) ? "waiting on you" : null, unread ? `${bot.unread > 99 ? "99+" : bot.unread} unread` : null].filter(Boolean);
          return (
            <div key={bot.id} className="strip-entry">
              {index === 1 && <div className="strip-rule" />}
              {pinnedCount > 0 && index === 1 + pinnedCount && <div className="strip-rule short" />}
              <button type="button" className={`strip-bot${bot.id === shown ? " selected" : ""}${asleep ? " asleep" : ""}${bot.working ? " working" : ""}`} data-bot={bot.id}
                aria-label={[bot.name, ...parts].join(", ")} onClick={() => onSelect(bot.id)}
                onMouseEnter={(event) => setTip({ bot, y: event.currentTarget.getBoundingClientRect().top + 20 })} onMouseLeave={() => setTip(null)}
                onContextMenu={bot.role !== "main" && bot.id !== MAINTAINER_BOT_ID ? (event) => { event.preventDefault(); onMenu(bot, event.clientX, event.clientY); } : undefined}>
                {bot.role === "group" ? <GroupFace size={28} /> : <img src={faceURL(bot, look, { asleep, working: bot.working, waiting: bot.approvals > 0 })} alt="" />}
                {unread && <span className="strip-unread" aria-hidden="true" />}
              </button>
            </div>
          );
        })}
      </nav>
      {tip && (
        <div className="rail-tip" role="tooltip" style={{ top: tip.y }}>
          <div className="rail-tip-title">{tip.bot.name}</div>
          <div className="rail-tip-detail">{[statusText(tip.bot), waiting(tip.bot.id) ? "waiting on you" : null, tip.bot.unread > 0 && tip.bot.id !== shown ? `${tip.bot.unread > 99 ? "99+" : tip.bot.unread} unread` : null].filter(Boolean).join(" · ")}</div>
        </div>
      )}
      <div className="strip-add">
        <button type="button" className="strip-plus" title="Add a project, a bot or a group" aria-label="Add a project, a bot or a group" aria-expanded={adding} onClick={() => setAdding(!adding)}><Icon name="plus" size={13} /></button>
        {adding && (
          <div className="strip-add-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => { setAdding(false); onAddProject(); }}>Add project…</button>
            <button type="button" role="menuitem" onClick={() => { setAdding(false); onNewBot(); }}>New bot…</button>
            <button type="button" role="menuitem" onClick={() => { setAdding(false); onNewGroup(); }}>New group…</button>
          </div>
        )}
      </div>
      {settingsControl}
    </aside>
  );
}

/** The reused chat page, in a frame. */
function ChatFrame({ client, store, onError, onSent, onSelectTask }: { client: Client; store: WorkspaceStore; onError: (failure: unknown) => void; onSent: () => void; onSelectTask: (id: string) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const widthDragging = useRef(false);
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
      lang: current.settings?.effectiveLanguage ?? null, chatAvatarSize: current.settings?.chatAvatarSize ?? null, bots: current.bots,
      // Developer mode with Botling's source among the projects: replies get "not right" (`feedback`).
      feedback: !!current.settings?.developerMode && current.bots.some((candidate) => candidate.id === current.settings?.developerProject && candidate.role === "manager"),
      // /share is offered in the input box of the developer project's chat (`offersShare`).
      share: !!current.settings?.developerMode && bot.id === current.settings?.developerProject && bot.role === "manager",
    });
    const traceId = inputTrace()?.mark("shell.state.send", () => ({ chat: state.botID, ...inputTrace()!.snapshot() }));
    const message: ShellMessage = { botling: "state", state, extras, messageColumnWidth: current.settings?.messageColumnWidth ?? null,
      ...(traceId ? { traceId } : {}) };
    target.postMessage(message, CHAT_ORIGIN);
  }, []);

  useEffect(push, [push, view, replying]);

  useEffect(() => {
    // Chromium can deliver pointerup to the shell after a captured pointer leaves its iframe.
    // Forward shell-side events in frame coordinates until the drag finishes or is cancelled.
    const widthPointer = (kind: "move" | "up" | "cancel", event?: PointerEvent) => {
      if (!widthDragging.current) return;
      const box = frame.current?.getBoundingClientRect();
      const message: ShellMessage = { botling: "messageWidthPointer", kind, pointerId: event?.pointerId ?? 0, x: (event?.clientX ?? 0) - (box?.left ?? 0) };
      frame.current?.contentWindow?.postMessage(message, CHAT_ORIGIN);
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

  // The frame owns loss detection and text input. The shell only restores its window before
  // typing, never serializes a key, and keeps explicit shell targets authoritative.
  useEffect(() => {
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
      element?.contentWindow?.postMessage(message, CHAT_ORIGIN);
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
      if (message.botling === "messageWidthDrag") {
        widthDragging.current = message.active === true;
        return;
      }
      if (message.botling === "messageWidth") {
        // The contract validates the number again in main and core; a card cannot impersonate this frame.
        void client.request({ type: "settings.set", change: { key: "messageColumnWidth", value: message.value } }).catch((failure) => {
          onError(failure);
          frame.current?.contentWindow?.postMessage({botling:"widthRejected",value:message.value,actual:store.getView().settings?.messageColumnWidth ?? null} satisfies ShellMessage, CHAT_ORIGIN);
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
        // A task chip under a reply: its card opens in the right panel.
        case "selectTask":
          if (typeof action.id === "string") onSelectTask(action.id);
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
        // A card's ⋯ menu: "Report a problem…" or a change asked of Maintainer; main adds the card's screenshot.
        case "componentReport": {
          if (!chat || typeof action.name !== "string" || typeof action.text !== "string" || !paced(`report:${action.name}`)) return;
          const images = Array.isArray(action.images) ? (action.images as unknown[]).flatMap((entry) => {
            const image = entry as { name?: unknown; base64?: unknown };
            return typeof image?.name === "string" && typeof image.base64 === "string" && image.base64 ? [{ name: image.name.slice(0, 255) || "picture.png", base64: image.base64 }] : [];
          }).slice(0, 10) : [];
          const raw = action.rect as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null | undefined;
          const box = frame.current?.getBoundingClientRect();
          const rect = raw && box && [raw.x, raw.y, raw.width, raw.height].every((value) => typeof value === "number" && Number.isFinite(value)) && (raw.width as number) > 0 && (raw.height as number) > 0
            ? { x: box.left + (raw.x as number), y: box.top + (raw.y as number), width: Math.min(raw.width as number, 10_000), height: Math.min(raw.height as number, 10_000) } : null;
          void client.request({ type: "component.report", botId: chat.botId, name: action.name.slice(0, 200), text: action.text.slice(0, 20_000), images, rect,
            problem: action.problem === true, ...(typeof action.pinID === "string" ? { pinId: action.pinID } : {}) }).catch(onError);
          return;
        }
        // A link or a component's ccb.open(url): opened as the results list opens it, main checks it is one of this chat's (Phase 5c).
        case "openExternal":
        case "openURL":
          if (chat && typeof action.url === "string" && action.url) void client.request({ type: "link.open", source: message.linkSource === "user" ? "user" : "component", ...(typeof message.linkMessageId === "string" ? {messageId:message.linkMessageId} : {}), ...(typeof message.linkPinId === "string" ? {pinId:message.linkPinId} : {}), botId: chat.botId, url: action.url.slice(0, 8_000) }).catch(onError);
          return;
        // A reply made into a component, and its spec's chip and card (Phase 5a).
        case "makeComponent":
          if (chat && typeof action.messageID === "string") {
            void client.request({ type: "spec.make", botId: chat.botId, messageId: action.messageID, ...(typeof action.purpose === "string" && action.purpose.trim() ? { purpose: action.purpose.slice(0, 4_000) } : {}),
              // One of its result pages' preview cards (Phase 5c).
              ...(typeof action.preview === "number" && Number.isInteger(action.preview) && action.preview >= 0 && action.preview <= 2 ? { preview: action.preview } : {}) }).catch(onError);
          }
          return;
        case "pressSpec":
        case "openSpec":
          if (typeof action.id === "string") void client.request({ type: "spec.act", specId: action.id, action: { kind: action.type === "pressSpec" ? "press" : "open" } }).catch(onError);
          return;
        case "specCommand":
          if (typeof action.id === "string" && typeof action.command === "string" && typeof action.folder === "string") {
            void client.request({ type: "spec.act", specId: action.id, action: { kind: "command", command: action.command, folder: action.folder,
              ...(typeof action.detail === "string" ? { detail: action.detail } : {}), ...flags(action, ["approve", "force"]) } }).catch(onError);
          }
          return;
        // "Not right" on a reply (developer mode): main adds the chat frame as you saw it.
        case "feedback": {
          if (!chat || typeof action.messageID !== "string" || typeof action.text !== "string" || !paced("feedback")) return;
          const images = Array.isArray(action.images) ? (action.images as unknown[]).flatMap((entry) => {
            const image = entry as { name?: unknown; base64?: unknown };
            return typeof image?.name === "string" && typeof image.base64 === "string" && image.base64 ? [{ name: image.name.slice(0, 255) || "picture.png", base64: image.base64 }] : [];
          }).slice(0, 10) : [];
          const box = frame.current?.getBoundingClientRect();
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
  }, [client, onError, onSent, onSelectTask, push, pushPlugins, store]);

  return <iframe id="chat-frame" ref={frame} src={inputTrace() ? `${CHAT_PAGE}?${TEST_TRACE_QUERY}=1` : CHAT_PAGE} title="Chat" />;
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
