// Video meta without ffprobe (§9A.5 step 1 fallback): an MP4/MOV's duration, size and codecs read from its `moov` box
// in plain JavaScript, so the preview rule can still be judged (and status can say "a preview is needed, ffmpeg is
// missing") on a server without ffprobe. Reads only box headers and the few boxes it needs; never the media data.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { VideoMeta } from "./video";

/** A `moov` larger than this is not read (a sane index of a long video is a few MB). */
const MOOV_LIMIT = 64 * 1024 * 1024;

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buffer, done, length - done, position + done);
    if (!n) break;
    done += n;
  }
  return buffer.subarray(0, done);
}

/** Top-level boxes: finds `moov` (at the start or at the end) and returns its body. */
function findMoov(fd: number, size: number): Buffer | null {
  let at = 0;
  while (at + 8 <= size) {
    const head = readAt(fd, at, 16);
    if (head.length < 8) return null;
    let length = head.readUInt32BE(0);
    const type = head.toString("latin1", 4, 8);
    let header = 8;
    if (length === 1) { length = Number(head.readBigUInt64BE(8)); header = 16; } else if (length === 0) length = size - at;
    if (length < header) return null;
    if (type === "moov") return length > MOOV_LIMIT ? null : readAt(fd, at + header, length - header);
    at += length;
  }
  return null;
}

interface Box { type: string; body: Buffer }

function children(buffer: Buffer): Box[] {
  const out: Box[] = [];
  let at = 0;
  while (at + 8 <= buffer.length) {
    let length = buffer.readUInt32BE(at);
    let header = 8;
    if (length === 1 && at + 16 <= buffer.length) { length = Number(buffer.readBigUInt64BE(at + 8)); header = 16; } else if (length === 0) length = buffer.length - at;
    if (length < header || at + length > buffer.length) break;
    out.push({ type: buffer.toString("latin1", at + 4, at + 8), body: buffer.subarray(at + header, at + length) });
    at += length;
  }
  return out;
}

function find(buffer: Buffer, path: string[]): Box | null {
  let boxes = children(buffer);
  for (let i = 0; i < path.length; i++) {
    const box = boxes.find((b) => b.type === path[i]);
    if (!box) return null;
    if (i === path.length - 1) return box;
    boxes = children(box.body);
  }
  return null;
}

/** Duration in seconds from an `mvhd` or `mdhd` body (version 0 or 1). */
function duration(body: Buffer): number | undefined {
  if (body.length < 24) return undefined;
  const v1 = body[0] === 1;
  const scale = v1 ? body.readUInt32BE(20) : body.readUInt32BE(12);
  const units = v1 ? Number(body.readBigUInt64BE(24)) : body.readUInt32BE(16);
  return scale ? units / scale : undefined;
}

const CODEC: Record<string, string> = { avc1: "h264", avc3: "h264", hvc1: "hevc", hev1: "hevc", mp4a: "aac", ap4h: "prores", apcn: "prores", apch: "prores", apcs: "prores", apco: "prores", av01: "av1", vp09: "vp9", "ac-3": "ac3", "ec-3": "eac3", Opus: "opus", ".mp3": "mp3" };

/** The meta of an MP4/MOV file, or null when it is not one (or its index cannot be read). */
export function mp4Meta(file: string): VideoMeta | null {
  let fd: number;
  try { fd = openSync(file, "r"); } catch { return null; }
  try {
    const size = fstatSync(fd).size;
    const moov = findMoov(fd, size);
    if (!moov) return null;
    const meta: VideoMeta = { container: "mov,mp4", audioCodec: null };
    const mvhd = find(moov, ["mvhd"]);
    const seconds = mvhd ? duration(mvhd.body) : undefined;
    for (const trak of children(moov).filter((box) => box.type === "trak")) {
      const handler = find(trak.body, ["mdia", "hdlr"])?.body.toString("latin1", 8, 12);
      const stsd = find(trak.body, ["mdia", "minf", "stbl", "stsd"])?.body;
      const entry = stsd && stsd.length >= 16 ? stsd.toString("latin1", 12, 16) : "";
      if (handler === "vide" && !meta.videoCodec) {
        meta.videoCodec = CODEC[entry] ?? entry;
        // The visual sample entry's width and height (after 24 bytes of the entry's fixed fields).
        if (stsd && stsd.length >= 8 + 8 + 24 + 4) {
          const width = stsd.readUInt16BE(8 + 8 + 24);
          const height = stsd.readUInt16BE(8 + 8 + 26);
          if (width && height) { meta.width = width; meta.height = height; }
        }
      } else if (handler === "soun" && meta.audioCodec === null) {
        meta.audioCodec = CODEC[entry] ?? entry;
      }
    }
    if (seconds) {
      meta.duration = Math.round(seconds * 1000) / 1000;
      meta.bitrate = Math.round((size * 8) / seconds);
    }
    return meta;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
