// The right panel (1.x's DetailPanel): the bot on screen, its Now card (status; a manager's first
// "In progress" line from its memory.md; the main bot's temporary teams at work), its tasks grouped
// into Needs you / Running / Done (design R2-3: a row each, opened in place, a timeline on hover) and, for the main
// bot, "Waiting on you" — every bot's open question or its memory's "Waiting on you", each opening
// that bot's chat, with × to ignore it (1.x's WaitingList). Then Results ("Just done" for the main
// bot: the links handed over in the chat, the newest three) and Settled (the subagents you settled
// out of the left column). Folded (⌃⌘I, the button at the window's top right), it is 1.x's RightStrip:
// the face with its status dot (hover for the Now card), an icon per section with a count, each
// opening that section beside the strip, and the bot's settings at the bottom. The bot's settings
// live one level in (1.x's DetailPanel `showingSettings`): the slider button on the name row, or the
// strip's bottom one, shows them in the overview's place, with Back.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ShellOverlay, shellPortal } from "./ShellOverlay";
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
  onCompleteTask: (id: string) => void;
  /** A group's "Rename, add or take out members". */
  onEditGroup: () => void;
  collapsed: boolean;
  onSelect: (botId: string) => void;
  onIgnore: (item: WaitingItemView) => void;
  onOpenResult: (result: ResultView) => void;
  onOpenSubagent: (row: Pick<SubagentRowView, "id">) => void;
  onUnsettle: (row: SubagentRowView) => void;
  /** Open the bot's settings in the panel (the strip's button also opens the panel). */
  onSettings: () => void;
  /** The bot's settings shown in the overview's place, and their page (1.x's SettingsPage). */
  showingSettings?: boolean;
  settingsPage?: ReactNode;
  onCloseSettings?: () => void;
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
  return <Overview {...props} />;
}

