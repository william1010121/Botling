// The left column's worker list under a bot row (rail-workers.ts decides what shows): each worker one item, its
// worker name over its state and time; a blue dot until you open a finished one, and "Settle down" (the settle
// clock) on a finished one; a sub bot's worker labelled with its sub bot. Then "N more".
import type { SubagentRowView } from "../contract";
import { Icon } from "./icons";
import { railStateWord, railWords, railWorkerTime, type RailWorkerItem, type RailWorkerList as List } from "./rail-workers";

export interface RailWorkerActions {
  onOpen: (ownerId: string, row: SubagentRowView) => void;
  onSettle: (ownerId: string, row: SubagentRowView) => void;
  /** "N more" / "Show fewer" for a bot. */
  onAll: (botId: string) => void;
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
  const classes = ["rail-wk-row", item.state, item.unread ? "unread" : "", item.viewed ? "viewed" : "", item.selected ? "selected" : ""].filter(Boolean).join(" ");
  return (
    <div className={classes} data-worker={item.row.id}>
      <button type="button" className="rail-wk-open" title={item.row.prompt} onClick={() => actions.onOpen(item.ownerId, item.row)}
        aria-current={item.selected ? "page" : undefined} aria-label={[name, item.subBot ? w.ofSubBot(item.subBot.name) : "", state, time, item.unread ? "unread" : ""].filter(Boolean).join(", ")}>
        <span className="subagent-arrow" aria-hidden="true"><Icon name="turnDownRight" size={11} /></span>
        <StateMark state={item.state} viewed={item.viewed} />
        <span className="rail-wk-text">
          <span className="rail-wk-name">{name}</span>
          <span className="rail-wk-meta">
            {item.subBot && <span className="rail-wk-tag" data-sub-bot={item.subBot.id}><span className="rail-wk-subface" aria-hidden="true">{item.subBot.name.trim().charAt(0).toUpperCase() || "?"}</span>{item.subBot.name}</span>}
            <span className="rail-wk-state">{state}</span>{time && <>・{time}</>}
          </span>
        </span>
        {item.unread && <span className="rail-wk-dot" aria-hidden="true" />}
      </button>
      {item.state !== "running" && (
        <button type="button" className="rail-wk-settle" title={w.settleHint} aria-label={`${w.settle} ${name}`} onClick={() => actions.onSettle(item.ownerId, item.row)}>
          <Icon name="clock" size={12} />
        </button>
      )}
    </div>
  );
}

/** A bot's list (its sub bots' workers in it, labelled). */
export function RailWorkerList({ botId, list, name, now, lang, actions }: {
  botId: string; list: Pick<List, "items" | "more" | "showingAll">; name: string; now: number; lang: string | null; actions: RailWorkerActions;
}) {
  const w = railWords(lang);
  return (
    <div className="rail-wk" data-bot={botId}>
      {list.items.map((item) => <WorkerItem key={item.groupKey} item={item} now={now} lang={lang} actions={actions} />)}
      {(list.more > 0 || list.showingAll) && (
        <button type="button" className="rail-wk-more" onClick={() => actions.onAll(botId)}
          aria-label={list.more > 0 ? w.moreLabel(name, list.more) : w.fewer}>
          {list.more > 0 ? w.more(list.more) : w.fewer}
          <span className={`rail-wk-chevron${list.more > 0 ? "" : " open"}`} aria-hidden="true"><Icon name="chevronLeft" size={9} /></span>
        </button>
      )}
    </div>
  );
}
