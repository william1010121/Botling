// The owner's media jobs (protocol v1 §9A.5, §9A.8, §9A.9, D37, D42): what a content gets once its hash is ready.
//
// - A job is keyed by the source hash (`media_jobs (srcId, kind)`, kind = video | image | pdf) and is queued in the same
//   transaction that makes the content `ready` (service.ts `complete` calls `enqueue`), so no ready content is ever
//   without its job. It is idempotent, not an effect (§12): a job left `running` by a crash is queued again at start
//   and runs again; a variant made before the crash is kept (its row and file are checked) and not made twice.
// - One job at a time, each tool under `nice` (run.ts): the server's own work comes first.
// - Each variant is made in `<data>/variants/.tmp/`, hashed, moved to `<data>/variants/<src hex>/<name>.<ext>`, then one
//   command writes its row (primary key (srcId, variant): exactly one row per variant) and appends
//   `content.variant{id, variant}` on every active chat stream that references the source. A file not named by a row
//   (a crash between the move and the command) is swept at start.
// - Video: meta (ffprobe; recorded in `content_meta` and announced as the `original` variant with its bitrate and
//   height, which the FE's 1.5 × rule needs), a poster (≤ 640 px) and, only when `previewReason` says so, a preview.
//   Image: a thumbnail ≤ 512 px unless it is small already. PDF: page count (qpdf), page-1 thumbnail, the text (step 15:
//   page count, outline and page text as the JSON `text` variant, made by pdf.js in a child process, pdf-text.ts, and
//   announced by a `content.text{id, pages, textId}` entry besides its `content.variant`), and a linearized copy above
//   5 MB when qpdf is there and the file is not linearized.
// - A variant that could not be made says why in `media_jobs.note` (e.g. no ffmpeg: the original plays); the tools
//   missing are recorded in `meta.mediaTools` for `botlingd status` (notes.ts).
// - Variants are a cache that can be made again: above the cap (5 GB) the least recently used are evicted (row
//   `evicted`, file deleted); asking for an evicted variant queues its job again.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ContentVariant, Entry, StreamId } from "../../protocol";
import { appendEntries, readStream } from "../log";
import type { Command, Db, SqlRow } from "../store";
import { sameSig, statSig, type StatSig } from "../content/pin";
import { mp4Meta } from "./mp4";
import { PDF_TEXT_MAX_BYTES, type PdfText } from "./pdf-text";
import { killLeftoverTool, PDF_TEXT_SCRIPT, runTool, ToolError, type RunOptions } from "./run";
import type { ScriptRunner } from "../utility-process";
import { imageSize, isLinearized, linearize, LINEARIZE_ABOVE_BYTES, makeImageThumb, makePdfThumb, pdfPages, SMALL_IMAGE_BYTES, THUMB_MAX_PX } from "./still";
import { findTools, toolNotes, toolsSummary, type MediaTools } from "./tools";
import { makePoster, makePreview, previewReason, probeVideo, type VideoMeta } from "./video";

export type MediaKind = "video" | "image" | "pdf";

/** The job kind of a content type, or null (audio, other files: nothing to prepare). */
export function mediaKindOf(type: string): MediaKind | null {
  if (type.startsWith("video/")) return "video";
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("image/") && type !== "image/svg+xml") return "image";
  return null;
}

export const DEFAULT_VARIANTS_CAP_BYTES = 5 * 1000 * 1000 * 1000;
const MAX_TRIES = 3;
/** A tool runs at most this long (a 10 min video's preview takes ≈ 1.5–3 min on a busy Mac with VideoToolbox). */
const TOOL_TIMEOUT_MS = 30 * 60 * 1000;
const PROBE_TIMEOUT_MS = 60 * 1000;
/** The PDF text job's limit (a 100-page text PDF takes ≈ 0.2 s; a 2,000-page one some seconds). */
const PDF_TEXT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The PDF text job's script: beside the bundled botlingd (out/server/pdf-text.cjs), else the built one of this checkout
 * (tests run the source), else null (no text; the viewer still reads every page itself).
 */
