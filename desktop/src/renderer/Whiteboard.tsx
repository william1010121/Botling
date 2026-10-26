// The main bot's whiteboard: every bot as a card, grouped (a group chat's members together, then the
// projects, then the bots of their own). A card shows the bot's one-line highlight (its memory.md's
// first "Current status" line, else its first "In progress" line, else what its running task does
// now), how many things wait on you, a ring of its tasks done and a bar of its tasks by state.
// Pressed, the card grows in place into the bot's report, read by scrolling: Summary, Your call,
// Results, Progress (tasks finished per day), What I did, My calls ("Decided"), Next. Everything is
// what the bots keep themselves (memory.md, task cards, links handed over in their chats); a part
// with nothing in it is left out.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { type BotView, type MessageView, type ResultView, type TaskView, type WaitingItemView, type WaitingView, type WhiteboardBotView, type WhiteboardView } from "../contract";
import type { Client } from "./client";
import { faceURL } from "./avatars";
import { Icon } from "./icons";
import { activeTasks, finishedTasks } from "./RightPanel";

type Look = "original" | "cute";

/** The main view of the main bot, Chat or Whiteboard, kept for the next start (this window only). */
const CHOICE_KEY = "botling.mainWhiteboard";
export function useWhiteboardChoice(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => { try { return localStorage.getItem(CHOICE_KEY) === "1"; } catch { return false; } });
  const choose = useCallback((next: boolean) => {
    setOn(next);
    try { localStorage.setItem(CHOICE_KEY, next ? "1" : "0"); } catch { /* no storage: this session only */ }
  }, []);
  return [on, choose];
}

export interface WhiteboardSection { id: string; title: string; bots: BotView[]; group: BotView | null }

/**
 * The board's groups: each group chat with its members (a bot in two groups shows in the first),
 * then the projects and the bots of their own in no group. The main bot is not a card; empty
 * sections are left out.
 */
export function whiteboardSections(bots: BotView[]): WhiteboardSection[] {
  const placed = new Set<string>();
  const out: WhiteboardSection[] = [];
  const cardable = (bot: BotView | undefined): bot is BotView => !!bot && bot.role !== "main" && bot.role !== "group";
  for (const group of bots.filter((bot) => bot.role === "group")) {
    const members = (group.members ?? []).map((id) => bots.find((bot) => bot.id === id)).filter(cardable).filter((bot) => !placed.has(bot.id));
    for (const member of members) placed.add(member.id);
    if (members.length) out.push({ id: group.id, title: group.name, bots: members, group });
  }
  const rest = bots.filter((bot) => cardable(bot) && !placed.has(bot.id));
  const projects = rest.filter((bot) => bot.role === "manager");
  const own = rest.filter((bot) => bot.role === "bot");
  if (projects.length) out.push({ id: "projects", title: "Projects", bots: projects, group: null });
  if (own.length) out.push({ id: "bots", title: "Bots", bots: own, group: null });
  return out;
}

/** What waits on you from one bot: its open questions or its memory's "Waiting on you" (as the right panel lists them). */
export const waitingFor = (bot: BotView, waiting: WaitingView): WaitingItemView[] => waiting.items.filter((item) => item.botId === bot.id);

/** How many things wait on you from the bot: those questions, its tasks waiting on you, its tool approvals. */
export function waitingCount(bot: BotView, waiting: WaitingView, data: WhiteboardBotView | undefined): number {
  return waitingFor(bot, waiting).length + (data?.tasks.filter((task) => task.state === "waiting" && task.name.trim()).length ?? 0) + bot.approvals;
}

/** The card's one line: "Current status", else "In progress", else what the running task does now, else the bot's job. */
export function highlight(bot: BotView, data: WhiteboardBotView | undefined, waiting: WaitingView): string | null {
  const task = data ? activeTasks(named(data.tasks)).find((candidate) => candidate.state === "running" && candidate.now?.trim()) : undefined;
  return data?.currentStatus[0] ?? data?.inProgress[0] ?? waiting.doing[bot.id] ?? task?.now ?? bot.job ?? null;
}

const named = (tasks: TaskView[]) => tasks.filter((task) => task.name.trim().length > 0);

