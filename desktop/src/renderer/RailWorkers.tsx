// The left column's worker list under a bot row (rail-workers.ts decides what shows): each worker one item, its
// worker name over its state and time, and "Settle down" (the settle clock) on a finished one; a sub bot's worker
// labelled with its sub bot. One job's workers are one item: its name, a small dot per worker (running, done,
// failed), failures, count and time below; a click opens it to list them. No blue dot on either: the bot row's count
// is where news shows. Then "N more".
import type { SubagentRowView } from "../contract";
import { Icon } from "./icons";
import { railJobMeta, railJobParts, railJobState, railStateWord, railWords, railWorkerTime, type RailEntry, type RailJob, type RailWorkerItem, type RailWorkerList as List } from "./rail-workers";

export interface RailWorkerActions {
  onOpen: (ownerId: string, row: SubagentRowView) => void;
  onSettle: (ownerId: string, row: SubagentRowView) => void;
  /** "N more" / "Show fewer" for a bot, or a job (its key). */
  onAll: (key: string) => void;
  /** A job clicked open or folded (its key). */
  onToggleJob: (key: string) => void;
}

function StateMark({ state, viewed }: { state: RailWorkerItem["state"]; viewed: boolean }) {
  if (state === "running") return <span className="rail-wk-mark running" aria-hidden="true" />;
  if (state === "failed") return <span className="rail-wk-mark failed" aria-hidden="true">!</span>;
  if (state === "stopped") return <span className="rail-wk-mark stopped" aria-hidden="true">■</span>;
  return <span className={`rail-wk-mark done${viewed ? " viewed" : ""}`} aria-hidden="true"><Icon name="check" size={8} /></span>;
}

function WorkerItem({ item, now, lang, actions }: { item: RailWorkerItem; now: number; lang: string | null; actions: RailWorkerActions }) {
  const w = railWords(lang);
  const name = item.row.title || "Worker";
  const state = railStateWord(item, lang);
  const time = railWorkerTime(item, now, lang);
  const classes = ["rail-wk-row", item.state, item.viewed ? "viewed" : "", item.selected ? "selected" : ""].filter(Boolean).join(" ");
  return (
    <div className={classes} data-worker={item.row.id}>
      <button type="button" className="rail-wk-open" title={item.row.prompt} onClick={() => actions.onOpen(item.ownerId, item.row)}
        aria-current={item.selected ? "page" : undefined} aria-label={[name, item.subBot ? w.ofSubBot(item.subBot.name) : "", state, time].filter(Boolean).join(", ")}>
        <span className="subagent-arrow" aria-hidden="true"><Icon name="turnDownRight" size={11} /></span>
        <StateMark state={item.state} viewed={item.viewed} />
        <span className="rail-wk-text">
          <span className="rail-wk-name">{name}</span>
          <span className="rail-wk-meta">
            <SubBotTag subBot={item.subBot} />
            <span className="rail-wk-state">{state}</span>{time && <>・{time}</>}
          </span>
        </span>
      </button>
      {item.state !== "running" && (
        <button type="button" className="rail-wk-settle" title={w.settleHint} aria-label={`${w.settle} ${name}`} onClick={() => actions.onSettle(item.ownerId, item.row)}>
          <Icon name="clock" size={12} />
        </button>
      )}
    </div>
  );
}

function SubBotTag({ subBot }: { subBot: RailWorkerItem["subBot"] }) {
  if (!subBot) return null;
  return <span className="rail-wk-tag" data-sub-bot={subBot.id}><span className="rail-wk-subface" aria-hidden="true">{subBot.name.trim().charAt(0).toUpperCase() || "?"}</span>{subBot.name}</span>;
}

function More({ more, showingAll, label, onClick, lang }: { more: number; showingAll: boolean; label: string; onClick: () => void; lang: string | null }) {
  const w = railWords(lang);
  if (more <= 0 && !showingAll) return null;
  return (
    <button type="button" className="rail-wk-more" onClick={onClick} aria-label={more > 0 ? label : w.fewer}>
      {more > 0 ? w.more(more) : w.fewer}
      <span className={`rail-wk-chevron${more > 0 ? "" : " open"}`} aria-hidden="true"><Icon name="chevronLeft" size={9} /></span>
    </button>
  );
}

/** One job's workers as one item; opened, its workers under it. */
function JobItem({ job, now, lang, actions }: { job: RailJob; now: number; lang: string | null; actions: RailWorkerActions }) {
  const w = railWords(lang);
  const state = railJobState(job);
  const meta = railJobMeta(job, now, lang);
  const parts = railJobParts(job, now, lang);
  // Its state is not a class: the worker rows' state colours (green "Done", red "Failed") are not its second line's.
  const classes = ["rail-wk-row", "rail-wk-job", job.open ? "open" : "", job.selected ? "selected" : ""].filter(Boolean).join(" ");
  return (
    <div className="rail-wk-jobwrap" data-job={job.key}>
      <div className={classes} data-state={state}>
        <button type="button" className="rail-wk-open" aria-expanded={job.open} onClick={() => actions.onToggleJob(job.key)}
          aria-label={[job.open ? w.closeJob(job.title) : w.openJob(job.title, job.members.length), job.subBot ? w.ofSubBot(job.subBot.name) : "", meta].filter(Boolean).join(", ")}>
          <span className="subagent-arrow" aria-hidden="true"><Icon name="turnDownRight" size={11} /></span>
          <StateMark state={state} viewed={false} />
          <span className="rail-wk-text">
            {/* The dots beside the name, outside its ellipsis: a long name is cut, never the dots. */}
            <span className="rail-wk-jobline">
              <span className="rail-wk-name">{job.title}</span>
              <span className="rail-wk-pips" aria-hidden="true">{job.members.map((item) => <span key={item.row.id} className={`rail-wk-pip ${item.state}`} />)}</span>
            </span>
            <span className="rail-wk-meta"><SubBotTag subBot={job.subBot} /><span className="rail-wk-state">{parts.failed && <><span className="rail-wk-failed">{parts.failed}</span>{w.sep}</>}{parts.rest}</span></span>
          </span>
          <span className={`rail-wk-chevron${job.open ? " open" : ""}`} aria-hidden="true"><Icon name="chevronLeft" size={9} /></span>
        </button>
      </div>
      {job.open && (
        <div className="rail-wk-members">
          {job.shown.map((item) => <WorkerItem key={item.row.id} item={item} now={now} lang={lang} actions={actions} />)}
          <More more={job.more} showingAll={job.showingAll} label={w.moreLabel(job.title, job.more)} onClick={() => actions.onAll(job.key)} lang={lang} />
        </div>
      )}
    </div>
  );
}

const entryKey = (entry: RailEntry) => (entry.kind === "job" ? entry.key : entry.groupKey);

/** A bot's list (its sub bots' workers in it, labelled). */
export function RailWorkerList({ botId, list, name, now, lang, actions }: {
  botId: string; list: Pick<List, "items" | "more" | "showingAll">; name: string; now: number; lang: string | null; actions: RailWorkerActions;
}) {
  const w = railWords(lang);
  return (
    <div className="rail-wk" data-bot={botId}>
      {list.items.map((entry) => entry.kind === "job"
        ? <JobItem key={entryKey(entry)} job={entry} now={now} lang={lang} actions={actions} />
        : <WorkerItem key={entryKey(entry)} item={entry} now={now} lang={lang} actions={actions} />)}
      <More more={list.more} showingAll={list.showingAll} label={w.moreLabel(name, list.more)} onClick={() => actions.onAll(botId)} lang={lang} />
    </div>
  );
}
