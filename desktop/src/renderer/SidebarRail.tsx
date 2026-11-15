// The left column (Rail.tsx's parts, rail-parts.tsx's rows, RailWorkers.tsx's worker lists), moved out of App.tsx unchanged (M7-05a).
// The sidebar plugin (plugins/sidebar/index.ts) contributes `SidebarRail` to the shell's `app/rail` slot; App draws the slot where the
// column always was (inside its own layout, `RailSlot`), and hands the column what it needs through a React context: the column is a
// component of the page, so its state and its handlers are the page's, not a copy.
//   - the plugin is up: `app/rail` is drawn by KernelSlot (the plugin's entry, and any other plugin's beside it);
//   - the shell's host refused or lost the plugin: the shell's one "unavailable" line in the column's place (fail closed, as Settings);
//   - the host never touched it (a page without the shell, a component test, the first draw before the shell's host started): the
//     column is drawn directly, which is exactly the markup the slot draws (the same component).
import { createContext, useContext, useMemo, useState, useSyncExternalStore, type RefObject } from "react";
import { isMaintainer, type BotView, type SubagentRowView } from "../contract";
import type { Client } from "./client";
import type { WorkspaceView } from "./store";
import type { WebChrome } from "./app-shared";
import { Icon } from "./icons";
import { NewBotForm } from "./Rail";
import { PluginsButton } from "./Plugins";
import { RailWorkerList, type RailWorkerActions } from "./RailWorkers";
import { botCounts, canIdle, idleCounts, railSplit } from "./rail-idle";
import { BotRow, focusComposer, RailStrip, RailToggle, searchHits } from "./rail-parts";
import { railWords, railWorkers, readOpenJobs, readRailFold, readRailSince, toggleOpenJob, toggleRailFold, type RailFold, type RailMarks } from "./rail-workers";
import { rendererKernel, slotsVersion, subscribeSlots } from "./renderer-kernel";
import { inPageHost } from "./shell/inpage-host";
import { KernelSlot } from "./shell/KernelSlot";
import { shortcutLabel } from "./shortcut-labels";
import { SidebarSettings } from "./SidebarSettings";
import type { SettingsSection } from "./Settings";
import { UpdateEntry } from "./UpdateEntry";
import { RAIL_SLOT, SIDEBAR_PLUGIN } from "./sidebar-names";

/** What the column needs from the page: the page's data and its handlers (App.tsx builds it, `RailSlot` provides it). */
export interface SidebarRailProps {
  client: Client;
  view: WorkspaceView;
  web: WebChrome | undefined;
  /** The minute clock the time-based rows go by. */
  now: number;
  collapsed: boolean;
  pinned: string[];
  idle: string[];
  /** The bot whose chat is on screen, the bot (or the parent's) it belongs to for the highlight, and the worker watched (null: none). */
  chatBotId: string | null;
  bot: BotView | null;
  watching: string | null;
  query: string;
  setQuery: (query: string) => void;
  search: RefObject<HTMLInputElement | null>;
  makingBot: boolean;
  setMakingBot: (making: boolean) => void;
  creating: boolean;
  viewedWorkers: ReadonlySet<string>;
  settingsOpen: boolean;
  onOpenSettings: (section?: SettingsSection) => void;
  onCreateBot: (made: { name: string; job: string } | null) => void;
  onSelectBot: (botId: string) => void;
  onAddProject: () => void;
  onToggleRail: (collapse?: boolean) => void;
  onTogglePin: (botId: string) => void;
  onSetIdle: (botId: string, away: boolean) => void;
  onMenu: (bot: BotView, x: number, y: number) => void;
  onOpenSubagent: (botId: string, row: Pick<SubagentRowView, "id" | "subBot">) => void;
  onSettleSubagent: (botId: string, row: SubagentRowView, settled: boolean) => void;
  /** After a plugin install is asked of the maintainer, and "show the main bot" of the plugins popover. */
  onAsked: () => void;
  onShowMain: () => void;
}

export const RailContext = createContext<SidebarRailProps | null>(null);

/** The left column, from the page's context (nothing without it). */
export function SidebarRail() {
  const props = useContext(RailContext);
  return props ? <Column {...props} /> : null;
}