/** Tasks by state for the bar: waiting on you, under way, finished. */
export function taskCounts(tasks: TaskView[]): { waiting: number; active: number; done: number; total: number } {
  const shown = named(tasks);
  const waiting = shown.filter((task) => task.state === "waiting").length;
  const active = shown.filter((task) => task.state === "running" || task.state === "pending").length;
  const done = shown.filter((task) => task.state === "done" || task.state === "stopped").length;
  return { waiting, active, done, total: waiting + active + done };
}

/** Tasks finished on each of the last seven days, oldest first (by the time the card last changed). */
export function doneByDay(tasks: TaskView[], now: number): { day: string; count: number; today: boolean }[] {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, index) => {
    const from = new Date(start); from.setDate(start.getDate() - (6 - index));
    const to = new Date(from); to.setDate(from.getDate() + 1);
    return { from: from.getTime(), to: to.getTime(), day: index === 6 ? "Today" : from.toLocaleDateString("en-US", { month: "short", day: "numeric" }), today: index === 6 };
  });
  return days.map(({ from, to, day, today }) => ({ day, today, count: named(tasks).filter((task) => task.state === "done" && (() => { const at = Date.parse(task.updatedAt); return at >= from && at < to; })()).length }));
}

/** "Next": the memory's "In progress" lines, then what the tasks under way say comes next (no repeats). */
export function nextSteps(data: WhiteboardBotView): string[] {
  const out: string[] = [];
  for (const line of [...data.inProgress, ...activeTasks(named(data.tasks)).map((task) => task.next ?? "")]) {
    const text = line.trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out.slice(0, 10);
}

function shortTime(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (date.toDateString() === new Date(now - 86_400_000).toDateString()) return "Yesterday";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Asks the core for the board's data now and every few seconds while it is shown; an answer like the last one changes nothing. */
function useWhiteboardData(client: Client, refreshMs: number): WhiteboardView | null {
  const [data, setData] = useState<WhiteboardView | null>(null);
  const last = useRef("");
  useEffect(() => {
    let live = true;
    const load = () => {
      void client.request({ type: "whiteboard.view" }).then((view) => {
        const text = JSON.stringify(view);
        if (!live || text === last.current) return;
        last.current = text;
        setData(view);
      }, () => {});
    };
    load();
    const timer = refreshMs > 0 ? setInterval(load, refreshMs) : null;
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [client, refreshMs]);
  return data;
}

export interface WhiteboardProps {
  client: Client;
  bots: BotView[];
  waiting: WaitingView;
  look: Look;
  now: number;
  /** The main bot's chat lines, for its latest reply on the board. */
  mainMessages: MessageView[];
  mainBotId: string;
  statusOf: (bot: BotView) => { key: string; text: string };
  onOpenChat: (botId: string) => void;
  onError: (failure: unknown) => void;
  /** How often the board asks again (ms); 0: only once (tests). */
  refreshMs?: number;
}

export function Whiteboard({ client, bots, waiting, look, now, mainMessages, mainBotId, statusOf, onOpenChat, onError, refreshMs = 5_000 }: WhiteboardProps) {
  const data = useWhiteboardData(client, refreshMs);
  const byBot = useMemo(() => new Map((data?.bots ?? []).map((entry) => [entry.botId, entry])), [data]);
  const sections = useMemo(() => whiteboardSections(bots), [bots]);
  const [open, setOpen] = useState<{ botId: string; origin: string } | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const cards = sections.flatMap((section) => section.bots);
  const totalTasks = cards.reduce((sum, bot) => sum + taskCounts(byBot.get(bot.id)?.tasks ?? []).total, 0);
  const totalWaiting = cards.reduce((sum, bot) => sum + waitingCount(bot, waiting, byBot.get(bot.id)), 0);
  const openBot = open ? bots.find((bot) => bot.id === open.botId) ?? null : null;

  const press = (bot: BotView, element: HTMLElement) => {
    // The report grows out of the card: its scale starts at the card's place on the canvas.
    const box = canvas.current?.getBoundingClientRect();
    const at = element.getBoundingClientRect();
    const origin = box ? `${Math.round(at.left - box.left + at.width / 2)}px ${Math.round(at.top - box.top + at.height / 2)}px` : "50% 0";
    setOpen({ botId: bot.id, origin });
  };
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(null); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open]);

  return (
    <div className="whiteboard" aria-label="Whiteboard">
      <div className="wb-bar">
        <span className="wb-bar-count">{cards.length} bot{cards.length === 1 ? "" : "s"} · {totalTasks} task{totalTasks === 1 ? "" : "s"}{totalWaiting > 0 ? ` · ${totalWaiting} waiting on you` : ""}</span>
      </div>
      <div className="wb-canvas" ref={canvas}>
        <div className="wb-sections">
          {sections.map((section) => {
            const sectionWaiting = section.bots.reduce((sum, bot) => sum + waitingCount(bot, waiting, byBot.get(bot.id)), 0)
              + (section.group ? waiting.items.filter((item) => item.groupId === section.group!.id && item.botId === section.group!.id).length : 0);
            const sectionTasks = section.bots.reduce((sum, bot) => sum + taskCounts(byBot.get(bot.id)?.tasks ?? []).total, 0);
            const wide = section.bots.reduce((sum, bot) => sum + (waitingCount(bot, waiting, byBot.get(bot.id)) > 0 ? 2 : 1), 0);
            return (
              <section key={section.id} className="wb-section" data-section={section.id} style={{ flexGrow: Math.min(wide, 4), flexBasis: `${Math.min(wide, 4) * 200}px` } as CSSProperties}>
                <h3 className="wb-section-title">
                  {section.group ? <button type="button" className="wb-section-open" onClick={() => onOpenChat(section.group!.id)} title={`Open ${section.title}`}>{section.title}</button> : section.title}
                  <span className="wb-section-meta"> · {sectionTasks} task{sectionTasks === 1 ? "" : "s"}{sectionWaiting > 0 ? ` · ${sectionWaiting} waiting` : ""}</span>
                </h3>
                <div className="wb-grid">
                  {section.bots.map((bot) => (
                    <BotCard key={bot.id} bot={bot} data={byBot.get(bot.id)} waiting={waiting} look={look} now={now} status={statusOf(bot)}
                      onPress={(element) => press(bot, element)} />
                  ))}
                </div>
              </section>
            );
          })}
          <MainSummary bots={bots} waiting={waiting} data={byBot} look={look} messages={mainMessages} mainBotId={mainBotId} sections={sections} />
          {sections.length === 0 && <div className="wb-empty">No bots yet. Add a project or a bot of your own, and its card shows here.</div>}
        </div>
        {open && openBot && (
          <div className="wb-scrim" onPointerDown={(event) => { if (event.target === event.currentTarget) setOpen(null); }}>
            <Report bot={openBot} data={byBot.get(openBot.id)} waiting={waiting} look={look} now={now} origin={open.origin} status={statusOf(openBot)}
              onClose={() => setOpen(null)} onOpenChat={(id) => { setOpen(null); onOpenChat(id); }}
              onOpenResult={(result) => void client.request({ type: "result.open", botId: openBot.id, url: result.url }).catch(onError)} />
          </div>
        )}
      </div>
      <WhiteboardComposer client={client} mainBotId={mainBotId} onError={onError} />
    </div>
  );
}

/** A ring of the bot's tasks done out of all of them. */
function TaskRing({ done, total }: { done: number; total: number }) {
  const length = 2 * Math.PI * 20;
  const part = total ? (done / total) * length : 0;
  return (
    <svg className="wb-ring" width="52" height="52" viewBox="0 0 52 52" role="img" aria-label={`${done} of ${total} tasks done`}>
      <circle cx="26" cy="26" r="20" fill="none" stroke="var(--chip)" strokeWidth="6" />
      {part > 0 && <circle cx="26" cy="26" r="20" fill="none" stroke="var(--green)" strokeWidth="6" strokeDasharray={`${part} ${length}`} strokeLinecap="round" transform="rotate(-90 26 26)" />}
      <text x="26" y="30" textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--text)">{done}/{total}</text>
    </svg>
  );
}

