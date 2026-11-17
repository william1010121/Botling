import type { DecorationView } from "../../../../Web/src/types";

/** The fold as the chat page draws it: a decoration's data (catchup.ts `CatchUpViewData`). */
export interface CatchUpView {
  /** The range folded. */
  key: string;
  kind?: "unread";
  /** The lines folded behind the header. */
  ids: string[];
  /** How many messages stayed in view. */
  important: number;
}

/** The fold a decoration of this plugin carries. */
export function viewOf(decoration: DecorationView): CatchUpView {
  const data = (decoration.data ?? {}) as Partial<CatchUpView>;
  return { key: data.key ?? decoration.key, kind: "unread", ids: data.ids ?? decoration.fold ?? [], important: typeof data.important === "number" ? data.important : 0 };
}
