// Botling 3 wire protocol v1: frames. One plaintext `{t, ...}` JSON message per frame, at most 256 KiB (§5.2).
// On a byte stream (the local socket) each frame is preceded by its length as 4 bytes, big-endian.
// Decoding refuses malformed frames and messages outside the sender's role (§5.4); the caller ends the session
// with the `bye` it is given.
// M3's messages (messages-m3.ts) are read by the `*Wire*` functions (`decodeWireFrame`, `encodeWireFrame`); the M1/M2
// ones (`decodeFrame`, `encodeFrame`) refuse them as unsupported, so their callers only ever see `Message`. The
// forwarded-subscription tag `via` (M3, §10.3) may be stated by a peer server only. A `cmd`'s `via` is something else:
// the plugin the command came from (D53, plan change N1), written by the front end's shell, so any sender may carry it.
// Two messages are binary: `content.chunk` (§9A.4) and `fetch.chunk` (§16, M5-05). Each frame is the byte 0x01, the
// header's length as 2 bytes big-endian, the header JSON (`{t, req, offset}` or `{t, fetchId, index, sha256}`), then
// the raw bytes. A text frame is JSON and never starts with 0x01.
import type { z } from "zod";
import { describeIssues } from "../contract";
import { MESSAGES, RES_PART_CHARS, RES_PARTS_MAX, type Message, type MessageOf, type MessageType } from "./messages";
import { M3_MESSAGES, WIRE_MESSAGES, type WireMessage, type WireMessageOf } from "./messages-m3";
import { knownType, roleRefusal, type Sender, type SessionKind } from "./roles";

/** The most a frame's plaintext may be (§5.2, §20). */
export const FRAME_LIMIT = 256 * 1024;

export type FrameRefusal = "too-large" | "malformed" | "role" | "unsupported";
export type Decoded = { ok: true; message: Message } | { ok: false; reason: FrameRefusal; detail: string; bye: Message & { t: "bye" } };
/** A frame read with every registry (M1, M2, M3). */
export type WireDecoded = { ok: true; message: WireMessage } | { ok: false; reason: FrameRefusal; detail: string; bye: Message & { t: "bye" } };
export type Encoded = { ok: true; text: string } | { ok: false; reason: FrameRefusal; detail: string };
export type EncodedBytes = { ok: true; bytes: Uint8Array } | { ok: false; reason: FrameRefusal; detail: string };

/** The first byte of a binary frame. */
export const BINARY_FRAME_MARK = 0x01;
const BINARY_HEADER_LIMIT = 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function refuse(reason: FrameRefusal, detail: string): Extract<Decoded, { ok: false }> {
  const byeReason = reason === "unsupported" ? "role" : reason;
  return { ok: false, reason, detail: detail.slice(0, 500), bye: { t: "bye", reason: byeReason, detail: detail.slice(0, 500) } };
}

type Registry = "m2" | "wire";

function check(value: unknown, sender: Sender, session: SessionKind, registry: Registry): WireDecoded {
  if (!value || typeof value !== "object" || Array.isArray(value)) return refuse("malformed", "a frame is a JSON object");
  const t = (value as { t?: unknown }).t;
  if (typeof t !== "string" || !t) return refuse("malformed", "a frame names its message in t");
  const role = roleRefusal(t, sender, session);
  if (role) return refuse(knownType(t) ? "role" : "malformed", role);
  const known = registry === "wire" ? Object.hasOwn(WIRE_MESSAGES, t) : Object.hasOwn(MESSAGES, t);
  if (!known) return refuse("unsupported", Object.hasOwn(M3_MESSAGES, t) ? `"${t}" is an M3 message (decodeWireFrame)` : `"${t}" is not supported by this version`);
  if (t === "cmd" && sender === "fe" && (value as { scope?: unknown }).scope !== undefined) return refuse("role", "a front end does not state a command's scope");
  if (t !== "cmd" && sender !== "peer" && (value as { via?: unknown }).via !== undefined) return refuse("role", "only a peer server tags a forwarded subscription (via)");
  if (t === "sub" && sender !== "peer" && (value as { live?: unknown }).live !== undefined) return refuse("role", "only a peer server turns live frames off for a forwarded subscription");
  if ((t === "content.get" || t === "content.locate") && sender !== "peer" && (value as { device?: unknown }).device !== undefined) return refuse("role", "only a peer server names the device it reads for");
  const parsed = (WIRE_MESSAGES as Record<string, z.ZodType>)[t]!.safeParse(value);
  if (!parsed.success) return refuse("malformed", `${t}: ${describeIssues(parsed.error)}`);
  return { ok: true, message: parsed.data as WireMessage };
}

