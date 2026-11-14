// The external tools the media jobs use (protocol v1 §9A.5, §9A.8, D42), found on botlingd's `PATH`, never bundled.
//
// - ffprobe: video meta (duration, size, codecs, bitrate). Without it a video's meta is its size only.
// - ffmpeg: posters, previews, image thumbnails (when sips is not there). **Required for previews** (D42): without it no
//   preview is made, the original plays, and `botlingd status` says so (notes.ts `media-tools`).
// - qpdf: PDF page count and the linearized ("fast web view") variant of a PDF above 5 MB.
// - pdftoppm (poppler), sips and qlmanage (macOS): PDF page-1 and image thumbnails; Quick Look also makes a video
//   poster on a Mac without ffmpeg.
// - nice: every tool runs at a lower priority (one job at a time; the server's own work comes first).
import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export type ToolName = "ffmpeg" | "ffprobe" | "qpdf" | "pdftoppm" | "sips" | "qlmanage" | "nice";
const NAMES: readonly ToolName[] = ["ffmpeg", "ffprobe", "qpdf", "pdftoppm", "sips", "qlmanage", "nice"];

export interface MediaTools {
  /** Absolute path of each tool found, or null. */
  paths: Record<ToolName, string | null>;
  /** The H.264 encoder previews use: VideoToolbox on the Mac, libx264 elsewhere; null without ffmpeg or either. */
  h264: "h264_videotoolbox" | "libx264" | null;
  /** libx264 too (the fallback when VideoToolbox refuses a job). */
  libx264: boolean;
}

/** The first executable regular file named `name` in the `PATH` text. */
export function findOnPath(name: string, path: string | undefined): string | null {
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, name);
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return file;
    } catch { /* not here */ }
  }
  return null;
}

/** The tools on `path` (default: this process's `PATH`), and which H.264 encoder this ffmpeg has. */
export function findTools(options: { path?: string; platform?: NodeJS.Platform } = {}): MediaTools {
  const path = options.path ?? process.env.PATH;
  const platform = options.platform ?? process.platform;
  const paths = {} as Record<ToolName, string | null>;
  for (const name of NAMES) paths[name] = findOnPath(name, path);
  // sips and qlmanage are macOS tools; another platform's file of that name is not them.
  if (platform !== "darwin") { paths.sips = null; paths.qlmanage = null; }
  let h264: MediaTools["h264"] = null;
  let libx264 = false;
  if (paths.ffmpeg) {
    const run = spawnSync(paths.ffmpeg, ["-hide_banner", "-encoders"], { encoding: "utf8", timeout: 15_000 });
    const text = `${run.stdout ?? ""}`;
    libx264 = /\blibx264\b/.test(text);
    const videotoolbox = platform === "darwin" && /\bh264_videotoolbox\b/.test(text);
    h264 = videotoolbox ? "h264_videotoolbox" : libx264 ? "libx264" : null;
  }
  return { paths, h264, libx264 };
}

/** What the tools found mean for the owner (the Doctor/status note and the log); empty when nothing is missing. */
export function toolNotes(tools: MediaTools): string[] {
  const notes: string[] = [];
  if (!tools.paths.ffmpeg) {
    notes.push("ffmpeg is not on botlingd's PATH: videos get no preview, so the original plays (through the relay it may buffer). Install ffmpeg (on the Mac: brew install ffmpeg) and restart botlingd.");
  } else if (!tools.h264) {
    notes.push("This ffmpeg has no H.264 encoder (h264_videotoolbox or libx264): videos get no preview, so the original plays.");
  }
  if (tools.paths.ffmpeg && !tools.paths.ffprobe) notes.push("ffprobe is not on botlingd's PATH: video duration and bitrate are unknown, so a preview is made for every video above 50 MB or not in MP4.");
  if (!tools.paths.qpdf) notes.push("qpdf is not on botlingd's PATH: large PDFs are not linearized for fast page-1 display, and the page count comes later from the viewer.");
  return notes;
}

/** The tools as JSON for `meta.mediaTools` (what `botlingd status` reads). */
export function toolsSummary(tools: MediaTools, at: number): { at: number; found: string[]; h264: string | null; notes: string[] } {
  return { at, found: NAMES.filter((name) => tools.paths[name]), h264: tools.h264, notes: toolNotes(tools) };
}
