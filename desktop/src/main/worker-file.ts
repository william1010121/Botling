import { extname, isAbsolute, relative, resolve } from "node:path";
import { filesChanged } from "../renderer/worker-panel";
import type { StepView } from "../contract";

/**
 * A file in a worker's "Files changed": a picture or PDF shows in macOS Preview, a file that could run
 * (an app, a script, an installer) is shown in Finder and never opened, anything else opens with its default app.
 */
export type WorkerFileRoute = "preview" | "reveal" | "open";

const PREVIEW = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".heic", ".bmp", ".tiff", ".tif", ".pdf"]);
const RUNNABLE = new Set([".app", ".command", ".sh", ".zsh", ".bash", ".tool", ".pkg", ".mpkg", ".dmg", ".scpt", ".scptd", ".workflow", ".terminal", ".jar", ".webloc", ".inetloc", ".exe", ".bat", ".action", ".osax"]);

export function workerFileRoute(path: string): WorkerFileRoute {
  const type = extname(path).toLowerCase();
  return PREVIEW.has(type) ? "preview" : RUNNABLE.has(type) ? "reveal" : "open";
}

export interface WorkerFileIO {
  exists: (path: string) => boolean;
  /** The real path (symlinks followed); throws when it is not there. */
  realpath: (path: string) => string;
  preview: (path: string) => Promise<void>;
  open: (path: string) => Promise<void>;
  reveal: (path: string) => void;
}

const refuse = (message: string) => Object.assign(new Error(message), { code: "not_found" });

const inside = (root: string, path: string) => { const from = relative(root, path); return from === "" || (!from.startsWith("..") && !isAbsolute(from)); };

/**
 * Opens one of the worker's changed files, only if the worker's own steps name it. A relative one is read against `cwd`, the
 * worker's folder, and must stay inside it (`..` and symlinks included); one listed with its full path opens where it is.
 * Throws a short message for the toast.
 */
export async function openWorkerFile(steps: StepView[], cwd: string | null, listed: string, io: WorkerFileIO): Promise<{ route: WorkerFileRoute }> {
  if (!filesChanged(steps).includes(listed)) throw refuse("That file is not one this worker changed.");
  let path = listed;
  if (!isAbsolute(listed)) {
    if (!cwd) throw refuse("That file is listed without a full path and this worker has no folder.");
    path = resolve(cwd, listed);
    if (!inside(cwd, path)) throw refuse("That file is outside the worker's folder.");
  }
  if (!io.exists(path)) throw refuse("That file is not there any more.");
  if (!isAbsolute(listed)) {
    let real: string, root: string;
    try { real = io.realpath(path); root = io.realpath(cwd!); } catch { throw refuse("That file is not there any more."); }
    if (!inside(root, real)) throw refuse("That file is outside the worker's folder.");
    path = real;
  }
  const route = workerFileRoute(path);
  if (route === "preview") await io.preview(path);
  else if (route === "open") await io.open(path);
  else io.reveal(path);
  return { route };
}