/** The column's place in the page: the slot while the sidebar plugin is up, the shell's "unavailable" line when it was refused or lost, else the column itself. */
export function RailSlot({ value }: { value: SidebarRailProps }) {
  const version = useSyncExternalStore(subscribeSlots, slotsVersion, slotsVersion);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const up = useMemo(() => rendererKernel.entries(RAIL_SLOT).some(({ plugin }) => plugin === SIDEBAR_PLUGIN), [version]);
  const away = !up && inPageHost.unavailable(SIDEBAR_PLUGIN);
  return (
    <RailContext.Provider value={value}>
      {up ? <KernelSlot slot={RAIL_SLOT} />
        : away ? <aside className="rail rail-unavailable"><p className="settings-hint settings-unavailable" role="status">The sidebar is unavailable.</p></aside>
        : <Column {...value} />}
    </RailContext.Provider>
  );
}

function Column(props: SidebarRailProps) {
  const { client, view, web, now, collapsed, pinned, idle, chatBotId, bot, watching, query, setQuery, search, makingBot, setMakingBot, creating, viewedWorkers, settingsOpen } = props;
  const { onOpenSettings, onCreateBot, onSelectBot, onAddProject, onToggleRail, onTogglePin, onSetIdle, onMenu, onOpenSubagent, onSettleSubagent } = props;
  const [idleOpen, setIdleOpen] = useState(false);
  // The worker list under each bot row (rail-workers.ts): the list's first start (older ones count as opened), the fold (kept across
  // restarts) and the bots whose "N more" is open (this window only).
  const [railSince] = useState(() => readRailSince(Date.now()));
  const [railFold, setRailFold] = useState<RailFold>(() => readRailFold());
  const [railAll, setRailAll] = useState<ReadonlySet<string>>(() => new Set());
  const [openJobs, setOpenJobs] = useState<ReadonlySet<string>>(() => readOpenJobs());
  const look = view.settings?.botLook ?? "original";
  if (collapsed) {
    return (
      <RailStrip bots={view.bots} pinned={pinned} idle={idle} look={look} shown={!watching ? chatBotId : null}
        waiting={(id) => view.waiting.items.some((item) => item.botId === id)}
        onSelect={onSelectBot} onMenu={onMenu}
        onExpand={() => onToggleRail(false)} onAddProject={onAddProject} onNewBot={() => { onToggleRail(false); setMakingBot(true); }}
        settingsControl={web ? null : <SidebarSettings compact client={client} settings={view.settings} plugins={view.plugins} doctor={view.doctor} settingsOpen={settingsOpen} onOpen={onOpenSettings} />} />
    );
  }
  return (
    <aside className="rail">
      <div className="rail-top drag"><RailToggle collapsed={false} onToggle={() => onToggleRail(true)} /></div>
      <div className="rail-search">
        <Icon name="search" size={13} className="rail-search-icon" />
        <input ref={search} type="search" placeholder="Search" aria-label="Search bots" value={query} onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); setQuery(""); search.current?.blur(); focusComposer(); }
            if (event.key === "Enter") { const first = searchHits(view.bots, pinned, query)[0]; if (first) { onSelectBot(first.id); setQuery(""); focusComposer(); } }
          }} />
        {!query && <span className="rail-search-key" aria-hidden="true">{shortcutLabel("search")}</span>}
      </div>
      <nav className="bots" aria-label="Bots">
        {query.trim() ? (() => {
          const hits = searchHits(view.bots, pinned, query);
          if (!hits.length) return <div className="rail-empty">No bots match</div>;
          return hits.map((candidate) => (
            <div key={candidate.id} className="bot-entry">
                <BotRow bot={candidate} look={look} selected={candidate.id === chatBotId && !watching}
                  waiting={view.waiting.items.some((item) => item.botId === candidate.id)}
                  counts={botCounts(candidate, view.bots, view.waiting, candidate.id === chatBotId && !watching)}
                  onSelect={() => { onSelectBot(candidate.id); setQuery(""); focusComposer(); }} />
            </div>
          ));
        })() : (
          <>
            {(() => {
              const split = railSplit(view.bots, pinned, idle);
              const shownId = !watching ? chatBotId : null;
              const lang = view.settings?.effectiveLanguage ?? null;
              const words = railWords(lang);
              const workerMarks: RailMarks = { viewed: viewedWorkers, since: railSince, watching: watching && chatBotId ? { botId: chatBotId, id: watching } : null,
                folded: new Set(railFold.folded), all: railAll, jobsOpen: openJobs };
              const workerActions: RailWorkerActions = {
                onOpen: onOpenSubagent,
                onSettle: (ownerId, workerRow) => onSettleSubagent(ownerId, workerRow, true),
                onAll: (key) => setRailAll((current) => { const next = new Set(current); if (!next.delete(key)) next.add(key); return next; }),
                onToggleJob: (key) => setOpenJobs(toggleOpenJob(key)),
              };
              const row = (candidate: BotView, away: boolean) => {
                const counts = botCounts(candidate, view.bots, view.waiting, candidate.id === shownId);
                const list = railWorkers(candidate, view.bots, now, workerMarks);
                return (<>
                  <BotRow
                    bot={candidate}
                    look={look}
                    selected={(candidate.id === chatBotId || (!!bot?.parent && candidate.id === bot.parent)) && !watching}
                    inside={bot?.parent === candidate.id && !watching ? bot.name : undefined}
                    waiting={view.waiting.items.some((item) => item.botId === candidate.id)}
                    counts={counts}
                    // A click opens the chat; its workers are listed under the row (no card on hover any more).
                    onSelect={() => onSelectBot(candidate.id)}
                    workers={list.total > 0 ? {
                      total: list.total, unread: list.unread, folded: list.folded, unreadTip: words.unread(list.unread),
                      label: list.folded ? words.unfold(candidate.name, list.total) : words.fold(candidate.name),
                      onToggle: () => setRailFold(toggleRailFold(candidate.id)),
                    } : undefined}
                    pinned={!away && canIdle(candidate) ? pinned.includes(candidate.id) : undefined}
                    onTogglePin={() => onTogglePin(candidate.id)}
                    idle={canIdle(candidate) ? { away, onToggle: () => onSetIdle(candidate.id, !away) } : undefined}
                    onMenu={candidate.role !== "main" && !isMaintainer(candidate) ? (x, y) => onMenu(candidate, x, y) : undefined}
                  />
                  {list.items.length > 0 && <RailWorkerList botId={candidate.id} list={list} name={candidate.name} now={now} lang={lang} actions={workerActions} />}
                </>);
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
                    aria-label={`Idle, ${idleNumbers.bots} bot${idleNumbers.bots === 1 ? "" : "s"}`}>
                    <span className={`rail-idle-chevron${idleOpen ? " open" : ""}`} aria-hidden="true"><Icon name="chevronLeft" size={11} /></span>
                    <span>Idle</span>
                    <span className="bot-gap" />
                    <span className="rail-idle-count">{idleNumbers.bots} bot{idleNumbers.bots === 1 ? "" : "s"}</span>
                  </button>
                  {idleOpen && split.idle.map((candidate) => <div key={candidate.id} className="bot-entry">{row(candidate, true)}</div>)}
                </div>}
              </>;
            })()}
          </>
        )}
      </nav>
      {web ? <div className="rail-settings web-rail-footer">{web.railFooter}</div> : <>
      {makingBot && <NewBotForm onDone={onCreateBot} busy={creating} />}
      <div className="rail-add">
        <button type="button" className="rail-button" onClick={onAddProject}><Icon name="plus" size={13} />Add project</button>
        <button type="button" className={`rail-button new-bot-button${makingBot ? " on" : ""}`} onClick={() => setMakingBot(!makingBot)}
          title="A bot of its own, with its own memory and routines (a morning news bot, say)"><Icon name="sparkles" size={13} />New bot</button>
      </div>
      <UpdateEntry client={client} />
      <PluginsButton client={client} plugins={view.plugins} bots={view.bots} lang={view.settings?.effectiveLanguage ?? null} onAsked={props.onAsked}
        onShowMain={props.onShowMain} />
      <div className="rail-settings">
        <SidebarSettings client={client} settings={view.settings} plugins={view.plugins} doctor={view.doctor} settingsOpen={settingsOpen} onOpen={onOpenSettings} />
      </div>
      </>}
    </aside>
  );
}