/** Checks a parsed value as an M1/M2 message `sender` may send on this session (M3 messages: unsupported). */
export function checkMessage(value: unknown, sender: Sender, session: SessionKind): Decoded {
  return check(value, sender, session, "m2") as Decoded;
}

/** Checks a parsed value as a message of any registry (M1, M2, M3) `sender` may send on this session. */
export function checkWireMessage(value: unknown, sender: Sender, session: SessionKind): WireDecoded {
  return check(value, sender, session, "wire");
}

function decode(frame: string | Uint8Array, sender: Sender, session: SessionKind, registry: Registry): WireDecoded {
  let text: string;
  if (typeof frame !== "string" && frame.length > 0 && frame[0] === BINARY_FRAME_MARK) return decodeBinary(frame, sender, session, registry);
  if (typeof frame === "string") {
    // A UTF-16 unit is at most 3 UTF-8 bytes: only measure when it could be over.
    if (frame.length * 3 > FRAME_LIMIT && encoder.encode(frame).length > FRAME_LIMIT) return refuse("too-large", `a frame is at most ${FRAME_LIMIT} bytes`);
    text = frame;
  } else {
    if (frame.length > FRAME_LIMIT) return refuse("too-large", `a frame is at most ${FRAME_LIMIT} bytes`);
    try { text = decoder.decode(frame); } catch { return refuse("malformed", "a frame is UTF-8 text"); }
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { return refuse("malformed", "a frame is JSON"); }
  return check(value, sender, session, registry);
}

/** Decodes one frame (its UTF-8 bytes or text, or a binary `content.chunk` frame) sent by `sender`: M1/M2 messages. */
export function decodeFrame(frame: string | Uint8Array, sender: Sender, session: SessionKind): Decoded {
  return decode(frame, sender, session, "m2") as Decoded;
}

/** Decodes one frame sent by `sender` as a message of any registry (M1, M2, M3): peer sessions and M3 front ends. */
export function decodeWireFrame(frame: string | Uint8Array, sender: Sender, session: SessionKind): WireDecoded {
  return decode(frame, sender, session, "wire");
}

function decodeBinary(frame: Uint8Array, sender: Sender, session: SessionKind, registry: Registry): WireDecoded {
  if (frame.length > FRAME_LIMIT) return refuse("too-large", `a frame is at most ${FRAME_LIMIT} bytes`);
  if (frame.length < 3) return refuse("malformed", "a binary frame has a header");
  const headerLength = (frame[1]! << 8) | frame[2]!;
  if (headerLength > BINARY_HEADER_LIMIT || frame.length < 3 + headerLength) return refuse("malformed", "a binary frame's header does not fit");
  let header: unknown;
  try { header = JSON.parse(decoder.decode(frame.subarray(3, 3 + headerLength))); } catch { return refuse("malformed", "a binary frame's header is JSON"); }
  if (!header || typeof header !== "object" || Array.isArray(header)) return refuse("malformed", "a binary frame's header is a JSON object");
  const binaryType = (header as { t?: unknown }).t;
  if (binaryType !== "content.chunk" && binaryType !== "fetch.chunk") return refuse("malformed", "only content.chunk and fetch.chunk are binary frames");
  if ("bytes" in header) return refuse("malformed", "the bytes follow the header");
  return check({ ...header, bytes: frame.slice(3 + headerLength) }, sender, session, registry);
}

export type ChunkMessage = MessageOf<"content.chunk"> | WireMessageOf<"fetch.chunk">;

/** Encodes a `content.chunk` or `fetch.chunk` as a binary frame; refuses one that is malformed, outside the role or too large. */
export function encodeChunkFrame(message: ChunkMessage, sender: Sender, session: SessionKind): EncodedBytes {
  const type = (message as { t?: unknown }).t;
  if (type !== "content.chunk" && type !== "fetch.chunk") return { ok: false, reason: "malformed", detail: "only content.chunk and fetch.chunk are binary frames" };
  const checked = type === "content.chunk" ? checkMessage(message, sender, session) : checkWireMessage(message, sender, session);
  if (!checked.ok) return { ok: false, reason: checked.reason, detail: checked.detail };
  const chunk = checked.message as ChunkMessage;
  const headerObj = chunk.t === "content.chunk"
    ? { t: chunk.t, req: chunk.req, offset: chunk.offset }
    : { t: chunk.t, fetchId: chunk.fetchId, index: chunk.index, sha256: chunk.sha256 };
  const header = encoder.encode(JSON.stringify(headerObj));
  if (header.length > BINARY_HEADER_LIMIT) return { ok: false, reason: "malformed", detail: "the header is too long" };
  const out = new Uint8Array(3 + header.length + chunk.bytes.length);
  if (out.length > FRAME_LIMIT) return { ok: false, reason: "too-large", detail: `a frame is at most ${FRAME_LIMIT} bytes` };
  out[0] = BINARY_FRAME_MARK;
  out[1] = header.length >> 8;
  out[2] = header.length & 0xff;
  out.set(header, 3);
  out.set(chunk.bytes, 3 + header.length);
  return { ok: true, bytes: out };
}

function encode(message: WireMessage, sender: Sender, session: SessionKind, registry: Registry): Encoded {
  if (message.t === "content.chunk" || message.t === "fetch.chunk") return { ok: false, reason: "malformed", detail: `a ${message.t} is a binary frame (encodeChunkFrame)` };
  const checked = check(message, sender, session, registry);
  if (!checked.ok) return { ok: false, reason: checked.reason, detail: checked.detail };
  let text: string;
  try { text = JSON.stringify(checked.message); } catch (error) { return { ok: false, reason: "malformed", detail: String(error) }; }
  if (encoder.encode(text).length > FRAME_LIMIT) return { ok: false, reason: "too-large", detail: `a frame is at most ${FRAME_LIMIT} bytes` };
  return { ok: true, text };
}

/** Encodes a message `sender` may send on this session; refuses one that is malformed, outside the role or too large. */
export function encodeFrame(message: Message, sender: Sender, session: SessionKind): Encoded {
  return encode(message, sender, session, "m2");
}

/** Encodes a message of any registry (M1, M2, M3), with the same checks as `encodeFrame`. */
export function encodeWireFrame(message: WireMessage, sender: Sender, session: SessionKind): Encoded {
  return encode(message, sender, session, "wire");
}

/**
 * A `res` as text frames: the one frame when it fits, else its JSON cut into `res.part` frames (in order). Refused (with
 * the reason) only when it is not a `res` the sender may send, or even `RES_PARTS_MAX` parts cannot carry it.
 */
export function encodeResFrames(message: MessageOf<"res">, sender: Sender, session: SessionKind): { ok: true; texts: string[] } | { ok: false; reason: FrameRefusal; detail: string } {
  const whole = encodeFrame(message, sender, session);
  if (whole.ok) return { ok: true, texts: [whole.text] };
  if (whole.reason !== "too-large") return whole;
  const checked = checkMessage(message, sender, session);
  if (!checked.ok) return { ok: false, reason: checked.reason, detail: checked.detail };
  const text = JSON.stringify(checked.message);
  const n = Math.ceil(text.length / RES_PART_CHARS);
  if (n > RES_PARTS_MAX) return { ok: false, reason: "too-large", detail: `a res is at most ${RES_PARTS_MAX} parts of ${RES_PART_CHARS} characters (this one is ${text.length})` };
  const texts: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const part = encodeFrame({ t: "res.part", req: message.req, i, n, text: text.slice(i * RES_PART_CHARS, (i + 1) * RES_PART_CHARS) }, sender, session);
    if (!part.ok) return part;
    texts.push(part.text);
  }
  return { ok: true, texts };
}

