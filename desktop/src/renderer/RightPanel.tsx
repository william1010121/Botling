// The right panel (1.x's DetailPanel): the bot on screen, its Now card (status; a manager's first
// "In progress" line from its memory.md; the main bot's temporary teams at work) and, for the main
// bot, "Waiting on you" — every bot's open question or its memory's "Waiting on you", each opening
// that bot's chat, with × to ignore it (1.x's WaitingList). Then Results ("Just done" for the main
// bot: the links handed over in the chat, the newest three) and Settled (the subagents you settled
// out of the left column). Folded (⌃⌘I, the button at the window's top right), it is 1.x's RightStrip:
// the face with its status dot (hover for the Now card), an icon per section with a count, each
// opening that section beside the strip, and the bot's settings at the bottom.
import { useEffect, useState } from "react";
import { settledRows, type BotView, type MessageView, type ResultView, type SubagentRowView, type TaskView, type TeamRunView, type WaitingItemView, type WaitingView } from "../contract";
import { avatarURL, faceURL } from "./avatars";
import { Icon, SubagentMark } from "./icons";
import { OwnerMark, useMinuteClock } from "./Rail";

type Section = "waiting" | "members" | "results" | "settled";

/** What waits on you in this panel: everything for the main bot, a group's own questions in its chat (1.x's `groupID`). */
export function panelWaiting(bot: BotView, waiting: WaitingView): WaitingItemView[] {
  if (bot.role === "group") return waiting.items.filter((item) => item.groupId === bot.id);
  return bot.role === "main" ? waiting.items : [];
}

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
  /** The bot's task cards and its chat's lines (for "Jump to chat"), and the card pressed open. */
  tasks: TaskView[];
  messages: MessageView[];
  /** The chat's lines folded into a summary (Catch-up and the interval summaries): a task all of whose replies are in one says "In the summary". */
  summarized?: ReadonlySet<string>;
  selectedTask: string | null;
  onSelectTask: (id: string) => void;
  onJumpToTask: (messageId: string, taskId: string) => void;
  onAskForReport: (task: TaskView, replyTo: string | null) => void;
  /** A group's "Rename, add or take out members". */
  onEditGroup: () => void;
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
  if (props.collapsed) return <RightStrip {...props} />;
  return props.bot.role === "group" ? <GroupPanel {...props} /> : <OpenPanel {...props} />;
}

/** The right column for a group (1.x's GroupPanel): who is in it, and what was handed in. */
function GroupPanel({ bot, bots, waiting, look, results, onSelect, onIgnore, onOpenResult, onEditGroup }: RightPanelProps) {
  const members = groupMembers(bot, bots);
  const items = panelWaiting(bot, waiting);
  return (
    <aside className="detail-panel" aria-label="Details">
      <div className="detail-head">
        <span className="detail-name">{bot.name}</span>
        <span className="bot-gap" />
        <button type="button" className="group-edit" title="Rename, add or take out members" aria-label="Edit group" onClick={onEditGroup}><Icon name="sliders" size={14} /></button>
      </div>
      {items.length > 0 && (
        <section className="detail-section">
          <h3>Waiting on you</h3>
          <WaitingList items={items} bots={bots} look={look} onSelect={onSelect} onIgnore={onIgnore} />
        </section>
      )}
      <section className="detail-section">
        <h3>In the group</h3>
        <div className="now-card group-members-card">
          <GroupMembers group={bot} members={members} look={look} onSelect={onSelect} />
          <p className="group-hint">Without @, everyone here reads your message in turn and answers only if it concerns them. @name talks to one of them.</p>
        </div>
      </section>
      {results.length > 0 && (
        <section className="detail-section results-section">
          <h3>Just done</h3>
          <div className="result-list">
            {results.slice(0, 3).map((result) => <ResultRow key={`${result.label}\u0000${result.url}`} result={result} onOpen={onOpenResult} />)}
          </div>
        </section>
      )}
    </aside>
  );
}

const groupMembers = (group: BotView, bots: BotView[]) => (group.members ?? []).map((id) => bots.find((candidate) => candidate.id === id)).filter((member): member is BotView => !!member);

