// The bot's routines (routines.cron and the app's own schedules), with Pause / Resume / Cancel: the body of the popover under
// the chat header's Routines button. It reads and changes them through the program part (host.ts).
import { useEffect, useState } from "react";
import type { RoutinesList } from "../../../../Web/host/src/api";
import { LABEL, operationsFor, whenLine, type Operation } from "./routines-text";

export interface RoutinesSource {
  list(): Promise<RoutinesList>;
  change(operation: Operation, id: string): Promise<RoutinesList>;
}

const why = (failure: unknown) => String((failure as Error)?.message ?? failure);

export function RoutinesPanel({ source }: { source: RoutinesSource }) {
  const [list, setList] = useState<RoutinesList | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => { void source.list().then(setList, (failure) => setProblem(why(failure))); }, [source]);
  const change = (operation: Operation, id: string) => {
    setProblem(null);
    void source.change(operation, id).then(setList, (failure) => setProblem(why(failure)));
  };
  return (
    <div className="routines">
      {list?.error && <p className="routines-problem">{list.error}</p>}
      {problem && <p className="routines-problem">{problem}</p>}
      {list && !list.routines.length && <p className="routines-empty">No routines yet. Ask the bot to schedule one.</p>}
      <ul>
        {list?.routines.map((routine) => (
          <li key={routine.id} data-status={routine.status}>
            <div className="routine-title">{routine.title}</div>
            <div className="routine-when">{whenLine(routine)}</div>
            <div className="routine-buttons">
              {operationsFor(routine.status).map((operation) => <button key={operation} type="button" onClick={() => change(operation, routine.id)}>{LABEL[operation]}</button>)}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
