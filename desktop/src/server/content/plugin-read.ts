// Botling 3 plugin `content.read(ref, offset, length)` and `content.fetch(storageDir, ref)` on the server
// (M5-08a, M5-08b, protocol v1 §9A.7, §9A.8, §23, D69, D74/Q-C7).
// Reads up to 4 MiB or fetches up to 500 MiB of a chat-referenced content item by reference (never by path)
// from either this server's `ContentService` or a peer server through `PeerContent.respond(..., LOCAL_WINDOW)`.
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync } from "node:fs";
import { copyFile, lstat, open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { serveContentFile } from "../../main-v3/content-protocol";
import type { EntryRef, MessageOf } from "../../protocol";
import { FETCH_MAX_BYTES } from "../../protocol/fetch";
import { LOCAL_WINDOW, PeerContent, PeerReadError, type PeerReadFailure } from "./peer-content";
import { pinFile, type PinOptions } from "./pin";
import type { ContentService } from "./service";

export const PLUGIN_READ_MAX_BYTES = 4 * 1024 * 1024;
export const PLUGIN_FETCH_MAX_BYTES = FETCH_MAX_BYTES;
const CONTENT_ID_RE = /^sha256:([0-9a-f]{64})$/;

export interface PluginContentRef {
  owner: string;
  id: string;
  entry: EntryRef;
}

export interface PluginContentReadOptions {
  serverId: string;
  service: Pick<ContentService, "open" | "markChanged">;
  peer: Pick<PeerContent, "respond">;
  roster: { readonly view: { readonly revoked: ReadonlySet<string> } };
  /** Tests: force a pin kind in `fetch` (for exercising the `copyFile` fallback when `pinFile` answers `path`). */
  pin?: PinOptions;
}

function messageForFailure(reason: PeerReadFailure): string {
  switch (reason) {
    case "denied":
      return "That content is not referenced there.";
    case "changed":
    case "deleted":
      return "That file changed or is no longer there.";
    case "corrupt":
      return "That file arrived damaged.";
    case "offline":
    case "too-large":
    case "cancelled":
      return "The machine that has this file is not reachable.";
  }
}

function failureFromResponse(response: Response, local: boolean): string {
  const header = response.headers.get("x-botling-content")?.trim() ?? "";
  if (response.status === 502 || header === "refused; reason=chunk-hash") {
    return messageForFailure("corrupt");
  }
  const gone = /^gone;\s*reason=(changed|deleted|denied|offline|too-large)$/.exec(header);
  if (gone) return messageForFailure(gone[1] as PeerReadFailure);
  if (local && response.status === 404) return messageForFailure("deleted");
  return messageForFailure("offline");
}

function mapStreamError(error: unknown, local: boolean): Error {
  if (error instanceof PeerReadError) return new Error(messageForFailure(error.reason));
  if (error instanceof Error && error.name === "ContentChangedError") return new Error(messageForFailure("changed"));
  return new Error(messageForFailure(local ? "deleted" : "offline"));
}

async function fileMatchesHash(path: string, expectedSize: number, expectedHex: string): Promise<boolean> {
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.size !== expectedSize) return false;
    const digest = await new Promise<string>((resolveHash, rejectHash) => {
      const hash = createHash("sha256");
      const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", rejectHash);
      stream.on("end", () => resolveHash(hash.digest("hex")));
    });
    return digest === expectedHex;
  } catch {
    return false;
  }
}

export class PluginContentRead {
  private readonly destLocks = new Map<string, Promise<unknown>>();

  constructor(private readonly options: PluginContentReadOptions) {}

  private async withDestLock<T>(dest: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.destLocks.get(dest) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    const chain = prior.then(() => next);
    this.destLocks.set(dest, chain);
    await prior;
    try {
      return await fn();
    } finally {
      release();
      if (this.destLocks.get(dest) === chain) this.destLocks.delete(dest);
    }
  }

  private async openLocal(ref: PluginContentRef, req: string): Promise<MessageOf<"content.file">> {
    const opened = await this.options.service.open(
      {
        t: "content.open",
        req,
        owner: ref.owner,
        id: ref.id as MessageOf<"content.open">["id"],
        variant: "original",
        entry: ref.entry,
      },
      { remote: true },
    );
    if (opened.t === "content.gone") throw new Error(messageForFailure(opened.reason));
    return opened;
  }