/**
 * Joins the `res.part`s of answers back into their `res` (one `req` at a time each; parts in order). `push` gives the
 * `res` once its last part is in, null before that, or a refusal when the parts do not make one (out of order, a
 * different count, or text that is not the `res` of that `req`).
 */
export class ResAssembler {
  private readonly open = new Map<string, { n: number; texts: string[] }>();

  push(part: MessageOf<"res.part">, session: SessionKind): { ok: true; message: MessageOf<"res"> | null } | { ok: false; detail: string } {
    const held = this.open.get(part.req) ?? { n: part.n, texts: [] };
    if (held.n !== part.n || part.i !== held.texts.length) {
      this.open.delete(part.req);
      return { ok: false, detail: `res.part ${part.i + 1}/${part.n} of ${part.req} out of order` };
    }
    held.texts.push(part.text);
    if (held.texts.length < held.n) { this.open.set(part.req, held); return { ok: true, message: null }; }
    this.open.delete(part.req);
    let value: unknown;
    try { value = JSON.parse(held.texts.join("")); } catch { return { ok: false, detail: `the parts of ${part.req} are not JSON` }; }
    const checked = checkMessage(value, "server", session);
    if (!checked.ok) return { ok: false, detail: `the parts of ${part.req}: ${checked.detail}` };
    if (checked.message.t !== "res" || checked.message.req !== part.req) return { ok: false, detail: `the parts of ${part.req} are not its res` };
    return { ok: true, message: checked.message };
  }

