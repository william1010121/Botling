// The app's end of one link to `botling-agent` (an ssh process's stdio, or the relay channel): requests to the
// machine (`rpc`), files in chunks (`blob`), and the session frames, handed to whoever opened the session.
import { randomUUID } from "node:crypto";
import { BLOB_CHUNK, type BlobFrame, type DownFrame, type UpFrame } from "./protocol";

export class FrameLink {
  private calls = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private blobs = new Map<string, { chunks: Buffer[]; done: boolean; waiters: { resolve(data: Buffer): void; reject(error: Error): void }[] }>();
  private ended: string | null = null;

  constructor(private write: (frame: DownFrame) => void, private onFrame: (frame: UpFrame) => void, private timeoutMs = 10 * 60_000) {}

  send(frame: DownFrame) { if (this.ended === null) { try { this.write(frame); } catch { /* the link is going */ } } }

  /** A frame from the agent. */
  receive(frame: Record<string, unknown> & { t: string }) {
    if (frame.t === "rpcResult") {
      const call = this.calls.get(String(frame.id));
      if (!call) return;
      this.calls.delete(String(frame.id));
      clearTimeout(call.timer);
      if (frame.ok) call.resolve(frame.result); else call.reject(new Error(String(frame.error ?? "The machine refused the request.")));
      return;
    }
    if (frame.t === "blob") {
      const blob = frame as unknown as BlobFrame;
      if (typeof blob.id !== "string" || typeof blob.data !== "string") return;
      const entry = this.entry(blob.id);
      entry.chunks.push(Buffer.from(blob.data, "base64"));
      if (blob.end) { entry.done = true; const data = Buffer.concat(entry.chunks); for (const w of entry.waiters.splice(0)) w.resolve(data); }
      return;
    }
    this.onFrame(frame as unknown as UpFrame);
  }

  rpc(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (this.ended !== null) return Promise.reject(new Error(this.ended));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.calls.delete(id); reject(new Error(`The machine did not answer ${op} in time.`)); }, this.timeoutMs);
      timer.unref?.();
      this.calls.set(id, { resolve, reject, timer });
      this.send({ t: "rpc", id, op, args });
    });
  }

  sendBlob(data: Buffer): string {
    const id = randomUUID();
    if (!data.length) { this.send({ t: "blob", id, seq: 0, data: "", end: true }); return id; }
    for (let at = 0, seq = 0; at < data.length; at += BLOB_CHUNK, seq++) {
      this.send({ t: "blob", id, seq, data: data.subarray(at, at + BLOB_CHUNK).toString("base64"), ...(at + BLOB_CHUNK >= data.length ? { end: true } : {}) });
    }
    return id;
  }

  takeBlob(id: string): Promise<Buffer> {
    const entry = this.entry(id);
    if (entry.done) { this.blobs.delete(id); return Promise.resolve(Buffer.concat(entry.chunks)); }
    if (this.ended !== null) return Promise.reject(new Error(this.ended));
    return new Promise((resolve, reject) => entry.waiters.push({ resolve: (data) => { this.blobs.delete(id); resolve(data); }, reject }));
  }

  private entry(id: string) {
    let entry = this.blobs.get(id);
    if (!entry) { entry = { chunks: [], done: false, waiters: [] }; this.blobs.set(id, entry); }
    return entry;
  }

  /** The link ended: whatever waits on it fails. */
  end(reason = "The connection to the machine ended.") {
    if (this.ended !== null) return;
    this.ended = reason;
    for (const call of this.calls.values()) { clearTimeout(call.timer); call.reject(new Error(reason)); }
    this.calls.clear();
    for (const entry of this.blobs.values()) for (const w of entry.waiters) w.reject(new Error(reason));
    this.blobs.clear();
  }
}