  private async peerResponse(ref: PluginContentRef, request: Request): Promise<Response> {
    let response: Response;
    try {
      response = await this.options.peer.respond(
        { owner: ref.owner, id: ref.id, variant: "original", entry: ref.entry },
        request,
        LOCAL_WINDOW,
      );
    } catch (error) {
      throw mapStreamError(error, false);
    }
    if (response.status !== 200 && response.status !== 206 && response.status !== 416) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(failureFromResponse(response, false));
    }
    return response;
  }

  async read(ref: PluginContentRef, offset: number, length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("Offset must be a non-negative integer.");
    }
    if (!Number.isSafeInteger(length) || length < 0 || length > PLUGIN_READ_MAX_BYTES) {
      throw new Error("Length must be an integer between 0 and 4 MiB.");
    }
    if (this.options.roster.view.revoked.has(ref.owner)) {
      throw new Error("That machine was removed.");
    }

    const request =
      length === 0
        ? new Request("http://local/", { method: "HEAD" })
        : (() => {
            const rangeEnd = offset + length - 1;
            const range = Number.isSafeInteger(rangeEnd) ? `bytes=${offset}-${rangeEnd}` : `bytes=${offset}-`;
            return new Request("http://local/", { headers: { Range: range } });
          })();

    const local = ref.owner === this.options.serverId;
    let response: Response;
    if (local) {
      const opened = await this.openLocal(ref, "plugin-read");
      response = await serveContentFile(opened, request, {
        onChanged: () => {
          void this.options.service.markChanged(opened.id).catch(() => undefined);
        },
      });
      if (response.status !== 200 && response.status !== 206 && response.status !== 416) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(failureFromResponse(response, true));
      }
    } else {
      response = await this.peerResponse(ref, request);
    }

    if (response.status === 416) {
      await response.body?.cancel().catch(() => undefined);
      return new Uint8Array(0);
    }
    if (length === 0) {
      await response.body?.cancel().catch(() => undefined);
      return new Uint8Array(0);
    }

    try {
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw mapStreamError(error, local);
    }
  }

  async fetch(storageDir: string, ref: PluginContentRef): Promise<string> {
    const idMatch = CONTENT_ID_RE.exec(ref.id);
    if (!idMatch) throw new Error(messageForFailure("denied"));
    const expectedHex = idMatch[1]!;
    if (this.options.roster.view.revoked.has(ref.owner)) {
      throw new Error("That machine was removed.");
    }
    if (!storageDir) throw new Error(messageForFailure("denied"));
    const contentDir = resolve(storageDir, "content");
    const dest = resolve(contentDir, ref.id);
    if (dirname(dest) !== contentDir) throw new Error(messageForFailure("denied"));

    const local = ref.owner === this.options.serverId;
    let opened: MessageOf<"content.file"> | null = null;
    let size: number;

    if (local) {
      opened = await this.openLocal(ref, "plugin-fetch");
      size = opened.sig.size;
    } else {
      const headRes = await this.peerResponse(ref, new Request("http://local/", { method: "HEAD" }));
      await headRes.body?.cancel().catch(() => undefined);
      const rawLen = headRes.headers.get("content-length");
      size = rawLen === null ? NaN : Number(rawLen);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error(messageForFailure("offline"));
      }
    }

    if (size > PLUGIN_FETCH_MAX_BYTES) {
      throw new Error("That file is larger than 500 MB; read it in parts with content.read.");
    }

    return this.withDestLock(dest, async () => {
      if (await fileMatchesHash(dest, size, expectedHex)) return dest;
      mkdirSync(contentDir, { recursive: true });

      if (local && opened) {
        const failLocal = (error: unknown): never => {
          if (opened!.pin === "path") {
            void this.options.service.markChanged(opened!.id).catch(() => undefined);
            throw new Error(messageForFailure("changed"));
          }
          if (error instanceof Error && error.message === messageForFailure("deleted")) throw error;
          throw new Error(messageForFailure("deleted"));
        };

        let pinned;
        try {
          pinned = await pinFile(opened.path, contentDir, this.options.pin);
        } catch (error) {
          return failLocal(error);
        }

        if (pinned.pin === "clone" || pinned.pin === "copy") {
          try {
            if (!(await fileMatchesHash(pinned.file, size, expectedHex))) {
              await rm(pinned.file, { force: true }).catch(() => undefined);
              return failLocal(new Error("hash mismatch"));
            }
            await rename(pinned.file, dest);
            return dest;
          } catch (error) {
            await rm(pinned.file, { force: true }).catch(() => undefined);
            throw error;
          }
        }

        const partial = `${dest}.partial`;
        try {
          await copyFile(opened.path, partial);
          if (!(await fileMatchesHash(partial, size, expectedHex))) {
            await rm(partial, { force: true }).catch(() => undefined);
            return failLocal(new Error("hash mismatch"));
          }
          await rename(partial, dest);
          return dest;
        } catch (error) {
          await rm(partial, { force: true }).catch(() => undefined);
          return failLocal(error);
        }
      }

      const partial = `${dest}.partial`;
      let handle: Awaited<ReturnType<typeof open>> | null = null;
      try {
        handle = await open(partial, "w");
        const hash = createHash("sha256");
        let offset = 0;
        while (offset < size) {
          const want = Math.min(PLUGIN_READ_MAX_BYTES, size - offset);
          const piece = await this.read(ref, offset, want);
          if (piece.byteLength === 0) throw new Error(messageForFailure("offline"));
          if (offset + piece.byteLength > size) throw new Error(messageForFailure("corrupt"));
          let written = 0;
          while (written < piece.byteLength) {
            const res = await handle.write(piece, written, piece.byteLength - written, offset + written);
            written += res.bytesWritten;
          }
          hash.update(piece);
          offset += piece.byteLength;
        }
        await handle.close();
        handle = null;
        if (offset !== size || hash.digest("hex") !== expectedHex) {
          throw new Error(messageForFailure("corrupt"));
        }
        await rename(partial, dest);
        return dest;
      } catch (error) {
        if (handle) await handle.close().catch(() => undefined);
        await rm(partial, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  }
}
