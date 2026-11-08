import { extname } from "node:path";
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
  preview: (path: string) => Promise<void>;
  open: (path: string) => Promise<void>;
  reveal: (path: string) => void;
}

const refuse = (message: string) => Object.assign(new Error(message), { code: "not_found" });

/** Opens one of the worker's changed files, only if the worker's own steps name it. Throws a short message for the toast. */
export async function openWorkerFile(steps: StepView[], path: string, io: WorkerFileIO): Promise<{ route: WorkerFileRoute }> {
  if (!path.startsWith("/") || !filesChanged(steps).includes(path)) throw refuse("That file is not one this worker changed.");
  if (!io.exists(path)) throw refuse("That file is not there any more.");
  const route = workerFileRoute(path);
  if (route === "preview") await io.preview(path);
  else if (route === "open") await io.open(path);
  else io.reveal(path);
  return { route };
}
