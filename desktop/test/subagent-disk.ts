import { dirname } from "node:path";
import { SubagentStore } from "../src/core/store/subagent-store";

/** What a bot folder holds of its subagents, put back together: the index entries, each with its steps (and earlier runs) read from its file. */
export function readSubagentRows(indexFile: string): any[] {
  const store = new SubagentStore(dirname(indexFile));
  return store.load().map((row) => {
    const history = store.readSteps(String(row.id));
    return { ...row, steps: history.steps, ...(history.runs.length ? { previousRuns: history.runs.map((run) => ({ ...run.run, steps: run.steps })) } : {}) };
  });
}
