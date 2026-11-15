// Botling 3 plugin `content.read(ref, offset, length)` on the server (M5-08a, protocol v1 §9A.7, §9A.8, §23, D69).
// Reads up to 4 MiB of a chat-referenced content item by reference (never by path) from either this server's
// `ContentService` or a peer server through `PeerContent.respond(..., LOCAL_WINDOW)`.
import { serveContentFile } from "../../main-v3/content-protocol";
import type { EntryRef, MessageOf } from "../../protocol";
import { LOCAL_WINDOW, PeerContent, PeerReadError, type PeerReadFailure } from "./peer-content";
import type { ContentService } from "./service";

export const PLUGIN_READ_MAX_BYTES = 4 * 1024 * 1024;

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

export class PluginContentRead {
  constructor(private readonly options: PluginContentReadOptions) {}

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
      const opened = await this.options.service.open(
        {
          t: "content.open",
          req: "plugin-read",
          owner: ref.owner,
          id: ref.id as MessageOf<"content.open">["id"],
          variant: "original",
          entry: ref.entry,
        },
        { remote: true },
      );
      if (opened.t === "content.gone") throw new Error(messageForFailure(opened.reason));
      response = await serveContentFile(opened, request, {
        onChanged: () => {
          void this.options.service.markChanged(opened.id).catch(() => undefined);
        },
      });
    } else {
      try {
        response = await this.options.peer.respond(
          { owner: ref.owner, id: ref.id, variant: "original", entry: ref.entry },
          request,
          LOCAL_WINDOW,
        );
      } catch (error) {
        throw mapStreamError(error, false);
      }
    }

    if (response.status === 416) {
      await response.body?.cancel().catch(() => undefined);
      return new Uint8Array(0);
    }
    if (response.status !== 200 && response.status !== 206) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(failureFromResponse(response, local));
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
}
