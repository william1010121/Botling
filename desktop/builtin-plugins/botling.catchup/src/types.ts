import type { DecorationView, TaskCardView } from "../../../../Web/src/types";

/** A summary as the chat page draws it: a decoration's data (catchup.ts `CatchUpDecoration`) with its task chips. */
export interface CatchUpView {
  /** The range and language summarized. */
  key: string;
  kind?: "unread" | "interval";
  manual?: boolean;
  automatic?: boolean;
  speakerCounts?: Record<string, number> | null;
  requestedBy?: string | null;
  ids: string[];
  count: number;
  heads?: number | null;
  state: "loading" | "ready" | "failed";
  bullets: string[];
  error?: string | null;
  model: string;
  since?: string | null;
  until?: string | null;
  latest?: string | null;
  /** The task cards with lines in the range: a chip beside each bullet about one, and the header's count. */
  tasks?: TaskCardView[] | null;
}

/** The summary a decoration of this plugin carries. */
export function viewOf(decoration: DecorationView): CatchUpView {
  const data = (decoration.data ?? {}) as Omit<CatchUpView, "tasks">;
  return { ...data, ids: data.ids ?? decoration.fold ?? [], tasks: decoration.tasks?.length ? decoration.tasks : null };
}