export function defaultPdfTextScript(): string | null {
  const here = typeof __dirname === "string" ? __dirname : process.cwd();
  return [join(here, PDF_TEXT_SCRIPT), resolve(here, "../../../out/server", PDF_TEXT_SCRIPT)].find((file) => existsSync(file)) ?? null;
}
/** `lastUsed` is written at most once a minute per variant. */
const TOUCH_EVERY_MS = 60 * 1000;

export interface MediaStore {
  submit<T>(command: Command<T>): Promise<T>;
  openReader(): Db;
}

export interface MediaJobsOptions {
  store: MediaStore;
  dataDir: string;
  /** The tools (default: found on `PATH` once, at construction). */
  tools?: MediaTools;
  /** The variants' cap (default 5 GB). */
  capBytes?: number;
  linearizeAboveBytes?: number;
  onCommitted?: (streams: StreamId[]) => void;
  audit?: (text: string) => void;
  now?: () => number;
  /** Tests: called as a job reaches each step (`<kind>:<variant>`), before the step's tool runs. */
  onStep?: (srcId: string, step: string) => void;
  /** The PDF text script (default `defaultPdfTextScript()`); null: PDFs get no text variant. */
  pdfTextScript?: string | null;
  /** false: jobs are queued but run only on `kick()` from the caller (tests). Default true. */
  autoRun?: boolean;
  /** Packaged Electron builds cannot use ELECTRON_RUN_AS_NODE; run pdf-text via utilityProcess.fork. */
  packaged?: boolean;
  /** Overrides the child-process runner for PDF text jobs (Electron utilityProcess.fork when packaged). */
  pdfTextRunner?: ScriptRunner;
}

export interface VariantFile {
  path: string;
  type: string;
  sig: StatSig;
  size: number;
}

interface SourceRow { id: string; size: number; type: string; path: string; pin: string; sig: StatSig | null; state: string }

function sourceRow(db: Db, id: string): SourceRow | null {
  const row = db.prepare("SELECT id, size, type, pin, path, statSig, state FROM content WHERE id = ?").get(id);
  if (!row) return null;
  return {
    id: String(row.id), size: Number(row.size), type: String(row.type), path: String(row.path), pin: String(row.pin),
    sig: row.statSig == null ? null : (JSON.parse(String(row.statSig)) as StatSig), state: String(row.state),
  };
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file, { highWaterMark: 1024 * 1024 }).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(`sha256:${hash.digest("hex")}`));
  });
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "video/mp4": "mp4", "application/pdf": "pdf", "application/json": "json" };

/** The extension Quick Look needs to recognize a pinned (extension-less) video. */
const VIDEO_EXT: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };

/** One variant a job plans: `make` writes it to `out` (or answers null with why it cannot). */
interface Plan {
  name: string;
  make(out: string, run: RunOptions): Promise<{ type: string; info?: Record<string, unknown> } | { skip: string }>;
}

export class MediaJobs {
  readonly tools: MediaTools;
  private reader: Db | null = null;
  private running: Promise<void> | null = null;
  private wanted = false;
  private closed = false;
  private readonly abort = new AbortController();
  private readonly touched = new Map<string, number>();

  constructor(private readonly options: MediaJobsOptions) {
    this.tools = options.tools ?? findTools();
  }

  get variantsDir(): string { return join(this.options.dataDir, "variants"); }
  private get tmpDir(): string { return join(this.variantsDir, ".tmp"); }
  private get pidFile(): string { return join(this.tmpDir, "tool.pid"); }
  private get cap(): number { return this.options.capBytes ?? DEFAULT_VARIANTS_CAP_BYTES; }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private audit(text: string): void { this.options.audit?.(text); }
  private db(): Db {
    if (!this.reader) this.reader = this.options.store.openReader();
    return this.reader;
  }

