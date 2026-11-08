// The right panel (1.x's DetailPanel): the bot on screen, its Now card (status; a manager's first
// "In progress" line from its memory.md) and, for the main
// bot, "Waiting on you" — every bot's open question or its memory's "Waiting on you", each opening
// that bot's chat, with × to ignore it (1.x's WaitingList). Then Results ("Just done" for the main
// bot: the links handed over in the chat, the newest three) and Settled (the subagents you settled
// out of the left column). Folded (⌃⌘I, the button at the window's top right), it is 1.x's RightStrip:
// the face with its status dot (hover for the Now card), an icon per section with a count, each
// opening that section beside the strip, and the bot's settings at the bottom. The bot's settings
// live one level in (1.x's DetailPanel `showingSettings`): the slider button on the name row, or the
// strip's bottom one, shows them in the overview's place, with Back. Navigation v5: when the room or its family
// (parent, sibling sub bots) has workers, "Details | Workers" tabs sit on top; Workers is WorkersTab.tsx.
import { shortcutLabel } from "./shortcut-labels";
import { useEffect, useState, type ReactNode } from "react";
import { ShellOverlay } from "./ShellOverlay";
import { settledRows, type BotView, type ResultView, type SubagentRowView, type WaitingItemView, type WaitingView } from "../contract";
import { avatarURL, faceURL } from "./avatars";
import { Icon, SubagentMark } from "./icons";
import { AgentMenuButton, OwnerMark } from "./Rail";
import { WorkersTab, type PanelTab, type WorkersTabProps } from "./WorkersTab";
import { unseenFailures, workersTabOffered } from "./worker-panel";

type Section = "waiting" | "results" | "settled";

/** What waits on you in this panel: everything for the main bot. */
export function panelWaiting(bot: BotView, waiting: WaitingView): WaitingItemView[] {
  return bot.role === "main" ? waiting.items : [];
}

export interface RightPanelProps {
  bot: BotView;
  bots: BotView[];
  waiting: WaitingView;
  look: "original" | "cute";
  status: { key: string; text: string };
  results: ResultView[];
  /** The subagent shown in the chat's place, if any. */
  watching: string | null;
  collapsed: boolean;
  onSelect: (botId: string) => void;
  onIgnore: (item: WaitingItemView) => void;
  onOpenResult: (result: ResultView) => void;
  onOpenSubagent: (row: Pick<SubagentRowView, "id" | "subBot">) => void;
  onUnsettle: (row: SubagentRowView) => void;
  /** A settled row's "⋯" (agentMoves): its agent menu. */
  onAgentMenu?: (row: SubagentRowView, at: { x: number; y: number }) => void;
  /** Open the bot's settings in the panel (the strip's button also opens the panel). */
  onSettings: () => void;
  /** The bot's settings shown in the overview's place, and their page (1.x's SettingsPage). */
  showingSettings?: boolean;
  settingsPage?: ReactNode;
  /** The blocks plugins add under its Now card (`rightPanel.section` views: botling.git's Worktrees). */
  pluginSections?: ReactNode;
  onCloseSettings?: () => void;
  onExpand: () => void;
  /** Navigation v5: the panel's tab (Details or Workers), when the room or its family has workers. */
  panelTab?: PanelTab;
  onPanelTab?: (tab: PanelTab) => void;
  onLoadWorker?: WorkersTabProps["onLoadWorker"];
  onAskOwner?: WorkersTabProps["onAskOwner"];
  onSeenWorker?: (workerId: string) => void;
  /** Failed workers whose log you opened (no red dot for them). */
  seenWorkers?: ReadonlySet<string>;
  onOpenFile?: WorkersTabProps["onOpenFile"];
  focusWorker?: WorkersTabProps["focusWorker"];
}

/** `ArtifactLink.isArtifact`: a claude.ai Artifact's page. */
const isArtifact = (url: string) => /^https:\/\/(www\.)?claude\.ai\/(code\/)?artifact\/[^/]+/i.test(url);

export function RightPanel(props: RightPanelProps) {
  if (props.collapsed) return <RightStrip {...props} />;
  return <OpenPanel {...props} />;
}

/** The bot's settings in the overview's place (1.x's SettingsPage): Back, "Settings", then the page. */
function SettingsPanel({ settingsPage, onCloseSettings }: RightPanelProps) {
  return (
    <aside className="detail-panel" aria-label="Details">
      <div className="detail-head settings-panel-head">
        <button type="button" className="panel-back" aria-label="Back" onClick={onCloseSettings}><Icon name="chevronLeft" size={14} /></button>
        <span className="detail-name">Settings</span>
      </div>
      <div className="panel-settings">{settingsPage}</div>
    </aside>
  );
}