/** The bar along a card's foot: its tasks waiting on you, under way and finished. */
function StateBar({ counts }: { counts: ReturnType<typeof taskCounts> }) {
  const part = (count: number) => `${counts.total ? (count / counts.total) * 100 : 0}%`;
  return (
    <span className="wb-statebar" aria-hidden="true">
      {counts.waiting > 0 && <span className="waiting" style={{ width: part(counts.waiting) }} />}
      {counts.active > 0 && <span className="active" style={{ width: part(counts.active) }} />}
      {counts.done > 0 && <span className="done" style={{ width: part(counts.done) }} />}
    </span>
  );
}

function BotCard({ bot, data, waiting, look, now, status, onPress }: {
  bot: BotView; data: WhiteboardBotView | undefined; waiting: WaitingView; look: Look; now: number; status: { key: string; text: string }; onPress: (element: HTMLElement) => void;
}) {
  const count = waitingCount(bot, waiting, data);
  const counts = taskCounts(data?.tasks ?? []);
  const line = highlight(bot, data, waiting);
  const when = shortTime(bot.lastActivity, now);
  const asleep = bot.phase === "asleep" && !bot.working;
  return (
    <button type="button" className={`wb-card${count > 0 ? " waiting" : ""}`} data-bot={bot.id} onClick={(event) => onPress(event.currentTarget)}
      aria-label={[`${bot.name}'s report`, status.text, count ? `${count} waiting on you` : null, line].filter(Boolean).join(", ")}>
      <span className="wb-card-head">
        <img className="wb-face" src={faceURL(bot, look, { asleep, working: bot.working, waiting: bot.approvals > 0 })} alt="" />
        <span className="wb-card-name">{bot.name}</span>
        {count > 0 && <span className="wb-pill">{count} waiting</span>}
        {when && <span className="wb-card-time">{when}</span>}
      </span>
      <span className="wb-card-body">
        {counts.total > 0 && <TaskRing done={counts.done} total={counts.total} />}
        <span className="wb-card-text">
          {line ? <span className="wb-highlight">{line}</span> : <span className="wb-highlight none">Nothing written yet</span>}
        </span>
      </span>
      <span className="wb-card-foot">
        <span className="wb-status"><span className="now-dot" data-status={status.key} aria-hidden="true" />{status.text}</span>
        {counts.total > 0 && <span className="wb-foot-count">{counts.active > 0 ? `${counts.active} under way` : `${counts.done} done`}</span>}
      </span>
      <StateBar counts={counts} />
    </button>
  );
}

