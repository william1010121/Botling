// The right panel (1.x's DetailPanel): the bot on screen, its Now card (status; a manager's first
// "In progress" line from its memory.md; the main bot's temporary teams at work) and, for the main
// bot, "Waiting on you" — every bot's open question or its memory's "Waiting on you", each opening
// that bot's chat, with × to ignore it (1.x's WaitingList). Then Results ("Just done" for the main
// bot: the links handed over in the chat, the newest three) and Settled (the subagents you settled
// out of the left column). Folded (⌃⌘I, the button at the window's top right), it is 1.x's RightStrip:
// the face with its status dot (hover for the Now card), an icon per section with a count, each
// opening that section beside the strip, and the bot's settings at the bottom.
import { useEffect, useState } from "react";
import { settledRows, type BotView, type ResultView, type SubagentRowView, type TeamRunView, type WaitingItemView, type WaitingView } from "../contract";
import { avatarURL, faceURL } from "./avatars";
import { Icon, SubagentMark } from "./icons";
import { OwnerMark, useMinuteClock } from "./Rail";

type Section = "waiting" | "results" | "settled";

export interface RightPanelProps {
  bot: BotView;
  bots: BotView[];
  waiting: WaitingView;
  look: "original" | "cute";
  status: { key: string; text: string };
  results: ResultView[];
  teams: TeamRunView[];
  /** The subagent shown in the chat's place, if any. */
  watching: string | null;
  collapsed: boolean;
  onSelect: (botId: string) => void;
  onIgnore: (item: WaitingItemView) => void;
  onOpenResult: (result: ResultView) => void;
  onOpenSubagent: (row: SubagentRowView) => void;
  onUnsettle: (row: SubagentRowView) => void;
  onSettings: () => void;
  onExpand: () => void;
}

/** `ArtifactLink.isArtifact`: a claude.ai Artifact's page. */
const isArtifact = (url: string) => /^https:\/\/(www\.)?claude\.ai\/(code\/)?artifact\/[^/]+/i.test(url);

export function RightPanel(props: RightPanelProps) {
  return props.collapsed ? <RightStrip {...props} /> : <OpenPanel {...props} />;
}

function OpenPanel({ bot, bots, waiting, look, status, results, teams, watching, onSelect, onIgnore, onOpenResult, onOpenSubagent, onUnsettle }: RightPanelProps) {
  const doing = bot.role === "manager" ? waiting.doing[bot.id] : undefined;
  const items = bot.role === "main" ? waiting.items : [];
  const settled = settledRows(bot.subagentRows);
  const now = useMinuteClock();
  return (
    <aside className="detail-panel" aria-label="Details">
      <div className="detail-head">
        <img className="detail-avatar" src={faceURL(bot, look, { asleep: bot.phase === "asleep" && !bot.working, working: bot.working, waiting: bot.approvals > 0 })} alt="" />
        <span className="detail-name">{bot.name}</span>
      </div>
      <section className="detail-section">
        <h3>Now</h3>
        <div className="now-card">
          <div className="now-line"><span className="now-dot" data-status={status.key} aria-hidden="true" />{status.text}</div>
          {doing && <div className="now-doing">{doing}</div>}
          {bot.role === "main" && teams.map((run) => (
            <div key={run.id} className="team-run" title={run.task} data-team={run.name}>
              <img className="team-face" src={avatarURL("cloud")} alt="" />
              <span className="team-title">{run.title}</span>
              <span className="team-time">{Math.max(1, Math.floor((now - run.startedAt) / 60_000))} min</span>
            </div>
          ))}
        </div>
      </section>
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
          <SettledList rows={settled} watching={watching} onOpen={onOpenSubagent} onUnsettle={onUnsettle} />
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
function SettledList({ rows, watching, onOpen, onUnsettle }: { rows: SubagentRowView[]; watching: string | null; onOpen: (row: SubagentRowView) => void; onUnsettle: (row: SubagentRowView) => void }) {
  const [all, setAll] = useState(false);
  const more = Math.max(0, rows.length - 5);
  return (
    <div className="settled-list">
      {(all ? rows : rows.slice(0, 5)).map((row) => (
        <div key={row.id} className={`settled-row${watching === row.id ? " selected" : ""}`} data-subagent={row.id}>
          <button type="button" className="settled-open" title={row.prompt} onClick={() => onOpen(row)} aria-label={`Settled subagent: ${row.title}, ${row.status}`}>
            <span className="settled-mark"><SubagentMark status={row.status} /></span>
            <OwnerMark head={row.head} />
            <span className={`settled-title${row.status === "running" ? " running" : ""}`}>{row.title || "Subagent"}</span>
          </button>
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
function RightStrip({ bot, bots, waiting, look, status, results, teams, watching, onSelect, onIgnore, onOpenResult, onOpenSubagent, onUnsettle, onSettings, onExpand }: RightPanelProps) {
  const [open, setOpen] = useState<Section | null>(null);
  const [tip, setTip] = useState(false);
  const items = bot.role === "main" ? waiting.items : [];
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
  const doing = bot.role === "manager" ? waiting.doing[bot.id] : bot.role === "main" ? teams[0]?.title : undefined;
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
            <div className="strip-flyout" role="dialog" aria-label={title(section)}>
              <div className="strip-flyout-head"><span>{title(section)}</span><span className="strip-esc">Esc to close</span></div>
              <div className="strip-flyout-body">
                {section === "waiting" && <WaitingList items={items} bots={bots} look={look} onSelect={(id) => { setOpen(null); onSelect(id); }} onIgnore={onIgnore} />}
                {section === "results" && (
                  <div className="result-list">
                    {results.slice(0, 12).map((result) => <ResultRow key={`${result.label}\u0000${result.url}`} result={result} compact onOpen={(chosen) => { setOpen(null); onOpenResult(chosen); }} />)}
                  </div>
                )}
                {section === "settled" && <SettledList rows={settled} watching={watching} onOpen={onOpenSubagent} onUnsettle={onUnsettle} />}
              </div>
            </div>
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
    <button type="button" className={`right-toggle${collapsed ? "" : " on"}`} onClick={onToggle} title={`${label} (⌃⌘I)`} aria-label={label} aria-pressed={!collapsed}>
      <Icon name="sidebarRight" size={14} />
    </button>
  );
}
