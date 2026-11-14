// The page's attachments (M2 step 12, protocol v1 §9A.9): files the chat frame hands over are uploaded at once over the
// session (src/fe-link/uploader.ts) and wait in the bot's input box as chips (the snapshot's `pendingFiles`, merged in
// by bridge-v3.ts). Sending the message takes them: the bridge waits for their hashes and puts them in the
// `chat.send`'s `files`, and the command goes to the outbox while the bytes may still be on their way; the server holds
// it until they are in. An upload keeps going after its message was sent, until the server has every byte.
//
// Known limit: the bytes live in this page's memory (the `File`), not in IndexedDB. A reload while an upload is under
// way loses them; the message in the outbox is then refused by the server after its idle wait ("did not arrive").
import type { PendingFileView, UploadedFile } from "../../src/contract";
import { Uploader, type UploadLink, type UploadSource, type UploadView } from "../../src/fe-link";
import { kindOfType } from "../media-wire";
import type { FrameUploadMessage, ShellUploadMessage, UploadRow } from "../upload-wire";

/** What the bridge uses (`PageCapabilities.uploads`). */
export interface PageUploadsPort {
  /** The chips of a bot's input box from this page. */
  pending(botId: string): PendingFileView[];
  /** Whether `id` is one of this page's chips (then `remove` takes it). */
  owns(botId: string, id: string): boolean;
  remove(botId: string, id: string): void;
  /** The files for a `chat.send` of this bot (waits for their hashes); throws when one failed. */
  take(botId: string): Promise<UploadedFile[]>;
  /** Puts back what `take` gave (the send did not reach the outbox). */
  untake(botId: string, files: UploadedFile[]): void;
  /** Told when the chips changed (the bridge resyncs the renderer). */
  onChipsChanged(listener: () => void): () => void;
}

/** A browser Blob read 1 MiB at a time. */
export function blobSource(blob: Blob): UploadSource {
  return { size: blob.size, read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()) };
}

const STATE_WORDS: Record<string, string> = { hashing: "reading", waiting: "waiting", uploading: "sending", done: "ready", failed: "failed" };

export class PageUploads implements PageUploadsPort {
  readonly uploader: Uploader;
  /** Chips by bot: upload keys in the order added. */
  private readonly chips = new Map<string, string[]>();
  /** Every upload's bot (also after its chip went with a message). */
  private readonly botOf = new Map<string, string>();
  private readonly chipListeners = new Set<() => void>();
  private readonly offs: Array<() => void> = [];
  private lastState = new Map<string, string>();
  private frameTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(link: UploadLink, private readonly frame: () => Window | null, private readonly diag?: Record<string, unknown>) {
    this.uploader = new Uploader(link);
    this.offs.push(this.uploader.onChange((view) => this.changed(view)));
  }

  start(): void {
    const onMessage = (event: MessageEvent) => {
      const frame = this.frame();
      if (!frame || event.source !== frame) return;
      const data = event.data as FrameUploadMessage | null;
      if (!data || typeof data !== "object" || data.botling3 !== "upload.add" || typeof data.botId !== "string" || !Array.isArray(data.files)) return;
      for (const file of data.files) if (file instanceof Blob) this.add(data.botId, file as File);
    };
    window.addEventListener("message", onMessage);
    this.offs.push(() => window.removeEventListener("message", onMessage));
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    this.uploader.close();
  }

  /** Adds a file to a bot's input box and starts its upload. */
  add(botId: string, file: File): UploadView {
    const view = this.uploader.add({ name: file.name || "file", type: file.type || "application/octet-stream", source: blobSource(file) });
    this.botOf.set(view.key, botId);
    this.chips.set(botId, [...(this.chips.get(botId) ?? []), view.key]);
    this.changed(view);
    this.notifyChips();
    return view;
  }

  pending(botId: string): PendingFileView[] {
    return (this.chips.get(botId) ?? []).flatMap((key) => {
      const view = this.uploader.get(key);
      if (!view) return [];
      // A chip is a "file" whatever its type: an image chip would ask the server for a thumbnail it does not have.
      return [{ id: key, name: `${view.name} · ${STATE_WORDS[view.state] ?? view.state}`.slice(0, 400), kind: "file" as const }];
    });
  }

  owns(botId: string, id: string): boolean { return (this.chips.get(botId) ?? []).includes(id); }

  remove(botId: string, id: string): void {
    const keys = this.chips.get(botId) ?? [];
    if (!keys.includes(id)) return;
    this.chips.set(botId, keys.filter((key) => key !== id));
    this.uploader.remove(id);
    this.notifyChips();
  }

  async take(botId: string): Promise<UploadedFile[]> {
    const keys = [...(this.chips.get(botId) ?? [])];
    if (!keys.length) return [];
    const files: UploadedFile[] = [];
    for (const key of keys) {
      let id: string;
      try { id = await this.uploader.id(key); } catch (error) {
        throw new Error(`${this.uploader.get(key)?.name ?? "An attachment"} cannot be sent: ${String((error as Error)?.message ?? error)} Remove it first.`);
      }
      const view = this.uploader.get(key)!;
      if (view.state === "failed") throw new Error(`${view.name} cannot be sent: ${view.error ?? "it could not be uploaded."} Remove it first.`);
      files.push({ id, name: view.name.slice(0, 255) || "file", size: view.size, type: view.type.slice(0, 200) || "application/octet-stream" });
    }
    this.chips.set(botId, (this.chips.get(botId) ?? []).filter((key) => !keys.includes(key)));
    this.taken.set(botId, keys);
    this.notifyChips();
    return files;
  }

  private readonly taken = new Map<string, string[]>();

  untake(botId: string, _files: UploadedFile[]): void {
    const keys = this.taken.get(botId) ?? [];
    this.taken.delete(botId);
    if (keys.length) { this.chips.set(botId, [...keys, ...(this.chips.get(botId) ?? [])]); this.notifyChips(); }
  }

  onChipsChanged(listener: () => void): () => void {
    this.chipListeners.add(listener);
    return () => { this.chipListeners.delete(listener); };
  }

  /** Every upload of this page (diagnostics). */
  views(): UploadView[] { return this.uploader.list(); }

  private notifyChips(): void { for (const listener of [...this.chipListeners]) listener(); }

  private changed(view: UploadView): void {
    if (this.diag) this.diag[view.key] = { name: view.name, state: view.state, sent: view.sent, size: view.size, id: view.id, puts: view.puts, resumedAt: view.resumedAt, error: view.error, kind: kindOfType(view.type) };
    const before = this.lastState.get(view.key);
    this.lastState.set(view.key, view.state);
    // A chip's words change with its state (not with every byte): resync only then.
    if (before !== view.state && [...this.chips.values()].some((keys) => keys.includes(view.key))) this.notifyChips();
    this.scheduleFrame();
  }

  /** The progress lines under the composer, at most 4 times a second. */
  private scheduleFrame(): void {
    if (this.frameTimer) return;
    this.frameTimer = setTimeout(() => {
      this.frameTimer = null;
      const items: UploadRow[] = this.uploader.list().filter((view) => view.state !== "removed").map((view) => ({
        key: view.key, botId: this.botOf.get(view.key) ?? "", name: view.name, state: view.state, sent: view.sent, size: view.size, ...(view.error ? { error: view.error } : {}),
      }));
      const message: ShellUploadMessage = { botling3: "uploads", items };
      this.frame()?.postMessage(message, "*");
    }, 250);
  }
}
