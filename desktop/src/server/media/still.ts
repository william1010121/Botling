// Image and PDF jobs (protocol v1 §9A.8, §9A.9): an image thumbnail ≤ 512 px for chat bubbles (sips on the Mac, else
// ffmpeg), a PDF page-1 thumbnail (sips or Quick Look on the Mac, `pdftoppm` elsewhere; otherwise none and the FE draws
// page 1 itself), the page count and, for a PDF above 5 MB that is not linearized, a linearized variant (qpdf).
import { renameSync } from "node:fs";
import { runTool, ToolError, type RunOptions } from "./run";
import type { MediaTools } from "./tools";
import { quickLook } from "./video";

export const THUMB_MAX_PX = 512;

/** An image's pixel size (sips, else ffprobe), or null. */
export async function imageSize(tools: MediaTools, file: string, options: RunOptions): Promise<{ width: number; height: number } | null> {
  try {
    if (tools.paths.sips) {
      const run = await runTool(tools, tools.paths.sips, ["-g", "pixelWidth", "-g", "pixelHeight", file], options);
      const width = Number(/pixelWidth:\s*(\d+)/.exec(run.stdout)?.[1]);
      const height = Number(/pixelHeight:\s*(\d+)/.exec(run.stdout)?.[1]);
      if (width > 0 && height > 0) return { width, height };
    }
    if (tools.paths.ffprobe) {
      const run = await runTool(tools, tools.paths.ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", file], options);
      const [width, height] = run.stdout.trim().split("x").map(Number);
      if (width! > 0 && height! > 0) return { width: width!, height: height! };
    }
  } catch { /* unknown */ }
  return null;
}

/** An image whose longer side is at most this, and at most this many bytes, needs no thumbnail (it is one already). */
export const SMALL_IMAGE_BYTES = 256 * 1024;

/** The image thumbnail (JPEG ≤ 512 px) at `out`; null without a tool that can make one. */
export async function makeImageThumb(tools: MediaTools, file: string, out: string, options: RunOptions): Promise<{ type: string } | null> {
  if (tools.paths.sips) {
    await runTool(tools, tools.paths.sips, ["-s", "format", "jpeg", "-s", "formatOptions", "70", "-Z", String(THUMB_MAX_PX), file, "--out", out], options);
    return { type: "image/jpeg" };
  }
  if (tools.paths.ffmpeg) {
    const fit = `scale=w='min(${THUMB_MAX_PX},iw)':h='min(${THUMB_MAX_PX},ih)':force_original_aspect_ratio=decrease`;
    await runTool(tools, tools.paths.ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", file, "-frames:v", "1", "-vf", fit, "-q:v", "5", "-f", "image2", "-c:v", "mjpeg", out], options);
    return { type: "image/jpeg" };
  }
  return null;
}

/** The PDF's page 1 as a thumbnail ≤ 512 px at `out`; null without a tool. */
export async function makePdfThumb(tools: MediaTools, file: string, out: string, options: RunOptions): Promise<{ type: string; tool: string } | null> {
  if (tools.paths.sips) {
    try {
      await runTool(tools, tools.paths.sips, ["-s", "format", "jpeg", "-s", "formatOptions", "70", "-Z", String(THUMB_MAX_PX), file, "--out", out], options);
      return { type: "image/jpeg", tool: "sips" };
    } catch (error) {
      if (!tools.paths.pdftoppm && !tools.paths.qlmanage) throw error;
    }
  }
  if (tools.paths.pdftoppm) {
    // pdftoppm adds the extension itself: write to `<out>.x.jpg`, then move.
    await runTool(tools, tools.paths.pdftoppm, ["-jpeg", "-jpegopt", "quality=70", "-f", "1", "-l", "1", "-scale-to", String(THUMB_MAX_PX), "-singlefile", file, `${out}.x`], options);
    renameSync(`${out}.x.jpg`, out);
    return { type: "image/jpeg", tool: "pdftoppm" };
  }
  if (tools.paths.qlmanage) {
    await quickLook(tools, file, "pdf", THUMB_MAX_PX, out, options);
    return { type: "image/png", tool: "qlmanage" };
  }
  return null;
}

/** The page count (qpdf), or null. */
export async function pdfPages(tools: MediaTools, file: string, options: RunOptions): Promise<number | null> {
  if (!tools.paths.qpdf) return null;
  try {
    const run = await runTool(tools, tools.paths.qpdf, ["--show-npages", file], options);
    const pages = Number(run.stdout.trim());
    return Number.isInteger(pages) && pages > 0 ? pages : null;
  } catch { return null; }
}

/** §9A.8: a PDF above this size that is not linearized gets a linearized variant (when qpdf is present). */
export const LINEARIZE_ABOVE_BYTES = 5 * 1024 * 1024;

/** Whether qpdf says the file is linearized already ("no linearization errors"; else "… is not linearized"). */
export async function isLinearized(tools: MediaTools, file: string, options: RunOptions): Promise<boolean> {
  try {
    const run = await runTool(tools, tools.paths.qpdf!, ["--check-linearization", file], options);
    return /no linearization errors/.test(run.stdout);
  } catch (error) {
    if (error instanceof ToolError) return false; // a damaged or odd file: linearizing it is still worth a try
    throw error;
  }
}

/** The linearized copy at `out`; null without qpdf. qpdf's exit 3 (warnings, file written) counts as made. */
export async function linearize(tools: MediaTools, file: string, out: string, options: RunOptions): Promise<{ type: string } | null> {
  if (!tools.paths.qpdf) return null;
  try {
    await runTool(tools, tools.paths.qpdf, ["--linearize", file, out], options);
  } catch (error) {
    if (!(error instanceof ToolError) || error.run.code !== 3) throw error;
  }
  return { type: "application/pdf" };
}