function OpenPanel(props: RightPanelProps) {
  if (props.showingSettings && props.settingsPage) return <SettingsPanel {...props} />;
  const now = Date.now();
  const offered = !!(props.onLoadWorker && props.onAskOwner && props.onPanelTab) && workersTabOffered(props.bot, props.bots, now);
  // The other tab's dot: Details orange when something waits on you there; Workers red with a failure you have not opened.
  const waits = panelWaiting(props.bot, props.waiting).length > 0 || props.bot.approvals > 0;
  const failed = offered && unseenFailures(props.bot, props.bots, now, props.seenWorkers ?? new Set()) > 0;
  if (offered && props.panelTab === "workers") {
    return (
      <aside className="detail-panel workers-panel" aria-label="Workers">
        <PanelTabs tab="workers" onTab={props.onPanelTab!} waits={waits} failed={false} />
        <WorkersTab key={props.bot.id} bot={props.bot} bots={props.bots} onLoadWorker={props.onLoadWorker!} onAskOwner={props.onAskOwner!} onSeen={props.onSeenWorker}
          onOpenFile={props.onOpenFile} focusWorker={props.focusWorker} />
      </aside>
    );
  }
  return <Overview {...props} tabs={offered ? <PanelTabs tab="details" onTab={props.onPanelTab!} waits={false} failed={failed} /> : null} />;
}

/** Details | Workers, at the panel's top (only when there are workers to show), each with its dot when the other is shown. */
function PanelTabs({ tab, onTab, waits, failed }: { tab: PanelTab; onTab: (tab: PanelTab) => void; waits: boolean; failed: boolean }) {
  return (
    <div className="panel-tabs" role="tablist" aria-label="Panel">
      <button type="button" role="tab" aria-selected={tab === "details"} className={tab === "details" ? "on" : ""} onClick={() => onTab("details")}
        aria-label={waits ? "Details, something waits on you" : undefined}>Details{waits && <span className="tab-dot waiting" aria-hidden="true" />}</button>
      <button type="button" role="tab" aria-selected={tab === "workers"} className={tab === "workers" ? "on" : ""} onClick={() => onTab("workers")}
        aria-label={failed ? "Workers, a worker failed" : undefined}>Workers{failed && <span className="tab-dot failed" aria-hidden="true" />}</button>
    </div>
  );
}

function Overview({ tabs, pluginSections, bot, bots, waiting, look, status, results, watching, onSelect, onIgnore, onOpenResult, onOpenSubagent, onUnsettle, onAgentMenu, onSettings }: RightPanelProps & { tabs?: ReactNode }) {
  const doing = bot.role === "manager" ? waiting.doing[bot.id] : undefined;
  const items = panelWaiting(bot, waiting);
  const settled = settledRows(bot.subagentRows);
  return (
    <aside className="detail-panel" aria-label="Details">
      {tabs}
      <div className="detail-head">
        <img className="detail-avatar" src={faceURL(bot, look, { asleep: bot.phase === "asleep" && !bot.working, working: bot.working, waiting: bot.approvals > 0 })} alt="" />
        <span className="detail-name">{bot.name}</span>
        <span className="bot-gap" />
        <button type="button" className="detail-settings" title={`${bot.name}'s settings`} aria-label="Bot settings" onClick={onSettings}><Icon name="sliders" size={15} /></button>
      </div>
      <section className="detail-section now-section">
        <h3>Now</h3>
        <div className="now-card">
          <div className="now-line"><span className="now-dot" data-status={status.key} aria-hidden="true" />{status.text}</div>
        </div>
        {doing ? <div className="now-doing">{doing}</div> : !bot.working && <div className="now-none">Nothing under way</div>}
      </section>
      {pluginSections}
      {items.length > 0 && (
        <section className="detail-section">
          <h3>Waiting on you</h3>
          <WaitingList items={items} bots={bots} look={look} onSelect={onSelect} onIgnore={onIgnore} />
        </section>
      )}
      {results.length > 0 && (
        <section className="detail-section results-section">
          <h3>{bot.role === "main" ? "Just done" : "Results"}</h3>
          <div className="result-list">
            {results.slice(0, 3).map((result) => <ResultRow key={`${result.label}\u0000${result.url}`} result={result} onOpen={onOpenResult} />)}
          </div>
        </section>
      )}
      {settled.length > 0 && (
        <section className="detail-section settled-section">
          <h3>Settled</h3>
          <SettledList avatar={bot.avatar} look={look} rows={settled} watching={watching} onOpen={onOpenSubagent} onUnsettle={onUnsettle} onAgentMenu={onAgentMenu} />
        </section>
      )}
    </aside>
  );
}

