// M5-09: the content reference of the file a chat line's link names (`PluginWorld.lineContent`, protocol v1 §9A.8).
// A plugin's link button (`chat/link`) that runs on the machine that owns the bot gets `content` instead of `path` when the
// file is no longer on that machine's disk: the line's `content_names` row (which file of the line it is, by its absolute
// path) says which content item that was, and the pinned copy keeps serving its bytes (`content.read`, M5-08a).
import { ContentId, StreamId } from "../../protocol";
import type { Db } from "../store";
import { pathOfFileRef } from "./files";

export interface LineContentRef {
  owner: string;
  id: string;
  entry: { stream: StreamId; seq: number };
}

/**
 * The reference for `link` (a file: URL or an absolute path) in line `messageId` of bot `botId`, or null: the line names no such
 * file, the hash is not ready yet (a `pending:` id is local-socket only), the content is gone or changed, or the line's entry
 * no longer references it. Any odd value gives null (L-009); ids are bound as parameters, never built into a path (L-006).
 */
export function lineContentRef(db: Db, serverId: string, botId: string, messageId: string, link: string): LineContentRef | null {
  const stream = `bot:${botId}`;
  if (!StreamId.safeParse(stream).success || !messageId || messageId.length > 200) return null;
  const path = pathOfFileRef(link);
  if (!path) return null;
  const named = db.prepare("SELECT seq, id FROM content_names WHERE stream = ? AND line = ? AND path = ?").get(stream, messageId, path);
  if (!named) return null;
  const id = ContentId.safeParse(named.id);
  const seq = Number(named.seq);
  if (!id.success || !Number.isSafeInteger(seq) || seq < 1) return null;
  const ready = db.prepare("SELECT 1 FROM content WHERE id = ? AND state = 'ready'").get(id.data);
  const referenced = db.prepare("SELECT 1 FROM content_refs WHERE id = ? AND stream = ? AND seq = ?").get(id.data, stream, seq);
  if (!ready || !referenced) return null;
  return { owner: serverId, id: id.data, entry: { stream: stream as StreamId, seq } };
}