/** The members of a group, each opening its own chat, with who is writing now (1.x's GroupMemberRow). */
function GroupMembers({ group, members, look, onSelect }: { group: BotView; members: BotView[]; look: "original" | "cute"; onSelect: (botId: string) => void }) {
  return (
    <>
      {members.map((member) => (
        <button key={member.id} type="button" className="group-member" data-bot={member.id} onClick={() => onSelect(member.id)}>
          <img src={faceURL(member, look, { asleep: member.phase === "asleep" && !member.working, working: member.working })} alt="" />
          <span className="group-member-name">{member.name}</span>
          {group.guest === member.id && <span className="group-member-writing">writing…</span>}
        </button>
      ))}
    </>
  );
}

function OpenPanel({ bot, bots, waiting, look, status, results, teams, watching, tasks, messages, summarized, selectedTask, onSelect, onIgnore, onOpenResult, onOpenSubagent, onUnsettle, onSelectTask, onJumpToTask, onAskForReport }: RightPanelProps) {
  const doing = bot.role === "manager" ? waiting.doing[bot.id] : undefined;
  const items = panelWaiting(bot, waiting);
  const settled = settledRows(bot.subagentRows);
  const now = useMinuteClock();
  const active = activeTasks(tasks);
  const open = openTask(tasks, selectedTask);
  const waitingTasks = tasks.filter((task) => task.state === "waiting");
  const finished = finishedTasks(tasks);
  const card = (task: TaskView) => (
    <TaskCard key={task.id} task={task} now={now} stale={isStale(task, bot.working, now)} messages={messages} folded={isFoldedIntoSummary(task, messages, summarized)}
      onSelect={onSelectTask} onJump={onJumpToTask} onReport={onAskForReport} />
  );
  return (
    <aside className="detail-panel" aria-label="Details">
      <div className="detail-head">
        <img className="detail-avatar" src={faceURL(bot, look, { asleep: bot.phase === "asleep" && !bot.working, working: bot.working, waiting: bot.approvals > 0 })} alt="" />
        <span className="detail-name">{bot.name}</span>
      </div>
      <section className="detail-section tasks-section">
        <h3>Tasks</h3>
        <div className="now-card">
          <div className="now-line"><span className="now-dot" data-status={status.key} aria-hidden="true" />{status.text}</div>
          {bot.role === "main" && teams.map((run) => (
            <div key={run.id} className="team-run" title={run.task} data-team={run.name}>
              <img className="team-face" src={avatarURL("cloud")} alt="" />
              <span className="team-title">{run.title}</span>
              <span className="team-time">{Math.max(1, Math.floor((now - run.startedAt) / 60_000))} min</span>
            </div>
          ))}
        </div>
        <div className="task-list">
          {/* A finished task pressed (in Just done, on a chip) shows open on top. */}
          {open && !active.some((task) => task.id === open.id) && card(open)}
          {active.slice(0, 6).map((task) => (task.id === open?.id ? card(task)
            : <TaskRow key={task.id} task={task} now={now} stale={isStale(task, bot.working, now)} onSelect={onSelectTask} />))}
          {active.length === 0 && (doing ? <div className="now-doing">{doing}</div> : <div className="task-none">Nothing under way</div>)}
        </div>
      </section>
      {(items.length > 0 || waitingTasks.length > 0) && (
        <section className="detail-section">
          <h3>Waiting on you</h3>
          {waitingTasks.length > 0 && (
            <div className="waiting-tasks">
              {waitingTasks.map((task) => (
                <button key={task.id} type="button" className="waiting-task" data-task={task.id} onClick={() => onSelectTask(task.id)}>
                  <span className="task-dot" data-state="waiting" aria-hidden="true" />
                  <span className="waiting-task-text"><span className="waiting-task-name">{task.name}</span><span className="waiting-task-why">{task.blocked ?? task.now ?? "your reply"}</span></span>
                  <span className="waiting-chevron" aria-hidden="true">›</span>
                </button>
              ))}
            </div>
          )}
          {items.length > 0 && <WaitingList items={items} bots={bots} look={look} onSelect={onSelect} onIgnore={onIgnore} />}
        </section>
      )}
      {finished.length > 0 && (
        <section className="detail-section done-section">
          <h3>Just done</h3>
          <div className="done-tasks">
            {finished.map((task) => (
              <button key={task.id} type="button" className="done-task" data-task={task.id} onClick={() => onSelectTask(task.id)}>
                <span className={`done-mark ${task.state}`} aria-hidden="true">{task.state === "done" ? "✓" : "■"}</span>
                <span className="done-name">{task.name}</span>
                <span className="done-time">{taskTime(task.updatedAt, now)}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {results.length > 0 && (
        <section className="detail-section results-section">
          <h3>{bot.role === "main" && finished.length === 0 ? "Just done" : "Results"}</h3>
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

// ---------------------------------------------------------------------------------------------
// Tasks (1.x 1.20's TaskPanel.swift)

/** A running task with no news for this long, nothing of it at work, the bot idle: "May be stuck". */
const STALE_MS = 10 * 60_000;
const isStale = (task: TaskView, working: boolean, now: number) => task.state === "running" && !working && !task.atWork && now - new Date(task.updatedAt).getTime() >= STALE_MS;

/** Tasks under way: running (and just sent) first, newest first, then those waiting on you (`TaskSection.active`). */
export function activeTasks(tasks: TaskView[]): TaskView[] {
  return tasks.filter((task) => task.state === "pending" || task.state === "running" || task.state === "waiting")
    .sort((a, b) => ((a.state === "waiting" ? 1 : 0) - (b.state === "waiting" ? 1 : 0)) || (new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()));
}

/** The task shown open: the one pressed, else the latest running one (`TaskSection.open`). */
export function openTask(tasks: TaskView[], selected: string | null): TaskView | null {
  if (selected) { const task = tasks.find((candidate) => candidate.id === selected); if (task) return task; }
  return tasks.filter((task) => task.state === "running").reduce<TaskView | null>((latest, task) => (!latest || new Date(task.updatedAt) > new Date(latest.updatedAt) ? task : latest), null);
}

/** The latest finished tasks (`DoneTaskRows.finished`). */
export function finishedTasks(tasks: TaskView[], limit = 3): TaskView[] {
  return tasks.filter((task) => task.state === "done" || task.state === "stopped")
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, limit);
}

/** "00:24" today, "Yesterday", else the short date (`TaskLook.time`). */
function taskTime(iso: string, now: number): string {
  const date = new Date(iso);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  const yesterday = new Date(now - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** How a task stands, in a line (`TaskRowView.line`). */
function taskLine(task: TaskView, stale: boolean, now: number): string {
  if (stale) return `May be stuck · No news for ${Math.floor((now - new Date(task.updatedAt).getTime()) / 60_000)} min`;
  switch (task.state) {
    case "pending": return "New message · waiting for a head";
    case "waiting": return `Waiting on you: ${task.blocked ?? task.now ?? "your reply"}`;
    case "running": return task.now ? `Now: ${task.now}` : "Running";
    case "done": return "Done";
    case "stopped": return "Stopped";
  }
}

const headName = (engine: string) => (engine === "codex" ? "Codex" : "Claude");

/** Its state dot, its name and the head that owns it (`TaskHeader`). */
function TaskHeader({ task, stale, bold }: { task: TaskView; stale: boolean; bold: boolean }) {
  return (
    <span className="task-header">
      <span className="task-dot" data-state={stale ? "stale" : task.state} aria-hidden="true" />
      <span className={`task-name${bold ? " bold" : ""}`}>{task.name}</span>
      {task.state === "pending" ? <span className="task-claiming">Claiming…</span>
        : task.owner ? <span className="task-owner"><span className="task-owner-dot" data-head={task.owner} aria-hidden="true" />{headName(task.owner)}</span> : null}
    </span>
  );
}

/** A task not open: one line on how it stands; pressed, it opens (`TaskRowView`). */
function TaskRow({ task, now, stale, onSelect }: { task: TaskView; now: number; stale: boolean; onSelect: (id: string) => void }) {
  const line = taskLine(task, stale, now);
  return (
    <button type="button" className="task-row" data-task={task.id} data-state={stale ? "stale" : task.state} onClick={() => onSelect(task.id)} aria-label={`Task ${task.name}: ${line}`}>
      <TaskHeader task={task} stale={stale} bold={false} />
      <span className="task-line">{line}</span>
    </button>
  );
}

/** Every reply of the task is folded into a summary card (`isFoldedIntoSummary`). */
export function isFoldedIntoSummary(task: TaskView, messages: MessageView[], summarized: ReadonlySet<string> | undefined): boolean {
  if (!summarized?.size) return false;
  const mine = new Set(task.messageIds);
  const replies = messages.filter((message) => message.role !== "user" && mine.has(message.id));
  return replies.length > 0 && replies.every((message) => summarized.has(message.id));
}

/** The open task: what it does now, what comes next and what blocks it, when it started, the way to its latest line (`TaskCardView`). */
function TaskCard({ task, now, stale, folded, messages, onSelect, onJump, onReport }: {
  task: TaskView; now: number; stale: boolean; folded: boolean; messages: MessageView[];
  onSelect: (id: string) => void; onJump: (messageId: string, taskId: string) => void; onReport: (task: TaskView, replyTo: string | null) => void;
}) {
  const mine = new Set(task.messageIds);
  const latest = messages.findLast((message) => mine.has(message.id) && message.role !== "user")?.id ?? messages.findLast((message) => mine.has(message.id))?.id ?? null;
  const started = messages.find((message) => mine.has(message.id))?.time ?? task.updatedAt;
  const active = task.state === "pending" || task.state === "running" || task.state === "waiting";
  const field = (label: string, value: string | null, waiting = false) => (
    <div className="task-field"><span className="task-field-label">{label}</span><span className={`task-field-value${value ? "" : " empty"}${waiting ? " waiting" : ""}`}>{value ?? "—"}</span></div>
  );
  return (
    <div className="task-card" data-task={task.id} data-state={stale ? "stale" : task.state} data-active={active ? "1" : "0"}>
      <button type="button" className="task-card-head" title="Close" onClick={() => onSelect(task.id)}><TaskHeader task={task} stale={stale} bold /></button>
      {field("Now", task.now ?? (task.state === "pending" ? "New message · waiting for a head" : null))}
      {field("Next", task.next)}
      {field("Blocked", task.blocked, task.state === "waiting")}
      {(task.helps ?? []).map((help, index) => <div key={index} className="task-help">{headName(help.head)} helping: {help.text}</div>)}
      {(stale || folded) && (
        <div className="task-stale">
          {folded && <span className="task-summary-tag">In the summary</span>}
          {stale && <span>May be stuck</span>}
          {stale && <button type="button" className="task-report" onClick={() => onReport(task, latest)}>Ask it to report</button>}
        </div>
      )}
      <div className="task-foot">
        <span>Started {taskTime(started, now)} · updated {taskTime(task.updatedAt, now)}</span>
        {latest && <button type="button" className="task-jump" onClick={() => onJump(latest, task.id)}>Jump to chat ↗</button>}
      </div>
    </div>
  );
}

function WaitingList({ items, bots, look, onSelect, onIgnore }: { items: WaitingItemView[]; bots: BotView[]; look: "original" | "cute"; onSelect: (botId: string) => void; onIgnore: (item: WaitingItemView) => void }) {
  return (
    <ul className="waiting-list">
      {items.map((item) => {
        const owner = bots.find((candidate) => candidate.id === item.botId);
        return (
          <li key={`${item.botId}-${item.text}`} className="waiting-item" data-bot={item.botId}>
            <button type="button" className="waiting-open" onClick={() => onSelect(item.groupId ?? item.botId)} title={owner ? `Open ${item.groupId ? "the group's" : `${owner.name}'s`} chat` : undefined}>
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
  const items = panelWaiting(bot, waiting);
  const group = bot.role === "group";
  const members = group ? groupMembers(bot, bots) : [];
  const settled = group ? [] : settledRows(bot.subagentRows);
  const counts = ([
    { section: "waiting", count: items.length },
    { section: "members", count: members.length },
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
  const title = (section: Section) => (section === "waiting" ? "Waiting on you" : section === "members" ? "In the group" : section === "results" ? (bot.role === "main" || group ? "Just done" : "Results") : "Settled");
  const symbol = (section: Section) => (section === "waiting" ? "bubbleAlert" : section === "members" ? "people" : section === "results" ? "arrowUpRight" : "checkCircle") as "bubbleAlert" | "people" | "arrowUpRight" | "checkCircle";
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
                {section === "members" && <div className="strip-members"><GroupMembers group={bot} members={members} look={look} onSelect={(id) => { setOpen(null); onSelect(id); }} /></div>}
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
      {!group && (
        <button type="button" className="strip-settings" title={`${bot.name}'s settings`} aria-label="Bot settings" onClick={onSettings}>
          <Icon name="sliders" size={14} />
        </button>
      )}
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