function WaitingList({ items, bots, look, onSelect, onIgnore }: { items: WaitingItemView[]; bots: BotView[]; look: "original" | "cute"; onSelect: (botId: string) => void; onIgnore: (item: WaitingItemView) => void }) {
  return (
    <ul className="waiting-list">
      {items.map((item) => {
        const owner = bots.find((candidate) => candidate.id === item.botId);
        return (
          <li key={`${item.botId}-${item.text}`} className="waiting-item" data-bot={item.botId}>
            <button type="button" className="waiting-open" onClick={() => onSelect(item.botId)} title={owner ? `Open ${owner.name}'s chat` : undefined}>
              {owner && <img className="waiting-avatar" src={faceURL(owner, look, {})} alt="" />}
              <span className="waiting-text">{item.text}</span>
              <span className="waiting-chevron" aria-hidden="true">›</span>
            </button>
            <button type="button" className="waiting-ignore" aria-label="Ignore" title="Ignore: take it off this list without answering" onClick={() => onIgnore(item)}>×</button>
          </li>
        );
      })}
    </ul>
  );
}

function ResultRow({ result, onOpen, compact = false }: { result: ResultView; onOpen: (result: ResultView) => void; compact?: boolean }) {
  return (
    <button type="button" className={`result-row${compact ? " compact" : ""}`} title={result.url} onClick={() => onOpen(result)}>
      <span className="result-label">{result.label}</span>
      <Icon name={isArtifact(result.url) ? "safari" : "arrowUpRight"} size={12} className="result-icon" />
    </button>
  );
}

/** "Settled": the subagents you settled, five then "Show N more"; ↩ brings one back to the left column (1.x's SettledList). */
function SettledList({ avatar, look, rows, watching, onOpen, onUnsettle, onAgentMenu }: { avatar: string; look: "original" | "cute"; rows: SubagentRowView[]; watching: string | null; onOpen: (row: SubagentRowView) => void; onUnsettle: (row: SubagentRowView) => void; onAgentMenu?: (row: SubagentRowView, at: { x: number; y: number }) => void }) {
  const [all, setAll] = useState(false);
  const more = Math.max(0, rows.length - 5);
  return (
    <div className="settled-list">
      {(all ? rows : rows.slice(0, 5)).map((row) => (
        <div key={row.id} className={`settled-row${watching === row.id ? " selected" : ""}`} data-subagent={row.id}>
          <button type="button" className="settled-open" title={row.prompt} onClick={() => onOpen(row)} aria-label={`Settled subagent: ${row.title}, ${row.status}`}>
            <span className="settled-mark"><SubagentMark status={row.status} /></span>
            <OwnerMark head={row.head} avatar={avatar} look={look} />
            <span className={`settled-title${row.status === "running" ? " running" : ""}`}>{row.title || "Subagent"}</span>
            {row.host && <span className="subagent-kind subagent-host">on {row.host.name}</span>}
          </button>
          {row.movable && onAgentMenu && <AgentMenuButton row={row} onMenu={(at) => onAgentMenu(row, at)} />}
          <button type="button" className="settled-back" title="Back to the left column" aria-label={`Bring ${row.title} back to the left column`} onClick={() => onUnsettle(row)}>
            <Icon name="uturn" size={11} />
          </button>
        </div>
      ))}
      {more > 0 && (
        <button type="button" className="settled-more" onClick={() => setAll(!all)} aria-label={all ? "Show fewer settled subagents" : `Show ${more} more settled subagents`}>
          {all ? "Show less" : `Show ${more} more`}
        </button>
      )}
    </div>
  );
}

