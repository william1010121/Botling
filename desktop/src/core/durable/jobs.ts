// Durable jobs: routines and worker hand-offs that must survive a core crash without being sent
// twice. Mirrors the Swift ScheduledRoutineStore contract:
//   pending → claimed → delivered            (normal)
//   claimed → delivery_uncertain              (the claiming core died before confirming delivery)
//   pending → cancelled
// Persistence precedes dispatch: a job is written as `claimed` before the core hands it on, so a
// crash in between leaves `claimed`, which recovery turns into `delivery_uncertain` and never
// re-sends. `delivered` means handed on, not that the work succeeded. Exactly-once delivery to an
// external system is not something a local claim can promise; uncertain ones are shown to the user.
import { existsSync, readFileSync } from "node:fs";
import { BOOT_ID, withFileLock, writeFileAtomic } from "./atomic";

export type JobState = "pending" | "claimed" | "delivered" | "delivery_uncertain" | "cancelled";

export interface Job {
  id: string;
  /** Given by whoever created it; creating again with the same requestId returns the same job. */
  requestId: string;
  task: string;
  state: JobState;
  createdAt: string;
  claim?: { pid: number; boot: string; at: string };
  deliveredAt?: string;
  uncertainAt?: string;
}

interface Document { version: 1; jobs: Job[] }

export class StoreCorrupt extends Error {}

export class JobStore {
  constructor(readonly file: string, readonly boot: string = BOOT_ID) {}

  private transaction<T>(body: (jobs: Job[]) => T): T {
    return withFileLock(this.file, () => {
      const doc = this.read();
      const before = JSON.stringify(doc.jobs);
      const result = body(doc.jobs);
      if (JSON.stringify(doc.jobs) !== before) writeFileAtomic(this.file, JSON.stringify(doc, null, 2));
      return result;
    });
  }

  /** Never substitutes empty data for a file it cannot read: that would re-send everything. */
  private read(): Document {
    if (!existsSync(this.file)) return { version: 1, jobs: [] };
    let doc: Document;
    try {
      doc = JSON.parse(readFileSync(this.file, "utf8")) as Document;
    } catch (error) {
      throw new StoreCorrupt(`Cannot read ${this.file}; keep it for recovery. ${(error as Error).message}`);
    }
    if (doc.version !== 1 || !Array.isArray(doc.jobs)) throw new StoreCorrupt(`Unsupported job store version in ${this.file}.`);
    return doc;
  }

  list(): Job[] {
    return this.transaction((jobs) => jobs.map((job) => ({ ...job })));
  }

  create(requestId: string, task: string, now = new Date()): Job {
    return this.transaction((jobs) => {
      const existing = jobs.find((job) => job.requestId === requestId);
      if (existing) {
        if (existing.task !== task) throw new Error("requestId already belongs to a different job.");
        return { ...existing };
      }
      const job: Job = { id: `job-${jobs.length + 1}-${requestId}`, requestId, task, state: "pending", createdAt: now.toISOString() };
      jobs.push(job);
      return { ...job };
    });
  }

  /**
   * At core start: claims made by a run that is gone become `delivery_uncertain`. Claims of a run
   * that is still alive (another core, e.g. during an upgrade hand-over) are left alone.
   */
  recover(isAlive: (pid: number, boot: string) => boolean = defaultAlive, now = new Date()): Job[] {
    return this.transaction((jobs) => {
      const changed: Job[] = [];
      for (const job of jobs) {
        if (job.state !== "claimed" || !job.claim) continue;
        if (job.claim.boot === this.boot || isAlive(job.claim.pid, job.claim.boot)) continue;
        job.state = "delivery_uncertain";
        job.uncertainAt = now.toISOString();
        changed.push({ ...job });
      }
      return changed;
    });
  }

  /** Takes the next pending job for this run, persisting the claim before returning it. */
  claimNext(now = new Date()): Job | null {
    return this.transaction((jobs) => {
      const job = jobs.find((candidate) => candidate.state === "pending");
      if (!job) return null;
      job.state = "claimed";
      job.claim = { pid: process.pid, boot: this.boot, at: now.toISOString() };
      return { ...job };
    });
  }

  /** Confirms a claimed job was handed on. Only the run that claimed it may confirm it. */
  markDelivered(id: string, now = new Date()): boolean {
    return this.transaction((jobs) => {
      const job = jobs.find((candidate) => candidate.id === id);
      if (!job || job.state !== "claimed" || job.claim?.boot !== this.boot) return false;
      job.state = "delivered";
      job.deliveredAt = now.toISOString();
      return true;
    });
  }

  cancel(id: string): Job {
    return this.transaction((jobs) => {
      const job = jobs.find((candidate) => candidate.id === id);
      if (!job) throw new Error("Unknown job id.");
      if (job.state === "claimed") throw new Error("Already claimed for delivery; cancelling cannot retract it.");
      if (job.state === "pending") job.state = "cancelled";
      return { ...job };
    });
  }
}

/**
 * A claim's run is alive if its pid exists. (A reused pid could make a dead run look alive; that
 * errs towards leaving a job `claimed` — shown as uncertain by the next recovery after that pid
 * ends — never towards sending twice.)
 */
function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The dispatch loop: claim (persisted), deliver, confirm. `deliver` must be the step that hands the
 * job on (append to a chat, send to a worker). A crash anywhere in the loop at worst leaves one
 * job `claimed` → `delivery_uncertain`.
 */
export async function drain(store: JobStore, deliver: (job: Job) => Promise<void> | void): Promise<number> {
  let count = 0;
  for (let job = store.claimNext(); job; job = store.claimNext()) {
    await deliver(job);
    store.markDelivered(job.id);
    count++;
  }
  return count;
}