  /** Forgets the parts of `req` (its request ended), or all of them. */
  drop(req?: string): void { if (req === undefined) this.open.clear(); else this.open.delete(req); }

  get pending(): number { return this.open.size; }
}

/** A frame (its text, or a binary frame's bytes) with its 4-byte big-endian length in front, for a byte stream. */
export function packFrame(frame: string | Uint8Array): Uint8Array {
  const body = typeof frame === "string" ? encoder.encode(frame) : frame;
  if (body.length > FRAME_LIMIT) throw new RangeError(`a frame is at most ${FRAME_LIMIT} bytes`);
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, false);
  out.set(body, 4);
  return out;
}

/**
 * Cuts a byte stream into frames. `push` returns the complete frames so far (their bytes, for `decodeFrame`);
 * a length above the limit makes it refuse for good (the session must end: nothing after it can be trusted).
 */
export class FrameSplitter {
  private buffer = new Uint8Array(0);
  private failed: string | null = null;

  push(chunk: Uint8Array): { ok: true; frames: Uint8Array[] } | { ok: false; detail: string } {
    if (this.failed) return { ok: false, detail: this.failed };
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer, 0);
    joined.set(chunk, this.buffer.length);
    const frames: Uint8Array[] = [];
    let at = 0;
    while (joined.length - at >= 4) {
      const length = new DataView(joined.buffer, joined.byteOffset + at, 4).getUint32(0, false);
      if (length > FRAME_LIMIT) {
        this.failed = `a frame is at most ${FRAME_LIMIT} bytes`;
        this.buffer = new Uint8Array(0);
        return { ok: false, detail: this.failed };
      }
      if (joined.length - at - 4 < length) break;
      frames.push(joined.slice(at + 4, at + 4 + length));
      at += 4 + length;
    }
    this.buffer = joined.slice(at);
    return { ok: true, frames };
  }

  /** Bytes waiting for the rest of a frame. */
  get pending(): number {
    return this.buffer.length;
  }
}