/** The main bot's corner: who waits on you, and its latest reply. */
function MainSummary({ bots, waiting, data, look, messages, mainBotId, sections }: {
  bots: BotView[]; waiting: WaitingView; data: Map<string, WhiteboardBotView>; look: Look; messages: MessageView[]; mainBotId: string; sections: WhiteboardSection[];
}) {
  const main = bots.find((bot) => bot.id === mainBotId);
  const reply = messages.findLast((message) => message.role === "bot" && message.text.trim());
  const from = sections.flatMap((section) => section.bots).map((bot) => ({ bot, count: waitingCount(bot, waiting, data.get(bot.id)) })).filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count);
  const total = from.reduce((sum, entry) => sum + entry.count, 0);
  if (!main || (!reply && total === 0)) return null;
  return (
    <section className="wb-main" aria-label="Main bot summary">
      <span className="wb-main-head"><img className="wb-face" src={faceURL(main, look, {})} alt="" />{main.name}{reply ? " · latest reply" : ""}</span>
      {total > 0 && <span className="wb-main-line">{total} waiting on you: {from.map((entry) => `${entry.count} from ${entry.bot.name}`).join(", ")}.</span>}
      {reply && <span className="wb-main-reply">{reply.text.trim().split(/\n\s*\n/)[0]!.slice(0, 600)}</span>}
    </section>
  );
}

const SECTIONS = [["sum", "Summary"], ["ask", "Your call"], ["made", "Results"], ["trend", "Progress"], ["log", "What I did"], ["decided", "My calls"], ["next", "Next"]] as const;
type ReportSection = (typeof SECTIONS)[number][0];

