// Inline review comments, and the one message that sends them to the agent that owns the worktree.
// Pure text, no DOM, so the wording is tested (test/unit/review-ui.test.ts).

export interface ReviewComment {
  id: string;
  path: string;
  /** The line number, in the new file for an added or unchanged line, in the old file for a deleted one. */
  line: number;
  side: "new" | "old";
  /** The code on that line, quoted back to the agent. */
  code: string;
  text: string;
}

export interface ReviewTarget {
  /** The worktree's branch, or null for the project's main checkout. */
  branch: string | null;
  /** The branch it is compared against, when it is a branch review. */
  base: string | null;
  path: string | null;
}

/** A quoted code line: one line, tabs kept, long lines cut. */
function quote(code: string): string {
  const one = code.replace(/\r?\n.*/s, "");
  return one.length > 240 ? `${one.slice(0, 239)}…` : one;
}

/** The message: where the code is, what it says, and what the user wants, one block per comment. */
export function formatReviewComments(target: ReviewTarget, comments: ReviewComment[]): string {
  const where = target.branch
    ? `worktree ${target.branch}${target.base ? ` (compared with ${target.base})` : ""}${target.path ? ` at ${target.path}` : ""}`
    : "the project's working tree";
  const head = `Review comments on ${where}. ${comments.length === 1 ? "One comment" : `${comments.length} comments`}; please address ${comments.length === 1 ? "it" : "each"} in the code${target.branch ? " in that worktree" : ""}.`;
  const blocks = comments.map((comment, index) => {
    const place = `${comment.path}:${comment.line}${comment.side === "old" ? " (the line before the change, now removed)" : ""}`;
    const text = comment.text.trim().replace(/\n/g, "\n   ");
    return `${index + 1}. ${place}\n   > ${quote(comment.code)}\n   ${text}`;
  });
  return [head, ...blocks].join("\n\n");
}
