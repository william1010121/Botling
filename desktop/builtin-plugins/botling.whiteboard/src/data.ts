// What the board needs besides a bot's memory (moved from the core's whiteboard-data.ts): its one-line description.

const clip = (text: string, limit = 400) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

/** The bot in one line, for the board's tooltip: its job, else its memory's first "Current status" line, else its folder's name. */
export function botDescription(job: string | null | undefined, status: string | undefined, folder: string): string | null {
  const first = (text: string | null | undefined) => (text ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  const line = first(job) || first(status) || (folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "");
  return line ? clip(line) : null;
}
