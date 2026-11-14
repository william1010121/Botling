// Video jobs (protocol v1 §9A.5): meta (ffprobe), a poster (ffmpeg, or Quick Look on a Mac without ffmpeg) and, only
// when the §9A.5 rule asks for one, a preview (ffmpeg: H.264 + AAC in fragmented MP4, ≤ 720p, ~1 Mbit/s, a keyframe
// every 2 s; `h264_videotoolbox` on the Mac, `libx264 -preset veryfast` elsewhere).
import { constants, copyFileSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { runTool, ToolError, type RunOptions } from "./run";
import type { MediaTools } from "./tools";

export interface VideoMeta {
  duration?: number;
  width?: number;
  height?: number;
  /** Bits per second of the whole file (ffprobe's format bit_rate, else size × 8 / duration). */
  bitrate?: number;
  /** ffprobe's format names (e.g. "mov,mp4,m4a,3gp,3g2,mj2"). */
  container?: string;
  videoCodec?: string;
  /** null: the file has no audio stream. */
  audioCodec?: string | null;
  fps?: number;
}

const num = (value: unknown): number | undefined => {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** The meta ffprobe reports, or null without ffprobe. */
export async function probeVideo(tools: MediaTools, file: string, size: number, options: RunOptions): Promise<VideoMeta | null> {
  if (!tools.paths.ffprobe) return null;
  const run = await runTool(tools, tools.paths.ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], options);
  const info = JSON.parse(run.stdout) as { format?: Record<string, unknown>; streams?: Array<Record<string, unknown>> };
  const video = info.streams?.find((stream) => stream.codec_type === "video" && !(stream.disposition as { attached_pic?: number } | undefined)?.attached_pic);
  const audio = info.streams?.find((stream) => stream.codec_type === "audio");
  const duration = num(info.format?.duration) ?? num(video?.duration);
  const rate = typeof video?.avg_frame_rate === "string" ? video.avg_frame_rate.split("/").map(Number) : [];
  const fps = rate.length === 2 && rate[1] ? rate[0]! / rate[1]! : undefined;
  const meta: VideoMeta = {
    ...(duration ? { duration: Math.round(duration * 1000) / 1000 } : {}),
    ...(num(video?.width) ? { width: Number(video!.width) } : {}),
    ...(num(video?.height) ? { height: Number(video!.height) } : {}),
    ...(typeof info.format?.format_name === "string" ? { container: info.format.format_name } : {}),
    ...(typeof video?.codec_name === "string" ? { videoCodec: video.codec_name } : {}),
    audioCodec: typeof audio?.codec_name === "string" ? audio.codec_name : null,
    ...(fps && Number.isFinite(fps) && fps > 0 ? { fps: Math.round(fps * 1000) / 1000 } : {}),
  };
  const bitrate = num(info.format?.bit_rate) ?? (duration ? (size * 8) / duration : undefined);
  if (bitrate) meta.bitrate = Math.round(bitrate);
  return meta;
}

/** §9A.5: above this bitrate the original gets a preview. */
export const PREVIEW_ABOVE_BITRATE = 1_500_000;
/** §9A.5: above this size the original gets a preview. */
export const PREVIEW_ABOVE_BYTES = 50 * 1000 * 1000;

/**
 * The §9A.5 rule: a preview when the original is above 1.5 Mbit/s, larger than 50 MB, or not H.264 + AAC in MP4/MOV
 * (WebM, HEVC and ProRes do not play on every device). A video without audio needs only H.264. Without meta (no
 * ffprobe) only the size and the type can be judged. Returns why, or null when no preview is needed.
 */
export function previewReason(meta: VideoMeta | null, size: number, type: string): string | null {
  if (size > PREVIEW_ABOVE_BYTES) return `larger than 50 MB (${Math.round(size / 1e6)} MB)`;
  if (!meta) return type === "video/mp4" || type === "video/quicktime" ? null : `not MP4 (${type})`;
  if (meta.bitrate && meta.bitrate > PREVIEW_ABOVE_BITRATE) return `above 1.5 Mbit/s (${(meta.bitrate / 1e6).toFixed(2)} Mbit/s)`;
  const mp4 = !!meta.container && /\b(mov|mp4)\b/.test(meta.container);
  if (!mp4) return `not MP4 (${meta.container ?? type})`;
  if (meta.videoCodec !== "h264") return `video is ${meta.videoCodec ?? "unknown"}, not H.264`;
  if (meta.audioCodec !== null && meta.audioCodec !== "aac") return `audio is ${meta.audioCodec ?? "unknown"}, not AAC`;
  return null;
}

/** §9A.5: the poster is one frame at about 10 % of the video, ≤ 640 px on its longer side. */
export const POSTER_MAX_PX = 640;

/** The poster as JPEG at `out` (ffmpeg), or as PNG by Quick Look on a Mac without ffmpeg; null without either. */
export async function makePoster(tools: MediaTools, file: string, meta: VideoMeta | null, out: string, options: RunOptions, ext = "mp4"): Promise<{ type: string } | null> {
  if (tools.paths.ffmpeg) {
    const at = meta?.duration ? Math.min(meta.duration * 0.1, Math.max(0, meta.duration - 0.1)) : 0;
    const fit = `scale=w='min(${POSTER_MAX_PX},iw)':h='min(${POSTER_MAX_PX},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
    await runTool(tools, tools.paths.ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-ss", at.toFixed(3), "-i", file, "-frames:v", "1", "-vf", fit, "-q:v", "5", "-f", "image2", "-c:v", "mjpeg", out], options);
    return { type: "image/jpeg" };
  }
  if (tools.paths.qlmanage) {
    await quickLook(tools, file, ext, POSTER_MAX_PX, out, options);
    return { type: "image/png" };
  }
  return null;
}

/** Quick Look answers in well under a second (M0: 0.3–0.45 s); a hung one is stopped. */
export const QUICK_LOOK_TIMEOUT_MS = 60_000;

/** Above this, a file that cannot be cloned is not copied for Quick Look. */
const QUICK_LOOK_COPY_MAX_BYTES = 64 * 1024 * 1024;

/** Quick Look's thumbnail of `file` (PNG, ≤ `px`) moved to `out`. */
export async function quickLook(tools: MediaTools, file: string, ext: string, px: number, out: string, options: RunOptions): Promise<void> {
  const dir = mkdtempSync(`${out}.ql-`);
  try {
    // A pinned file has no extension, and Quick Look picks its generator by the name (without one, or through a
    // symbolic link, it waits forever): it reads a copy-on-write clone named with the type's extension (a plain copy
    // only for a small file on a volume that cannot clone).
    const named = join(dir, `source.${ext}`);
    try {
      copyFileSync(file, named, constants.COPYFILE_FICLONE_FORCE);
    } catch {
      if (statSync(file).size > QUICK_LOOK_COPY_MAX_BYTES) throw new ToolError("qlmanage", { code: null, signal: null, stdout: "", stderr: "the file cannot be cloned here and is too large to copy for Quick Look" });
      copyFileSync(file, named);
    }
    await runTool(tools, tools.paths.qlmanage!, ["-t", "-s", String(px), "-o", dir, named], { ...options, timeoutMs: Math.min(options.timeoutMs, QUICK_LOOK_TIMEOUT_MS) });
    const made = readdirSync(dir).find((name) => name.endsWith(".png"));
    if (!made) throw new ToolError("qlmanage", { code: 0, signal: null, stdout: "", stderr: "no thumbnail made" });
    renameSync(join(dir, made), out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** §9A.5 preview targets. */
export const PREVIEW_MAX_HEIGHT = 720;
export const PREVIEW_VIDEO_BITRATE = 1_000_000;
export const PREVIEW_AUDIO_BITRATE = 96_000;
export const PREVIEW_KEYFRAME_SECONDS = 2;

function previewArgs(encoder: "h264_videotoolbox" | "libx264", file: string, meta: VideoMeta | null, out: string): string[] {
  const height = Math.min(PREVIEW_MAX_HEIGHT, meta?.height ?? PREVIEW_MAX_HEIGHT);
  // Even sizes, never upscaled; the longer side of a portrait video is its height, so the height is what is capped.
  const scale = `scale=-2:'min(${height},ih)':flags=bicubic`;
  const fps = meta?.fps && meta.fps <= 60 ? meta.fps : 30;
  const gop = Math.max(1, Math.round(fps * PREVIEW_KEYFRAME_SECONDS));
  const video = encoder === "h264_videotoolbox"
    ? ["-c:v", "h264_videotoolbox", "-b:v", String(PREVIEW_VIDEO_BITRATE), "-maxrate", String(PREVIEW_VIDEO_BITRATE * 1.5), "-bufsize", String(PREVIEW_VIDEO_BITRATE * 2), "-profile:v", "main", "-allow_sw", "1"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-b:v", String(PREVIEW_VIDEO_BITRATE), "-maxrate", String(PREVIEW_VIDEO_BITRATE * 1.5), "-bufsize", String(PREVIEW_VIDEO_BITRATE * 2), "-profile:v", "main", "-threads", "2", "-sc_threshold", "0"];
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", file,
    "-map", "0:v:0", "-map", "0:a:0?", "-vf", scale, "-pix_fmt", "yuv420p", ...video,
    "-g", String(gop), "-keyint_min", String(gop), "-force_key_frames", `expr:gte(t,n_forced*${PREVIEW_KEYFRAME_SECONDS})`,
    "-c:a", "aac", "-b:a", String(PREVIEW_AUDIO_BITRATE), "-ac", "2",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", out,
  ];
}

/** The preview at `out`, or null when this ffmpeg cannot make one. VideoToolbox failing falls back to libx264. */
export async function makePreview(tools: MediaTools, file: string, meta: VideoMeta | null, out: string, options: RunOptions): Promise<{ type: string; encoder: string } | null> {
  if (!tools.paths.ffmpeg || !tools.h264) return null;
  try {
    await runTool(tools, tools.paths.ffmpeg, previewArgs(tools.h264, file, meta, out), options);
    return { type: "video/mp4", encoder: tools.h264 };
  } catch (error) {
    if (tools.h264 !== "h264_videotoolbox" || !tools.libx264 || options.signal?.aborted) throw error;
    rmSync(out, { force: true });
    await runTool(tools, tools.paths.ffmpeg, previewArgs("libx264", file, meta, out), options);
    return { type: "video/mp4", encoder: "libx264" };
  }
}