  /** What is missing among the tools, for the log and status. */
  notes(): string[] { return toolNotes(this.tools); }

  /** Inside the command that made `id` ready: its job (once per source hash). */
  enqueue(db: Db, id: string, type: string): void {
    const kind = mediaKindOf(type);
    if (!kind || !id.startsWith("sha256:")) return;
    db.prepare("INSERT OR IGNORE INTO media_jobs (srcId, kind, state, tries, updatedAt) VALUES (?, ?, 'queued', 0, ?)").run(id, kind, this.now());
  }

  /**
   * Once at start (after the content index recovered): stops a tool a killed server left running, sweeps temp files
   * and variant files no row names, queues again every job left `running`, queues a job for every ready content that
   * has none (content indexed before step 10), records the tools for status, then runs the queue.
   */
  async start(): Promise<{ requeued: number; added: number; swept: number; killed: number | null }> {
    mkdirSync(this.tmpDir, { recursive: true });
    const killed = killLeftoverTool(this.pidFile);
    const swept = this.sweep();
    const at = this.now();
    const counts = await this.options.store.submit((db) => {
      const requeued = db.prepare("UPDATE media_jobs SET state = 'queued', updatedAt = ? WHERE state = 'running'").run(at).changes;
      let added = 0;
      const insert = db.prepare("INSERT OR IGNORE INTO media_jobs (srcId, kind, state, tries, updatedAt) VALUES (?, ?, 'queued', 0, ?)");
      for (const row of db.prepare("SELECT id, type FROM content WHERE state = 'ready' AND id LIKE 'sha256:%'").all()) {
        const kind = mediaKindOf(String(row.type));
        if (kind) added += insert.run(String(row.id), kind, at).changes;
      }
      db.prepare("INSERT INTO meta (key, value) VALUES ('mediaTools', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(toolsSummary(this.tools, at)));
      return { requeued, added };
    });
    this.kick();
    return { ...counts, swept, killed };
  }

  /** Removes temp files and variant files that no `ready` row names. */
  private sweep(): number {
    let swept = 0;
    for (const name of readdirSync(this.tmpDir)) { rmSync(join(this.tmpDir, name), { recursive: true, force: true }); swept++; }
    const keep = new Set(this.db().prepare("SELECT path FROM variants WHERE state = 'ready' AND path IS NOT NULL").all().map((row) => String(row.path)));
    for (const dir of readdirSync(this.variantsDir)) {
      if (dir === ".tmp") continue;
      const folder = join(this.variantsDir, dir);
      let names: string[];
      try { names = readdirSync(folder); } catch { rmSync(folder, { force: true }); swept++; continue; }
      for (const name of names) {
        const file = join(folder, name);
        if (!keep.has(file)) { rmSync(file, { recursive: true, force: true }); swept++; }
      }
      if (!readdirSync(folder).length) rmSync(folder, { recursive: true, force: true });
    }
    return swept;
  }

  /** Runs the queue (one job at a time) unless it runs already. */
  kick(): void {
    if (this.closed) return;
    this.wanted = true;
    if (this.options.autoRun === false && !this.manual) return;
    if (!this.running) this.running = this.drain().finally(() => { this.running = null; if (this.wanted && !this.closed) this.kick(); });
  }

  private manual = false;
  /** Tests (autoRun false): runs the queue now and resolves when it is empty. */
  async runNow(): Promise<void> {
    this.manual = true;
    try { this.kick(); await this.idle(); } finally { this.manual = false; }
  }

  private async drain(): Promise<void> {
    while (!this.closed) {
      this.wanted = false;
      const next = this.db().prepare("SELECT srcId, kind FROM media_jobs WHERE state = 'queued' ORDER BY updatedAt, srcId LIMIT 1").get();
      if (!next) return;
      try {
        await this.runJob(String(next.srcId), String(next.kind) as MediaKind);
      } catch (error) {
        if (this.closed) return;
        this.audit(`media: job ${String(next.srcId)} failed: ${String((error as Error)?.message ?? error)}`);
        await this.options.store.submit((db) => {
          const row = db.prepare("SELECT tries FROM media_jobs WHERE srcId = ? AND kind = ?").get(next.srcId, next.kind);
          const state = Number(row?.tries ?? 0) >= MAX_TRIES ? "failed" : "queued";
          db.prepare("UPDATE media_jobs SET state = ?, note = ?, updatedAt = ? WHERE srcId = ? AND kind = ? AND state = 'running'")
            .run(state, String((error as Error)?.message ?? error).slice(0, 1_000), this.now() + 1, next.srcId, next.kind);
        });
      }
    }
  }

  private async runJob(srcId: string, kind: MediaKind): Promise<void> {
    const claimed = await this.options.store.submit((db) => {
      const row = db.prepare("SELECT tries FROM media_jobs WHERE srcId = ? AND kind = ? AND state = 'queued'").get(srcId, kind);
      if (!row) return false;
      if (Number(row.tries) >= MAX_TRIES) {
        db.prepare("UPDATE media_jobs SET state = 'failed', updatedAt = ? WHERE srcId = ? AND kind = ?").run(this.now(), srcId, kind);
        return false;
      }
      db.prepare("UPDATE media_jobs SET state = 'running', tries = tries + 1, updatedAt = ? WHERE srcId = ? AND kind = ?").run(this.now(), srcId, kind);
      return true;
    });
    if (!claimed) return;
    const source = sourceRow(this.db(), srcId);
    const finish = (note: string | null) => this.options.store.submit((db) => {
      db.prepare("UPDATE media_jobs SET state = 'done', note = ?, updatedAt = ? WHERE srcId = ? AND kind = ? AND state = 'running'").run(note, this.now(), srcId, kind);
    });
    if (!source || source.state !== "ready") { await finish("the source is no longer ready"); return; }
    if (!this.sourceMatches(source)) { await finish("the source changed before its variants were made"); return; }
    const run: RunOptions = { timeoutMs: TOOL_TIMEOUT_MS, pidFile: this.pidFile, signal: this.abort.signal };
    const probe: RunOptions = { ...run, timeoutMs: PROBE_TIMEOUT_MS };
    const plans = await this.plan(source, kind, run, probe);
    const notes: string[] = [];
    for (const plan of plans) {
      if (this.closed) return;
      if (this.haveVariant(srcId, plan.name)) continue;
      this.options.onStep?.(srcId, `${kind}:${plan.name}`);
      const out = join(this.tmpDir, `${srcId.slice(7, 23)}-${plan.name}-${process.pid}`);
      try {
        const made = await plan.make(out, run);
        if ("skip" in made) { notes.push(`${plan.name}: ${made.skip}`); continue; }
        if (this.closed) return;
        if (!this.sourceMatches(source)) { notes.push("the source changed while its variants were made"); break; }
        await this.keep(source, plan.name, out, made.type, made.info ?? {});
      } finally {
        rmSync(out, { force: true });
      }
    }
    await finish(notes.length ? notes.join("; ").slice(0, 1_000) : null);
  }

  /** A `pin: path` source still has the signature it was hashed with; a clone or copy always does. */
  private sourceMatches(source: SourceRow): boolean {
    try { return sameSig(statSig(source.path), source.sig); } catch { return false; }
  }

  /** The variant is kept already: its row is ready and its file is there with the recorded signature. */
  private haveVariant(srcId: string, name: string): boolean {
    const row = this.db().prepare("SELECT path, statSig FROM variants WHERE srcId = ? AND variant = ? AND state = 'ready'").get(srcId, name);
    if (!row || row.path == null) return false;
    try { return sameSig(statSig(String(row.path)), JSON.parse(String(row.statSig)) as StatSig); } catch { return false; }
  }

  private async plan(source: SourceRow, kind: MediaKind, run: RunOptions, probe: RunOptions): Promise<Plan[]> {
    const tools = this.tools;
    if (kind === "video") {
      let meta: VideoMeta | null = this.storedMeta(source.id) as VideoMeta | null;
      if (!meta) {
        this.options.onStep?.(source.id, "video:meta");
        try { meta = await probeVideo(tools, source.path, source.size, probe); } catch (error) { this.audit(`media: ffprobe of ${source.id} failed: ${String((error as Error)?.message ?? error)}`); }
        // Without ffprobe (or when it failed): the MP4/MOV index read in JavaScript.
        if (!meta && (source.type === "video/mp4" || source.type === "video/quicktime")) meta = mp4Meta(source.path);
        await this.recordMeta(source, { ...(meta ?? {}) }, meta);
      }
      const plans: Plan[] = [{
        name: "poster",
        make: async (out) => (await makePoster(tools, source.path, meta, out, run, VIDEO_EXT[source.type] ?? "mp4")) ?? { skip: "no ffmpeg or Quick Look to make a poster" },
      }];
      const why = previewReason(meta, source.size, source.type);
      if (why) {
        plans.push({
          name: "preview",
          make: async (out) => {
            if (!tools.paths.ffmpeg) return { skip: `no preview (the original is ${why}): ffmpeg is not on botlingd's PATH, so the original plays` };
            const made = await makePreview(tools, source.path, meta, out, run);
            if (!made) return { skip: `no preview (the original is ${why}): this ffmpeg has no H.264 encoder, so the original plays` };
            const info = await probeVideo(tools, out, statSync(out).size, probe).catch(() => null);
            return { type: made.type, info: { reason: why, encoder: made.encoder, ...(info?.bitrate ? { bitrate: info.bitrate } : {}), ...(info?.height ? { height: info.height } : {}), ...(info?.width ? { width: info.width } : {}) } };
          },
        });
      }
      return plans;
    }
    if (kind === "image") {
      const size = await imageSize(tools, source.path, probe);
      if (size) await this.recordMeta(source, size, null);
      if (size && Math.max(size.width, size.height) <= THUMB_MAX_PX && source.size <= SMALL_IMAGE_BYTES) return [];
      return [{ name: "thumb", make: async (out) => (await makeImageThumb(tools, source.path, out, run)) ?? { skip: "no sips or ffmpeg to make a thumbnail" } }];
    }
    const pages = await pdfPages(tools, source.path, probe);
    if (pages) await this.recordMeta(source, { pages }, null);
    const plans: Plan[] = [{
      name: "thumb",
      make: async (out) => {
        const made = await makePdfThumb(tools, source.path, out, run);
        return made ? { type: made.type, info: { tool: made.tool } } : { skip: "no sips, pdftoppm or Quick Look: the viewer draws page 1 itself" };
      },
    }];
    plans.push({ name: "text", make: (out, options) => this.makePdfText(source, out, options) });
    if (source.size > (this.options.linearizeAboveBytes ?? LINEARIZE_ABOVE_BYTES)) {
      plans.push({
        name: "linearized",
        make: async (out) => {
          if (!tools.paths.qpdf) return { skip: "not linearized: qpdf is not on botlingd's PATH" };
          if (await isLinearized(tools, source.path, probe)) return { skip: "linearized already" };
          return (await linearize(tools, source.path, out, run)) ?? { skip: "qpdf made nothing" };
        },
      });
    }
    return plans;
  }

  /** The `text` variant (step 15): pdf.js in a child process of botlingd's own runtime, under nice and a time limit. */
  private async makePdfText(source: SourceRow, out: string, run: RunOptions): Promise<{ type: string; info: Record<string, unknown> } | { skip: string }> {
    const script = this.options.pdfTextScript === undefined ? defaultPdfTextScript() : this.options.pdfTextScript;
    if (!script) return { skip: "no PDF text: the text script is not built (out/server/pdf-text.cjs)" };
    if (source.size > PDF_TEXT_MAX_BYTES) return { skip: `no PDF text: the file is above ${PDF_TEXT_MAX_BYTES} bytes` };
    try {
      if (this.options.pdfTextRunner) {
        await this.options.pdfTextRunner(script, [source.path, out], { ...run, timeoutMs: PDF_TEXT_TIMEOUT_MS });
      } else if (this.options.packaged) {
        return { skip: "no PDF text: packaged utility runner is unavailable" };
      } else {
        await runTool(this.tools, process.execPath, [script, source.path, out], { ...run, timeoutMs: PDF_TEXT_TIMEOUT_MS, env: { ELECTRON_RUN_AS_NODE: "1" } });
      }
    } catch (error) {
      // A file pdf.js cannot read (or one that ran out of time) fails the same way again: noted, not retried.
      if (error instanceof ToolError && !this.closed) return { skip: `no PDF text: ${error.message}`.slice(0, 500) };
      throw error;
    }
    const text = JSON.parse(readFileSync(out, "utf8")) as PdfText;
    if (text?.v !== 1 || !Number.isInteger(text.pages) || !Array.isArray(text.text)) throw new Error("pdf-text wrote no text");
    return { type: "application/json", info: { pages: text.pages, outline: text.outline?.length ?? 0, ...(text.truncated ? { truncated: true } : {}) } };
  }

  private storedMeta(id: string): Record<string, unknown> | null {
    const row = this.db().prepare("SELECT meta FROM content_meta WHERE id = ?").get(id);
    return row ? (JSON.parse(String(row.meta)) as Record<string, unknown>) : null;
  }

  /** The source's meta; for a video also the `original` variant (bitrate, height) on each stream, once. */
  private async recordMeta(source: SourceRow, meta: Record<string, unknown>, video: VideoMeta | null): Promise<void> {
    const streams = await this.options.store.submit((db) => {
      const fresh = db.prepare("INSERT OR IGNORE INTO content_meta (id, meta) VALUES (?, ?)").run(source.id, JSON.stringify(meta)).changes > 0;
      if (!fresh || !video) return [];
      const variant: ContentVariant = {
        name: "original", id: source.id, size: source.size, type: source.type,
        ...(video.bitrate ? { bitrate: video.bitrate } : {}), ...(video.height ? { height: Math.round(video.height) } : {}),
        ...(video.duration ? { durationMs: Math.round(video.duration * 1000) } : {}),
      };
      return this.announce(db, source.id, variant);
    });
    if (streams.length) this.options.onCommitted?.(streams);
  }

  /** `content.variant{id, variant}` on every active chat stream that references `srcId`. */
  private announce(db: Db, srcId: string, variant: ContentVariant): StreamId[] {
    return this.announceEntry(db, srcId, { kind: "content.variant", body: { id: srcId, variant: variant as unknown as Record<string, unknown> } });
  }

  /** One entry about `srcId` on every active chat stream that references it (the entry references it too). */
  private announceEntry(db: Db, srcId: string, event: { kind: string; body: Record<string, unknown> }): StreamId[] {
    const touched: StreamId[] = [];
    const insertRef = db.prepare("INSERT OR IGNORE INTO content_refs (id, stream, seq) VALUES (?, ?, ?)");
    for (const row of db.prepare("SELECT DISTINCT stream FROM content_refs WHERE id = ? ORDER BY stream").all(srcId)) {
      const stream = String(row.stream) as StreamId;
      if (!stream.startsWith("bot:") || readStream(db, stream)?.state !== "active") continue;
      const [entry] = appendEntries(db, stream, [event], { now: this.now() }) as Entry[];
      // The entry references the source too: a front end that learns of the variant from it may open it with it.
      insertRef.run(srcId, stream, entry!.seq);
      touched.push(stream);
    }
    return touched;
  }

  /** Hashes the made file, moves it into place and records it (row + `content.variant`), then applies the cap. */
  private async keep(source: SourceRow, name: string, tmp: string, type: string, info: Record<string, unknown>): Promise<void> {
    const id = await sha256File(tmp);
    const dir = join(this.variantsDir, source.id.slice(7));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}.${EXT[type] ?? "bin"}`);
    renameSync(tmp, file);
    const sig = statSig(file);
    const at = this.now();
    const result = await this.options.store.submit((db) => {
      const job = db.prepare("SELECT 1 FROM media_jobs WHERE srcId = ? AND state = 'running'").get(source.id);
      const content = db.prepare("SELECT state FROM content WHERE id = ?").get(source.id);
      if (!job || content?.state !== "ready") return { kept: false, streams: [] as StreamId[] };
      db.prepare(
        "INSERT INTO variants (srcId, variant, id, state, lastUsed, path, statSig, size, type, info, createdAt) VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (srcId, variant) DO UPDATE SET id = excluded.id, state = 'ready', lastUsed = excluded.lastUsed, path = excluded.path, " +
        "statSig = excluded.statSig, size = excluded.size, type = excluded.type, info = excluded.info, createdAt = excluded.createdAt",
      ).run(source.id, name, id, at, file, JSON.stringify(sig), sig.size, type, JSON.stringify(info), at);
      const variant: ContentVariant = {
        name, id, size: sig.size, type,
        ...(typeof info.bitrate === "number" ? { bitrate: info.bitrate } : {}), ...(typeof info.height === "number" ? { height: Math.round(info.height) } : {}),
      };
      const streams = this.announce(db, source.id, variant);
      if (name === "text" && typeof info.pages === "number") {
        // The page count is the source's meta when qpdf did not give it, and `content.text` names the text (§9A.8).
        db.prepare("INSERT OR IGNORE INTO content_meta (id, meta) VALUES (?, ?)").run(source.id, JSON.stringify({ pages: info.pages }));
        for (const stream of this.announceEntry(db, source.id, { kind: "content.text", body: { id: source.id, pages: info.pages, textId: id } })) if (!streams.includes(stream)) streams.push(stream);
      }
      return { kept: true, streams };
    });
    if (!result.kept) { rmSync(file, { force: true }); return; }
    if (result.streams.length) this.options.onCommitted?.(result.streams);
    await this.enforceCap({ srcId: source.id, variant: name });
  }

  /** Evicts the least recently used variants while their total is above the cap (never `keep`, the one just made). */
  async enforceCap(keep?: { srcId: string; variant: string }): Promise<number> {
    const cap = this.cap;
    const removed = await this.options.store.submit((db) => {
      let total = Number(db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM variants WHERE state = 'ready'").get()?.n ?? 0);
      if (total <= cap) return [] as string[];
      const files: string[] = [];
      const evict = db.prepare("UPDATE variants SET state = 'evicted', path = NULL, statSig = NULL WHERE srcId = ? AND variant = ?");
      for (const row of db.prepare("SELECT srcId, variant, path, size FROM variants WHERE state = 'ready' ORDER BY COALESCE(lastUsed, createdAt, 0), createdAt").all()) {
        if (total <= cap) break;
        if (keep && row.srcId === keep.srcId && row.variant === keep.variant) continue;
        evict.run(row.srcId, row.variant);
        if (row.path != null) files.push(String(row.path));
        total -= Number(row.size ?? 0);
      }
      return files;
    });
    for (const file of removed) rmSync(file, { force: true });
    if (removed.length) this.audit(`media: evicted ${removed.length} variant file(s) above the ${cap}-byte cap`);
    return removed.length;
  }

  /**
   * What a front end may pick from for `srcId` now (M2 step 11): the `original` (a video's bitrate, height, duration
   * from its meta) and every ready variant. Sync read; the source row's size and type come from the caller.
   */
  variantsOf(source: { id: string; size: number; type: string }): ContentVariant[] {
    const db = this.db();
    const out: ContentVariant[] = [];
    const meta = this.storedMeta(source.id) as VideoMeta | null;
    if (meta && source.type.startsWith("video/")) {
      out.push({
        name: "original", id: source.id, size: source.size, type: source.type,
        ...(meta.bitrate ? { bitrate: meta.bitrate } : {}), ...(meta.height ? { height: Math.round(meta.height) } : {}),
        ...(meta.duration ? { durationMs: Math.round(meta.duration * 1000) } : {}),
      });
    }
    for (const row of db.prepare("SELECT variant, id, size, type, info FROM variants WHERE srcId = ? AND state = 'ready' ORDER BY variant").all(source.id)) {
      if (out.length >= 20 || row.id == null || row.type == null) continue;
      let info: Record<string, unknown> = {};
      try { info = JSON.parse(String(row.info ?? "{}")) as Record<string, unknown>; } catch { /* no info */ }
      out.push({
        name: String(row.variant), id: String(row.id), size: Number(row.size ?? 0), type: String(row.type),
        ...(typeof info.bitrate === "number" ? { bitrate: info.bitrate } : {}), ...(typeof info.height === "number" ? { height: Math.round(info.height) } : {}),
      });
    }
    return out;
  }

  /**
   * The file of a ready variant of `srcId` (the caller checked the proof of reference), or null. Marks it used (LRU).
   * An evicted variant queues its job again and answers null meanwhile (the FE plays the original).
   */
  async openVariant(srcId: string, name: string): Promise<VariantFile | null> {
    const row = this.db().prepare("SELECT path, statSig, size, type, state FROM variants WHERE srcId = ? AND variant = ?").get(srcId, name) as SqlRow | undefined;
    if (!row) return null;
    if (row.state === "ready" && row.path != null) {
      const sig = JSON.parse(String(row.statSig)) as StatSig;
      let now: StatSig | null = null;
      try { now = statSig(String(row.path)); } catch { now = null; }
      if (sameSig(now, sig)) {
        this.touch(srcId, name);
        return { path: String(row.path), type: String(row.type), sig, size: Number(row.size) };
      }
    }
    // Evicted, or its file is gone: make it again.
    await this.options.store.submit((db) => {
      db.prepare("UPDATE variants SET state = 'evicted', path = NULL, statSig = NULL WHERE srcId = ? AND variant = ?").run(srcId, name);
      db.prepare("UPDATE media_jobs SET state = 'queued', tries = 0, updatedAt = ? WHERE srcId = ? AND state IN ('done', 'failed')").run(this.now(), srcId);
    });
    this.kick();
    return null;
  }

  private touch(srcId: string, name: string): void {
    const key = `${srcId}\u0000${name}`;
    const at = this.now();
    if (at - (this.touched.get(key) ?? 0) < TOUCH_EVERY_MS) return;
    this.touched.set(key, at);
    if (this.touched.size > 10_000) this.touched.clear();
    void this.options.store.submit((db) => { db.prepare("UPDATE variants SET lastUsed = ? WHERE srcId = ? AND variant = ?").run(at, srcId, name); }).catch(() => undefined);
  }

  /** Each job's state and note (status, tests). */
  jobs(): Array<{ srcId: string; kind: string; state: string; tries: number; note: string | null }> {
    return this.db().prepare("SELECT srcId, kind, state, tries, note FROM media_jobs ORDER BY updatedAt").all()
      .map((row) => ({ srcId: String(row.srcId), kind: String(row.kind), state: String(row.state), tries: Number(row.tries), note: row.note == null ? null : String(row.note) }));
  }

  /** Resolves when the queue is empty and no job runs. */
  async idle(): Promise<void> {
    while (this.running) await this.running.catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abort.abort();
    await this.running?.catch(() => undefined);
    this.reader?.close();
    this.reader = null;
  }
}
