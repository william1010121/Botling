// The bot's routines (routines.cron and the app's own schedules), with Pause / Resume / Cancel: the body of the popover under
// the chat header's Routines button. It reads and changes them through the program part (host.ts).
// Grouped by where each stands (needs a look, running, paused, finished); a card says what kind it is, how often, when it runs
// next and, for a watch, how its last run went. Cancel asks once more, since it cannot be undone.
import { useEffect, useRef, useState } from "react";
import type { RoutineRow, RoutinesList } from "../../../../Web/host/src/api";
import {
  GROUPS, GROUP_LABEL, KIND_LABEL, LABEL, cadence, groupOf, kindOf, nextRun, onceTime, operationsFor, standing, summary, watchResult, zoneName,
  type Group, type Operation,
} from "./routines-text";

export interface RoutinesSource {
  list(): Promise<RoutinesList>;
  change(operation: Operation, id: string): Promise<RoutinesList>;
}

const why = (failure: unknown) => String((failure as Error)?.message ?? failure);

const ICON = {
  once: <><circle cx="8" cy="8" r="5.6" /><path d="M8 4.8V8l2.2 1.4" /></>,
  repeat: <><path d="M3 7.2V6.4A2.4 2.4 0 0 1 5.4 4H12" /><path d="m10.2 2 2 2-2 2" /><path d="M13 8.8v.8A2.4 2.4 0 0 1 10.6 12H4" /><path d="m5.8 14-2-2 2-2" /></>,
  watch: <><path d="M1.6 8S3.9 3.6 8 3.6 14.4 8 14.4 8 12.1 12.4 8 12.4 1.6 8 1.6 8Z" /><circle cx="8" cy="8" r="1.9" /></>,
};
function KindIcon({ kind }: { kind: keyof typeof ICON }) {
  return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICON[kind]}</svg>;
}

/** The "when" lines of a card: how often (or the one time), and when it runs next. */
function When({ routine, now }: { routine: RoutineRow; now: number }) {
  const kind = kindOf(routine);
  const next = nextRun(routine, now);
  const zone = zoneName(routine);
  const status = routine.status;
  const over = status === "fired" || status === "cancelled" || status === "delivery_uncertain";
  const once = routine.kind === "once" ? onceTime(routine, now) : null;
  return (
    <>
      <div className="routine-meta">
        <span className="routine-kind">{KIND_LABEL[kind]}</span>
        {(once ? over : true) && <><span className="routine-sep">·</span><span className="routine-cadence">{once ? once : cadence(routine)}</span></>}
        {zone && <span className="routine-zone" title={routine.timezone}>{zone}</span>}
      </div>
      {next && <div className="routine-next"><span>Next</span> <b>{next.at}</b> <span className="routine-away">{next.away}</span></div>}
    </>
  );
}

function Card({ routine, now, busy, confirming, onAsk, onChange }: {
  routine: RoutineRow; now: number; busy: boolean; confirming: boolean; onAsk: (id: string | null) => void; onChange: (operation: Operation, id: string) => void;
}) {
  const group = groupOf(routine);
  const kind = kindOf(routine);
  const state = standing(routine);
  const result = watchResult(routine, now);
  const operations = operationsFor(routine.status);
  const compact = group === "done" || group === "paused";
  const task = routine.watch ? null : routine.task && routine.task !== routine.title ? routine.task : null;
  return (
    <li data-status={routine.status} data-kind={kind} data-group={group}>
      <span className="routine-icon" data-tone={state.tone}><KindIcon kind={kind} /></span>
      <div className="routine-body">
        <div className="routine-head">
          <div className="routine-title">{routine.title}</div>
          <span className="routine-state" data-tone={state.tone}>{state.word}</span>
        </div>
        <When routine={routine} now={now} />
        {task && !compact && <div className="routine-task">{task}</div>}
        {routine.watch && (
          <div className="routine-watch" data-watch={routine.watch.state}>
            <code>{routine.watch.command}</code>
            {result && <div className="routine-result" data-tone={result.tone}><i />{result.word}{result.detail && <span> · {result.detail}</span>}</div>}
          </div>
        )}
        {routine.status === "delivery_uncertain" && <div className="routine-note">It may not have reached the bot. Check the chat before asking again.</div>}
        {operations.length > 0 && (confirming ? (
          <div className="routine-buttons routine-confirm" role="group" aria-label="Cancel this routine?">
            <span>Cancel this routine?</span>
            <button type="button" className="danger" disabled={busy} onClick={() => { onAsk(null); onChange("cancel", routine.id); }}>Yes, cancel</button>
            <button type="button" onClick={() => onAsk(null)}>Keep</button>
          </div>
        ) : (
          <div className="routine-buttons">
            {operations.map((operation) => (
              <button key={operation} type="button" data-op={operation} disabled={busy} onClick={() => (operation === "cancel" ? onAsk(routine.id) : onChange(operation, routine.id))}>{LABEL[operation]}</button>
            ))}
          </div>
        ))}
      </div>
    </li>
  );
}

export function RoutinesPanel({ source }: { source: RoutinesSource }) {
  const [list, setList] = useState<RoutinesList | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const working = useRef(false); // a double tap never sends twice
  useEffect(() => { void source.list().then(setList, (failure) => setProblem(why(failure))); }, [source]);
  const change = (operation: Operation, id: string) => {
    if (working.current) return;
    working.current = true;
    setProblem(null);
    setBusy(id);
    void source.change(operation, id).then(setList, (failure) => setProblem(why(failure))).finally(() => { working.current = false; setBusy(null); });
  };
  const now = Date.now();
  const routines = list?.routines ?? [];
  const byGroup = (group: Group) => routines.filter((routine) => groupOf(routine) === group)
    .sort((a, b) => (Date.parse(a.next ?? "") || Infinity) - (Date.parse(b.next ?? "") || Infinity));
  return (
    <div className="routines">
      {list?.error && <p className="routines-problem">{list.error}</p>}
      {problem && <p className="routines-problem">{problem}</p>}
      {list && !routines.length && <p className="routines-empty">No routines yet. Ask the bot to schedule one.</p>}
      {routines.length > 0 && <div className="routines-summary">{summary(routines)}</div>}
      {GROUPS.map((group) => {
        const rows = byGroup(group);
        return rows.length > 0 && (
          <section key={group} data-group={group}>
            <h4>{GROUP_LABEL[group]}<span>{rows.length}</span></h4>
            <ul>
              {rows.map((routine) => (
                <Card key={routine.id} routine={routine} now={now} busy={busy === routine.id} confirming={confirming === routine.id} onAsk={setConfirming} onChange={change} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