function Report({ bot, data, waiting, look, now, origin, status, onClose, onOpenChat, onOpenResult }: {
  bot: BotView; data: WhiteboardBotView | undefined; waiting: WaitingView; look: Look; now: number; origin: string; status: { key: string; text: string };
  onClose: () => void; onOpenChat: (botId: string) => void; onOpenResult: (result: ResultView) => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null);
  const tasks = named(data?.tasks ?? []);
  const counts = taskCounts(tasks);
  const asks = waitingFor(bot, waiting);
  const waitingTasks = tasks.filter((task) => task.state === "waiting");
  const done = finishedTasks(tasks, 12);
  const days = doneByDay(tasks, now);
  const peak = Math.max(1, ...days.map((day) => day.count));
  const next = data ? nextSteps(data) : [];
  const status0 = data?.currentStatus ?? [];
  const has: Record<ReportSection, boolean> = {
    sum: status0.length > 0 || counts.total > 0 || asks.length > 0,
    ask: asks.length + waitingTasks.length + bot.approvals > 0,
    made: (data?.results.length ?? 0) > 0,
    trend: days.some((day) => day.count > 0),
    log: done.length > 0,
    decided: (data?.decided.length ?? 0) > 0,
    next: next.length > 0,
  };
  const waitingTotal = asks.length + waitingTasks.length + bot.approvals;
  const shown = SECTIONS.filter(([id]) => has[id]);
  const [current, setCurrent] = useState<ReportSection | null>(shown[0]?.[0] ?? null);
  useLayoutEffect(() => { article.current?.focus({ preventScroll: true }); }, []);
  const jump = (id: ReportSection) => {
    setCurrent(id);
    const target = body.current?.querySelector<HTMLElement>(`[data-part="${id}"]`);
    if (target && body.current) body.current.scrollTop = target.offsetTop - body.current.offsetTop;
  };
  const when = shortTime(bot.lastActivity, now);
  return (
    <article ref={article} tabIndex={-1} className="wb-report" data-bot={bot.id} style={{ transformOrigin: origin }} aria-label={`${bot.name}'s report`}>
      <header className="wb-report-head">
        <div className="wb-report-top">
          <img className="wb-report-face" src={faceURL(bot, look, { asleep: bot.phase === "asleep" && !bot.working, working: bot.working, waiting: bot.approvals > 0 })} alt="" />
          <span className="wb-report-title">
            <span className="wb-report-name">{bot.name}'s report</span>
            <span className="wb-report-sub"><span className="now-dot" data-status={status.key} aria-hidden="true" />{status.text}{when ? ` · ${when}` : ""}</span>
          </span>
          <button type="button" className="wb-report-chat" onClick={() => onOpenChat(bot.id)}>Open chat</button>
          <button type="button" className="wb-report-close" aria-label="Shrink back to the board" title="Back to the board (Esc)" onClick={onClose}><Icon name="xmark" size={13} /></button>
        </div>
        {shown.length > 1 && (
          <nav className="wb-toc" aria-label="Parts of the report">
            {shown.map(([id, label]) => (
              <button key={id} type="button" className={`wb-toc-chip${current === id ? " on" : ""}`} onClick={() => jump(id)}>
                {id === "ask" ? `${label} ${waitingTotal}` : label}
              </button>
            ))}
          </nav>
        )}
      </header>
      <div className="wb-report-body" ref={body}>
        {shown.length === 0 && <p className="wb-report-empty">{bot.name} has not written a status, tasks or results yet.</p>}
        {has.sum && (
          <section data-part="sum" className="wb-part">
            {status0.map((line, index) => <p key={index} className="wb-sum-line">{line}</p>)}
            <div className="wb-stats">
              <span className="wb-stat"><span className="wb-stat-n done">{counts.done}</span><span className="wb-stat-l">done</span></span>
              <span className="wb-stat"><span className="wb-stat-n active">{counts.active}</span><span className="wb-stat-l">under way</span></span>
              <span className="wb-stat"><span className="wb-stat-n waiting">{waitingTotal}</span><span className="wb-stat-l">waiting on you</span></span>
            </div>
          </section>
        )}
        {has.ask && (
          <section data-part="ask" className="wb-part">
            <h4 className="wb-part-title ask">Your call</h4>
            {asks.map((item) => (
              <div key={`${item.botId}-${item.text}`} className="wb-ask">
                <span className="wb-ask-text">{item.text}</span>
                <button type="button" className="wb-ask-open" onClick={() => onOpenChat(item.groupId ?? item.botId)}>Answer in chat</button>
              </div>
            ))}
            {waitingTasks.map((task) => (
              <div key={task.id} className="wb-ask" data-task={task.id}>
                <span className="wb-ask-text"><b>{task.name}</b>{task.blocked ?? task.now ? ` · ${task.blocked ?? task.now}` : ""}</span>
                <button type="button" className="wb-ask-open" onClick={() => onOpenChat(bot.id)}>Answer in chat</button>
              </div>
            ))}
            {bot.approvals > 0 && (
              <div className="wb-ask">
                <span className="wb-ask-text">{bot.approvals} tool approval{bot.approvals === 1 ? "" : "s"} waiting</span>
                <button type="button" className="wb-ask-open" onClick={() => onOpenChat(bot.id)}>Answer in chat</button>
              </div>
            )}
          </section>
        )}
        {has.made && (
          <section data-part="made" className="wb-part">
            <h4 className="wb-part-title made">What got made</h4>
            <div className="wb-results">
              {data!.results.map((result) => (
                <button key={`${result.label}\u0000${result.url}`} type="button" className="wb-result" title={result.url} onClick={() => onOpenResult(result)}>
                  <span className="wb-result-label">{result.label}</span><Icon name="arrowUpRight" size={12} />
                </button>
              ))}
            </div>
          </section>
        )}
        {has.trend && (
          <section data-part="trend" className="wb-part">
            <h4 className="wb-part-title">Tasks finished this week</h4>
            <div className="wb-chart">
              <svg width="100%" height="96" viewBox="0 0 700 96" preserveAspectRatio="none" role="img"
                aria-label={`Tasks finished per day: ${days.map((day) => `${day.day} ${day.count}`).join(", ")}`}>
                {days.map((day, index) => {
                  const height = day.count ? Math.max(6, (day.count / peak) * 86) : 2;
                  return <rect key={day.day} x={index * 100 + 15} y={92 - height} width="70" height={height} rx="4" className={day.today ? "today" : day.count ? "bar" : "empty"} />;
                })}
              </svg>
              <div className="wb-chart-days">{days.map((day) => <span key={day.day}>{day.day}{day.count ? ` · ${day.count}` : ""}</span>)}</div>
            </div>
          </section>
        )}
        {has.log && (
          <section data-part="log" className="wb-part">
            <h4 className="wb-part-title">What I did (newest first)</h4>
            {done.map((task) => (
              <span key={task.id} className="wb-log" data-task={task.id}>
                <span className="wb-log-when">{shortTime(task.updatedAt, now)}</span>
                <span className="wb-log-text">{task.state === "stopped" ? `${task.name} (stopped)` : task.name}</span>
              </span>
            ))}
          </section>
        )}
        {has.decided && (
          <section data-part="decided" className="wb-part">
            <h4 className="wb-part-title">Calls I made myself</h4>
            {data!.decided.map((line, index) => <span key={index} className="wb-line">{line}</span>)}
          </section>
        )}
        {has.next && (
          <section data-part="next" className="wb-part">
            <h4 className="wb-part-title">Next</h4>
            {next.map((line, index) => <span key={index} className="wb-line">{index + 1}. {line}</span>)}
          </section>
        )}
      </div>
    </article>
  );
}

/** The board's input: a message to the main bot ("how is everyone doing?"); its reply shows in the main bot's corner. */
function WhiteboardComposer({ client, mainBotId, onError }: { client: Client; mainBotId: string; onError: (failure: unknown) => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const send = () => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    void client.request({ type: "chat.send", botId: mainBotId, text: message }).then(() => setText(""), onError).finally(() => setSending(false));
  };
  return (
    <form className="wb-composer" onSubmit={(event) => { event.preventDefault(); send(); }}>
      <div className="wb-composer-box">
        <textarea className="wb-composer-input" rows={1} value={text} placeholder="Ask how everyone's doing…" aria-label="Message to the main bot"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} />
        <button type="submit" className="wb-composer-send" aria-label="Send" disabled={!text.trim() || sending}>↑</button>
      </div>
    </form>
  );
}