function Overview({ bot, bots, waiting, look, status, results, teams, watching, tasks: all, messages, summarized, selectedTask, onSelect, onIgnore, onOpenResult, onOpenSubagent, onUnsettle, onSelectTask, onJumpToTask, onAskForReport, onCompleteTask, onSettings }: RightPanelProps) {
  const doing = bot.role === "manager" ? waiting.doing[bot.id] : undefined;
  const items = panelWaiting(bot, waiting);
  const settled = settledRows(bot.subagentRows);
  const now = useMinuteClock();
  // A card with no name has nothing to show yet (its head names it with a <task> line).
  const tasks = all.filter((task) => task.name.trim().length > 0);
  const active = activeTasks(tasks);
  // While a task is under way its card says what the bot does; the bot's own line would be a bare "Writing…" card.
  const showNow = active.length === 0 || (bot.role === "main" && teams.length > 0);
  const finished = finishedTasks(tasks);
  return (
    <aside className="detail-panel" aria-label="Details">
      <div className="detail-head">
        <img className="detail-avatar" src={faceURL(bot, look, { asleep: bot.phase === "asleep" && !bot.working, working: bot.working, waiting: bot.approvals > 0 })} alt="" />
        <span className="detail-name">{bot.name}</span>
        <span className="bot-gap" />
        <button type="button" className="detail-settings" title={`${bot.name}'s settings`} aria-label="Bot settings" onClick={onSettings}><Icon name="sliders" size={15} /></button>
      </div>
      <section className="detail-section tasks-section">
        {tasks.length === 0 && <h3>Tasks</h3>}
        {showNow && <div className="now-card">
          <div className="now-line"><span className="now-dot" data-status={status.key} aria-hidden="true" />{status.text}</div>
          {bot.role === "main" && teams.map((run) => (
            <div key={run.id} className="team-run" title={run.task} data-team={run.name}>
              <img className="team-face" src={avatarURL("cloud")} alt="" />
              <span className="team-title">{run.title}</span>
              <span className="team-time">{Math.max(1, Math.floor((now - run.startedAt) / 60_000))} min</span>
            </div>
          ))}
        </div>}
        {active.length === 0 && (doing ? <div className="now-doing">{doing}</div> : !bot.working && <div className="task-none">Nothing under way</div>)}
        <TaskGroups key={bot.id} tasks={tasks} now={now} working={bot.working} messages={messages} summarized={summarized} selected={selectedTask}
          onSelect={onSelectTask} onJump={onJumpToTask} onReport={onAskForReport} onComplete={onCompleteTask} onOpenSubagent={onOpenSubagent} />
      </section>
      {items.length > 0 && (
        <section className="detail-section">
          <h3>Waiting on you</h3>
          <WaitingList items={items} bots={bots} look={look} onSelect={onSelect} onIgnore={onIgnore} />
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
          <SettledList avatar={bot.avatar} look={look} rows={settled} watching={watching} onOpen={onOpenSubagent} onUnsettle={onUnsettle} />
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

/** How a task stands, in its row's second line (`TaskRowView.line`; design R2-3). */
function taskLine(task: TaskView, stale: boolean, now: number): string {
  if (stale) return `May be stuck · No news for ${Math.floor((now - new Date(task.updatedAt).getTime()) / 60_000)} min`;
  switch (task.state) {
    case "pending": return "New message · waiting for a head";
    case "waiting": return task.blocked ?? task.now ?? "Waiting on your reply";
    case "running": return task.now ?? "Running";
    case "done": return `Done · ${taskTime(task.updatedAt, now)}`;
    case "stopped": return `Stopped · ${taskTime(task.updatedAt, now)}`;
  }
}

const headName = (engine: string) => (engine === "codex" ? "Codex" : "Claude");
const isActiveTask = (task: TaskView) => task.state === "pending" || task.state === "running" || task.state === "waiting";
const minutes = (from: string, now: number) => Math.max(1, Math.floor((now - new Date(from).getTime()) / 60_000));

/** The design's round check: Mark complete, on a row and at the open card's top right. */
function CheckButton({ className, onClick }: { className: string; onClick: () => void }) {
  return (
    <button type="button" className={className} aria-label="Mark complete" title="Mark complete" onClick={onClick}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>
    </button>
  );
}

const Chevron = ({ className }: { className?: string }) => (
  <svg className={className} width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 3l5 5-5 5" /></svg>
);

type GroupKey = "waiting" | "running" | "done";
const GROUPS: { key: GroupKey; title: string }[] = [{ key: "waiting", title: "Needs you" }, { key: "running", title: "Running" }, { key: "done", title: "Done" }];
const groupOf = (task: TaskView): GroupKey => (task.state === "waiting" ? "waiting" : task.state === "pending" || task.state === "running" ? "running" : "done");

interface TaskListProps {
  tasks: TaskView[]; now: number; working: boolean; messages: MessageView[]; summarized: ReadonlySet<string> | undefined; selected: string | null;
  onSelect: (id: string) => void; onJump: (messageId: string, taskId: string) => void; onReport: (task: TaskView, replyTo: string | null) => void;
  onComplete: (id: string) => void; onOpenSubagent: (row: Pick<SubagentRowView, "id">) => void;
}

/** How long a row is hovered before its timeline floats beside it. */
const HOVER_MS = 250;

/**
 * The task list (design R2-3 "Grouped"): Needs you, Running and Done, each with its count and a
 * fold (Done starts folded), one dense row per task. A row pressed opens in place; hovered, it
 * floats the task's timeline to the panel's left.
 */
function TaskGroups(props: TaskListProps) {
  const { tasks, now, working, selected } = props;
  const [folded, setFolded] = useState<Record<GroupKey, boolean>>({ waiting: false, running: false, done: true });
  const [hover, setHover] = useState<{ id: string; top: number; right: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  useEffect(() => cancel, []);
  const enter = (id: string, row: HTMLElement) => {
    cancel();
    timer.current = setTimeout(() => {
      const box = row.getBoundingClientRect();
      setHover({ id, top: box.top + box.height / 2, right: window.innerWidth - box.left + 12 });
    }, HOVER_MS);
  };
  const leave = () => { cancel(); setHover(null); };
  // A drag folds the timeline away: it floats over the chat column, above the chat frame, where
  // the frame's file-drop outline (frame.css, inside the frame) could not show over it.
  useEffect(() => {
    const fold = () => { cancel(); setHover(null); };
    window.addEventListener("dragstart", fold, true);
    window.addEventListener("dragenter", fold, true);
    return () => { window.removeEventListener("dragstart", fold, true); window.removeEventListener("dragenter", fold, true); };
  }, []);
  const lists: Record<GroupKey, TaskView[]> = {
    waiting: activeTasks(tasks).filter((task) => task.state === "waiting"),
    running: activeTasks(tasks).filter((task) => task.state !== "waiting"),
    done: finishedTasks(tasks, Infinity),
  };
  const selectedGroup = tasks.find((task) => task.id === selected);
  const hovered = hover ? tasks.find((task) => task.id === hover.id && task.id !== selected) : undefined;
  if (!tasks.length) return null;
  return (
    <div className="task-groups">
      {GROUPS.filter((group) => lists[group.key].length > 0).map((group) => {
        // A task opened from elsewhere (a chip, a link) unfolds its group.
        const open = !folded[group.key] || (!!selectedGroup && groupOf(selectedGroup) === group.key);
        return (
          <section key={group.key} className="task-group" data-group={group.key}>
            <div className="task-group-head">
              <h3>{group.title}</h3>
              <span className="task-group-count" data-group={group.key}>{lists[group.key].length}</span>
              <button type="button" className="task-group-fold" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} ${group.title.toLowerCase()}`}
                onClick={() => setFolded((current) => ({ ...current, [group.key]: open }))}>
                <Chevron className={open ? "open" : undefined} />
              </button>
            </div>
            {open && (
              <div className="task-list">
                {lists[group.key].map((task) => {
                  const stale = isStale(task, working, now);
                  return task.id === selected
                    ? <TaskCard key={task.id} {...props} task={task} stale={stale} folded={isFoldedIntoSummary(task, props.messages, props.summarized)} />
                    : <TaskRow key={task.id} task={task} now={now} stale={stale} hovered={hover?.id === task.id} onSelect={(id) => { leave(); props.onSelect(id); }} onComplete={props.onComplete} onEnter={enter} onLeave={leave} />;
                })}
              </div>
            )}
          </section>
        );
      })}
      {hover && hovered && shellPortal(<TaskTimeline task={hovered} now={now} top={hover.top} right={hover.right} />)}
    </div>
  );
}

/** A task not open: its state dot, name and a line on how it stands, its head, and Mark complete while under way. */
function TaskRow({ task, now, stale, hovered, onSelect, onComplete, onEnter, onLeave }: {
  task: TaskView; now: number; stale: boolean; hovered: boolean; onSelect: (id: string) => void; onComplete: (id: string) => void;
  onEnter: (id: string, row: HTMLElement) => void; onLeave: () => void;
}) {
  const line = taskLine(task, stale, now);
  const state = stale ? "stale" : task.state;
  return (
    <div className={`task-row${hovered ? " hov" : ""}`} data-task={task.id} data-state={state} onMouseEnter={(event) => onEnter(task.id, event.currentTarget)} onMouseLeave={onLeave}>
      <span className="task-dot" data-state={state} aria-hidden="true" />
      <button type="button" className="task-row-open" aria-label={`Task ${task.name}: ${line}`} onClick={() => onSelect(task.id)}
        title={task.manuallyCompletedAt ? "Marked complete by you" : undefined}>
        <span className="task-row-name">{task.name}</span>
        <span className="task-line">{line}</span>
      </button>
      {task.owner && <span className="task-owner-dot" data-head={task.owner} title={headName(task.owner)} />}
      {isActiveTask(task) && <CheckButton className="task-check" onClick={() => onComplete(task.id)} />}
    </div>
  );
}

/** Every reply of the task is folded into a summary card (`isFoldedIntoSummary`). */
export function isFoldedIntoSummary(task: TaskView, messages: MessageView[], summarized: ReadonlySet<string> | undefined): boolean {
  if (!summarized?.size) return false;
  const mine = new Set(task.messageIds);
  const replies = messages.filter((message) => message.role !== "user" && mine.has(message.id));
  return replies.length > 0 && replies.every((message) => summarized.has(message.id));
}

/** The open task: its head and age, what blocks it, Now → Next, its subagents, and the way to its latest line (`TaskCardView`). */
function TaskCard({ task, now, stale, folded, messages, onSelect, onJump, onReport, onComplete, onOpenSubagent }: TaskListProps & { task: TaskView; stale: boolean; folded: boolean }) {
  const mine = new Set(task.messageIds);
  const latest = messages.findLast((message) => mine.has(message.id) && message.role !== "user")?.id ?? messages.findLast((message) => mine.has(message.id))?.id ?? null;
  const started = task.createdAt ?? messages.find((message) => mine.has(message.id))?.time ?? task.updatedAt;
  const active = isActiveTask(task);
  const running = task.relatedAgents?.filter((agent) => agent.status === "running").length ?? 0;
  const age = task.state === "waiting" ? `waiting ${minutes(task.updatedAt, now)} min` : active ? `${minutes(started, now)} min` : taskTime(task.updatedAt, now);
  const word = task.relatedAgents?.every((agent) => agent.engine === "codex") ? "workers" : "subagents";
  // Only the steps that say something: an empty Now or Next is left out.
  const steps = ([["now", "Now", task.now], ["next", "Next", task.next]] as const).filter(([, , value]) => !!value?.trim());
  return (
    <div className="task-card" data-task={task.id} data-state={stale ? "stale" : task.state} data-active={active ? "1" : "0"}>
      {/* The name, and Mark complete in the card's top-right corner. */}
      <div className="task-card-top">
        <button type="button" className="task-card-head" title="Close" onClick={() => onSelect(task.id)}><span className="task-name bold">{task.name}</span></button>
        {active && <CheckButton className="task-complete" onClick={() => onComplete(task.id)} />}
      </div>
      <div className="task-meta">
        {task.state === "pending" ? <span className="task-claiming">Claiming…</span>
          : task.owner ? <span className="task-owner"><span className="task-owner-dot" data-head={task.owner} aria-hidden="true" />{headName(task.owner)}</span> : null}
        <span>· {age}</span>
      </div>
      {task.state === "waiting" && task.blocked?.trim() && (
        <div className="task-blocked">
          <span>{task.blocked}</span>
          {latest && <button type="button" className="task-answer" onClick={() => onJump(latest, task.id)}>Answer</button>}
        </div>
      )}
      {task.state !== "waiting" && task.blocked?.trim() && <div className="task-blocked quiet"><span>{task.blocked}</span></div>}
      {steps.length > 0 && (
        <div className="task-track">
          {steps.map(([key, label, value], index) => (
            <div key={key} className="task-step task-field" data-step={key}>
              <span className="task-step-mark" aria-hidden="true"><span className={`task-step-dot ${key}`} />{index < steps.length - 1 && <span className="task-step-line" />}</span>
              <span className="task-step-body"><span className="task-field-label">{label}</span><span className="task-field-value">{value}</span></span>
            </div>
          ))}
        </div>
      )}
      {(task.helps ?? []).map((help, index) => <div key={index} className="task-help">{headName(help.head)} helping: {help.text}</div>)}
      {/* Folded: a line with the count; pressed, the list. No related subagents, nothing at all. */}
      {(task.relatedAgents?.length ?? 0) > 0 && (
        <details className="task-agents" aria-label="Related subagents">
          <summary><Chevron className="task-agents-chevron" />Related {word} ({task.relatedAgents!.length}){running ? <> · <span className="task-agents-on">{running} active</span></> : null}</summary>
          {task.relatedAgents!.map((agent) => {
            const meta = [agent.engine ? headName(agent.engine) : null, agent.status].filter(Boolean).join(" · ");
            const content = <><span className="task-agent-title">{agent.title}</span>{meta && <span className="task-agent-meta">{meta}</span>}</>;
            return agent.available
              ? <button key={agent.id} type="button" className="task-agent" data-status={agent.status} data-agent={agent.id} title={agent.id} aria-label={`Open subagent ${agent.title}, ${agent.status}`} onClick={() => onOpenSubagent({ id: agent.id })}>{content}<span className="task-agent-open" aria-hidden="true">↗</span></button>
              : <div key={agent.id} className="task-agent unavailable" data-agent={agent.id} title={agent.id}>{content}</div>;
          })}
        </details>
      )}
      {(stale || folded) && (
        <div className="task-stale">
          {folded && <span className="task-summary-tag">In the summary</span>}
          {stale && <span>May be stuck</span>}
          {stale && <button type="button" className="task-report" onClick={() => onReport(task, latest)}>Ask it to report</button>}
        </div>
      )}
      <div className="task-foot">
        <span title={task.manuallyCompletedAt ? "Marked complete by you" : undefined}>{active ? `Started ${taskTime(started, now)}` : `${task.state === "done" ? "Done" : "Stopped"} ${taskTime(task.updatedAt, now)}`}</span>
        {latest && <button type="button" className="task-jump" onClick={() => onJump(latest, task.id)}>Jump to chat ↗</button>}
      </div>
    </div>
  );
}

export interface TimelineEvent { kind: NonNullable<TaskView["history"]>[number]["kind"] | "next"; at: string; label: string; text: string | null }

const EVENT_LABELS: Record<TimelineEvent["kind"], string> = { start: "Started", now: "Now", waiting: "Waiting", you: "You", subagent: "Subagent", done: "Done", stopped: "Stopped", complete: "Done", next: "Next" };

/**
 * A task's timeline from its start to now: its recorded updates (2.x), or for a card saved before
 * they were kept, what it has (its start, its Now or blocker, how it ended); then its Next.
 */
export function taskTimeline(task: TaskView): TimelineEvent[] {
  const agents = new Map((task.relatedAgents ?? []).map((agent) => [agent.id, agent]));
  let events: { kind: TimelineEvent["kind"]; at: string; text: string | null }[] = task.history?.length ? [...task.history] : [];
  if (!events.length) {
    if (task.state === "waiting") events.push({ kind: "waiting", at: task.updatedAt, text: task.blocked ?? task.now });
    else if (task.now && isActiveTask(task)) events.push({ kind: "now", at: task.updatedAt, text: task.now });
    if (task.manuallyCompletedAt) events.push({ kind: "complete", at: task.manuallyCompletedAt, text: null });
    else if (task.state === "done" || task.state === "stopped") events.push({ kind: task.state, at: task.updatedAt, text: null });
  }
  if ((task.createdAt || events.length) && events[0]?.kind !== "start") events = [{ kind: "start", at: task.createdAt ?? events[0]!.at, text: null }, ...events];
  if (isActiveTask(task) && task.next?.trim()) events.push({ kind: "next", at: events.at(-1)?.at ?? task.updatedAt, text: task.next });
  return events.map((event) => {
    const agent = event.kind === "subagent" && event.text ? agents.get(event.text) : undefined;
    return {
      kind: event.kind, at: event.at,
      label: event.kind === "subagent" && agent?.engine === "codex" ? "Worker" : EVENT_LABELS[event.kind],
      text: event.kind === "subagent" ? (agent?.title ?? event.text) : event.kind === "complete" ? "Marked by you" : event.text,
    };
  });
}

/** The card a hovered row floats to the panel's left: the task's name and head, then its timeline. */
function TaskTimeline({ task, now, top, right }: { task: TaskView; now: number; top: number; right: number }) {
  const events = taskTimeline(task);
  const tall = Math.min(window.innerHeight - 16, 120 + events.length * 28);
  const y = Math.max(8, Math.min(top - 39, window.innerHeight - tall - 8));
  return (
    <div className="task-timeline" role="tooltip" style={{ top: y, right }}>
      <span className="task-timeline-arrow" aria-hidden="true" style={{ top: Math.max(12, top - y - 5) }} />
      <div className="task-timeline-head">
        <span className="task-dot" data-state={task.state} aria-hidden="true" />
        <span className="task-timeline-name">{task.name}</span>
        {task.owner && <span className="task-owner"><span className="task-owner-dot" data-head={task.owner} aria-hidden="true" />{headName(task.owner)}</span>}
      </div>
      <div className="task-events">
        {events.map((event, index) => (
          <div key={index} className="task-event" data-kind={event.kind}>
            <span className="task-event-time">{taskTime(event.at, now)}</span>
            <span className="task-event-mark" aria-hidden="true"><span className="task-event-dot" />{index < events.length - 1 && <span className="task-event-line" />}</span>
            <span className="task-event-text"><span className="task-event-label">{event.label}</span>{event.text}</span>
          </div>
        ))}
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
function SettledList({ avatar, look, rows, watching, onOpen, onUnsettle }: { avatar: string; look: "original" | "cute"; rows: SubagentRowView[]; watching: string | null; onOpen: (row: SubagentRowView) => void; onUnsettle: (row: SubagentRowView) => void }) {
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
            <ShellOverlay><div className="strip-flyout" role="dialog" aria-label={title(section)}>
              <div className="strip-flyout-head"><span>{title(section)}</span><span className="strip-esc">Esc to close</span></div>
              <div className="strip-flyout-body">
                {section === "waiting" && <WaitingList items={items} bots={bots} look={look} onSelect={(id) => { setOpen(null); onSelect(id); }} onIgnore={onIgnore} />}
                {section === "members" && <div className="strip-members"><GroupMembers group={bot} members={members} look={look} onSelect={(id) => { setOpen(null); onSelect(id); }} /></div>}
                {section === "results" && (
                  <div className="result-list">
                    {results.slice(0, 12).map((result) => <ResultRow key={`${result.label}\u0000${result.url}`} result={result} compact onOpen={(chosen) => { setOpen(null); onOpenResult(chosen); }} />)}
                  </div>
                )}
                {section === "settled" && <SettledList avatar={bot.avatar} look={look} rows={settled} watching={watching} onOpen={onOpenSubagent} onUnsettle={onUnsettle} />}
              </div>
            </div></ShellOverlay>
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