/** The panel folded (1.x's RightStrip): the face, an icon per section with something in it, the bot's settings. */
function RightStrip({ bot, bots, waiting, look, status, results, watching, onSelect, onIgnore, onOpenResult, onOpenSubagent, onUnsettle, onAgentMenu, onSettings, onExpand }: RightPanelProps) {
  const [open, setOpen] = useState<Section | null>(null);
  const [tip, setTip] = useState(false);
  const items = panelWaiting(bot, waiting);
  const settled = settledRows(bot.subagentRows);
  const counts = ([
    { section: "waiting", count: items.length },
    { section: "results", count: results.length },
    { section: "settled", count: settled.length },
  ] as { section: Section; count: number }[]).filter((entry) => entry.count > 0);
  useEffect(() => { setOpen(null); }, [bot.id]);
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(null); };
    const away = (event: Event) => { if (!(event.target instanceof Element && (event.target.closest(".strip-flyout") || event.target.closest(".strip-icon")))) setOpen(null); };
    window.addEventListener("keydown", key);
    window.addEventListener("pointerdown", away, true);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("pointerdown", away, true); };
  }, [open]);
  // The face's tip: the Now card's status, then what the bot is doing, if it says (`nowDetail`).
  const doing = bot.role === "manager" ? waiting.doing[bot.id] : undefined;
  const detail = doing?.trim() ? `${status.text} · ${doing.trim()}` : status.text;
  const title = (section: Section) => (section === "waiting" ? "Waiting on you" : section === "results" ? (bot.role === "main" ? "Just done" : "Results") : "Settled");
  const symbol = (section: Section) => (section === "waiting" ? "bubbleAlert" : section === "results" ? "arrowUpRight" : "checkCircle") as "bubbleAlert" | "arrowUpRight" | "checkCircle";
  const badge = (count: number) => (count > 99 ? "99+" : String(count));
  return (
    <aside className="right-strip" aria-label="Details (folded)">
      <button type="button" className="strip-face" onClick={onExpand} onMouseEnter={() => setTip(true)} onMouseLeave={() => setTip(false)}
        aria-label={`${bot.name}, ${detail}. Show the panel`}>
        <img src={faceURL(bot, look, { asleep: bot.phase === "asleep" && !bot.working, working: bot.working, waiting: bot.approvals > 0 })} alt="" />
        <span className="strip-dot" data-status={status.key} aria-hidden="true" />
      </button>
      {tip && (
        <div className="strip-tip" role="tooltip">
          <div className="strip-tip-title"><span className="now-dot" data-status={status.key} />{bot.name}</div>
          <div className="strip-tip-detail">{detail}</div>
        </div>
      )}
      <div className="strip-rule" />
      {counts.map(({ section, count }) => (
        <div key={section} className="strip-slot">
          <button type="button" className={`strip-icon${open === section ? " on" : ""}`} data-section={section} title={title(section)}
            aria-label={`${title(section)}, ${badge(count)}`} aria-expanded={open === section} onClick={() => setOpen(open === section ? null : section)}>
            <Icon name={symbol(section)} size={15} />
            <span className={`strip-badge ${section}`}>{badge(count)}</span>
          </button>
          {open === section && (
            <ShellOverlay><div className="strip-flyout" role="dialog" aria-label={title(section)}>
              <div className="strip-flyout-head"><span>{title(section)}</span><span className="strip-esc">Esc to close</span></div>
              <div className="strip-flyout-body">
                {section === "waiting" && <WaitingList items={items} bots={bots} look={look} onSelect={(id) => { setOpen(null); onSelect(id); }} onIgnore={onIgnore} />}
                {section === "results" && (
                  <div className="result-list">
                    {results.slice(0, 12).map((result) => <ResultRow key={`${result.label}\u0000${result.url}`} result={result} compact onOpen={(chosen) => { setOpen(null); onOpenResult(chosen); }} />)}
                  </div>
                )}
                {section === "settled" && <SettledList avatar={bot.avatar} look={look} rows={settled} watching={watching} onOpen={onOpenSubagent} onUnsettle={onUnsettle} onAgentMenu={onAgentMenu} />}
              </div>
            </div></ShellOverlay>
          )}
        </div>
      ))}
      <div className="strip-gap" />
      <button type="button" className="strip-settings" title={`${bot.name}'s settings`} aria-label="Bot settings" onClick={onSettings}>
        <Icon name="sliders" size={14} />
      </button>
    </aside>
  );
}

/** The button at the window's top right that folds the right panel and opens it again (1.x's RightToggle, ⌃⌘I). */
export function RightToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const label = collapsed ? "Show right panel" : "Hide right panel";
  return (
    <button type="button" className={`right-toggle${collapsed ? "" : " on"}`} onClick={onToggle} title={`${label} (${shortcutLabel("toggleRightPanel")})`} aria-label={label} aria-pressed={!collapsed}>
      <Icon name="sidebarRight" size={14} />
    </button>
  );
}
