// Botling 3 wire protocol v1: on-demand fetch between servers (§16, M5-05).
// Five peer-only messages (`fetch.*`): `fetch.chunk` travels as a binary frame on the bulk lane (`encodeChunkFrame`,
// frame.ts), the other four as JSON frames (`encodeWireFrame`). No handler acts on them yet (M5-07 adds behaviour).
import { z } from "zod";
import { BotId } from "../contract";
import { EntryRef } from "./content-url";
import { ContentId, EntryHash, Id, Seq, ServerId } from "./ids";
import { CONTENT_FRAME_CHUNK_LIMIT } from "./messages";

/** Per-request limits (§16): 500 MiB and 20,000 files; per-day default 2 GiB per bot. */
export const FETCH_MAX_BYTES = 500 * 2 ** 20;
export const FETCH_MAX_FILES = 20_000;
/** What the requester will make on disk for one fetch (not on the wire; going over is `limit`): at most this many folders
 * (the source walks at most `FETCH_MAX_FILES` folders), nested at most this deep (folders above the file). */
export const FETCH_MAX_DIRS = 20_000;
export const FETCH_MAX_DEPTH = 64;
export const FETCH_GRANT_BYTES_LIMIT = 2 ** 31;

/** A filesystem path or prefix in a fetch message: 1..4096 characters, no NUL. */
export const FetchPath = z.string().min(1).max(4_096).refine((value) => !value.includes("\0"), { message: "a path may not hold NUL" });

/**
 * A file's path inside a fetch (M5-07b): relative to the fetched target, `/`-separated, in NFC, at most 4096 bytes
 * (UTF-8), no NUL, not absolute, no empty, `.` or `..` segment. Both sides check it: the source before it sends and the
 * requester before it writes (the requester never trusts the wire).
 */
export const FetchRelPath = z.string().min(1).refine((value) => new TextEncoder().encode(value).length <= 4_096, { message: "a file path is at most 4096 bytes" })
  .refine((value) => !value.includes("\0"), { message: "a path may not hold NUL" })
  .refine((value) => value === value.normalize("NFC"), { message: "a file path is in NFC" })
  .refine((value) => !value.startsWith("/") && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."), { message: "a file path is relative, with no empty, . or .. part" });
export type FetchRelPath = z.infer<typeof FetchRelPath>;

export const FetchWhat = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("path"), path: FetchPath }),
  z.strictObject({ kind: z.literal("artifact"), botId: BotId, path: FetchPath }),
  z.strictObject({ kind: z.literal("blob"), id: ContentId, entry: EntryRef }),
  z.strictObject({ kind: z.literal("git"), path: FetchPath }),
]);
export type FetchWhat = z.infer<typeof FetchWhat>;

export const FetchRequester = z.union([
  z.strictObject({ bot: BotId }),
  z.strictObject({ device: Id }),
]);
export type FetchRequester = z.infer<typeof FetchRequester>;

export const FetchDenyReason = z.enum(["denied", "limit", "deny-list", "outside", "revoked", "expired", "gone"]);
export type FetchDenyReason = z.infer<typeof FetchDenyReason>;

export const FetchFrom = z.strictObject({
  file: z.string().max(4_096).refine((value) => !value.includes("\0"), { message: "a path may not hold NUL" }),
  index: Seq,
});
export type FetchFrom = z.infer<typeof FetchFrom>;

const msg = <T extends string, S extends z.core.$ZodLooseShape>(t: T, shape: S) => z.strictObject({ t: z.literal(t), ...shape });

export const FetchAsk = msg("fetch.ask", {
  fetchId: Id,
  requester: FetchRequester,
  source: ServerId,
  what: FetchWhat,
  purpose: z.string().max(500),
  maxBytes: z.number().int().min(1).max(FETCH_MAX_BYTES),
  from: FetchFrom.optional(),
});

export const FetchGrant = msg("fetch.grant", {
  fetchId: Id,
  prefix: FetchPath,
  mode: z.literal("read"),
  bytes: z.number().int().min(0).max(FETCH_GRANT_BYTES_LIMIT),
  files: z.number().int().min(0).max(FETCH_MAX_FILES),
  expires: z.number().int().nonnegative().nullable(),
});

/**
 * Bytes of a fetch chunk: binary frame (`encodeChunkFrame`), capped at `CONTENT_FRAME_CHUNK_LIMIT` (128 KiB).
 * `index` counts chunks over the whole fetch; `file` is the file the bytes belong to (M5-07b: chunks of one file come
 * together, files in sorted order; a zero-byte file is one empty chunk).
 */
export const FetchChunk = msg("fetch.chunk", {
  fetchId: Id,
  index: Seq,
  file: FetchRelPath,
  sha256: EntryHash,
  bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.length <= CONTENT_FRAME_CHUNK_LIMIT, { message: `0 to ${CONTENT_FRAME_CHUNK_LIMIT} bytes` }),
});

export const FetchDone = msg("fetch.done", {
  fetchId: Id,
  manifest: EntryHash,
  bytes: z.number().int().min(0).max(FETCH_GRANT_BYTES_LIMIT),
});

export const FetchDenied = msg("fetch.denied", {
  fetchId: Id,
  reason: FetchDenyReason,
  detail: z.string().max(500).optional(),
});

export const FETCH_MESSAGES = {
  "fetch.ask": FetchAsk,
  "fetch.grant": FetchGrant,
  "fetch.chunk": FetchChunk,
  "fetch.done": FetchDone,
  "fetch.denied": FetchDenied,
} as const;
export type FetchMessageType = keyof typeof FETCH_MESSAGES;
export type FetchMessage = { [T in FetchMessageType]: z.infer<(typeof FETCH_MESSAGES)[T]> }[FetchMessageType];
