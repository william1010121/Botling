import { DeliveryUncertain, type DeliveryResult } from '../../../../Web/src/composer-host';
export const ACCEPTANCE_TIMEOUT_MS = 30_000;
const JOURNAL_KEY = 'botling.composerDeliveries.v1';
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface Delivery { requestID: string; botID: string; type: string; uncertain: boolean }
interface Pending {
  resolve: () => void; reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>; late?: (result: DeliveryResult) => void;
}
/** Requests settle in bounded time; unknown outcomes require acknowledgement, never an automatic retry. */
export class ComposerRequests {
  private readonly pending = new Map<string, Pending>();
  private readonly late = new Map<string, { result?: (result: DeliveryResult) => void }>();
  private readonly journal = new Map<string, Delivery>();
  constructor(private post: (action: { type: string; [key: string]: unknown }) => boolean,
    private changed: () => void, private storage: Storage | null = null) {
    // Surviving a page reload does not prove anything about an in-flight request's outcome.
    try {
      const records: unknown = JSON.parse(storage?.getItem(JOURNAL_KEY) ?? '[]');
      if (Array.isArray(records)) for (const record of records.slice(0, 128)) {
        if (record && typeof record.requestID === 'string' && record.requestID.length <= 80 &&
          typeof record.botID === 'string' && record.botID.length <= 160 && ['send', 'addFileData', 'pickFiles'].includes(record.type)) {
          this.journal.set(record.requestID, { requestID: record.requestID, botID: record.botID, type: record.type, uncertain: true });
        }
      }
    } catch { /* Storage is optional; drafts and outcomes still remain in memory. */ }
  }
  unknown(botID?: string): Delivery[] { return [...this.journal.values()].filter(item => item.uncertain && (botID === undefined || item.botID === botID)); }
  request(action: { type: string; botID: string; [key: string]: unknown }, late?: (result: DeliveryResult) => void): Promise<void> {
    if (this.journal.size >= 128) return Promise.reject(new Error('Check the outstanding deliveries before starting more requests.'));
    const requestID = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.journal.set(requestID, { requestID, botID: action.botID, type: action.type, uncertain: false });
      this.persist();
      this.pending.set(requestID, { resolve, reject, late, timer: setTimeout(() => this.uncertain(requestID), ACCEPTANCE_TIMEOUT_MS) });
      try {
        if (!this.post({ ...action, requestID })) this.response(requestID, { ok: false, error: 'Editor disconnected before dispatch; your draft is retained.' });
      } catch {
        // A transport throwing does not establish whether it already forwarded the packet.
        this.uncertain(requestID);
      }
    });
  }
  disconnect(): void { for (const id of [...this.pending.keys()]) this.uncertain(id); }
  private uncertain(requestID: string): void {
    const pending = this.pending.get(requestID); if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(requestID);
    const record = this.journal.get(requestID); if (record) record.uncertain = true;
    this.late.set(requestID, { result: pending.late });
    this.persist(); pending.reject(new DeliveryUncertain(requestID)); this.changed();
  }
  response(requestID: string, result: DeliveryResult): void {
    const pending = this.pending.get(requestID), late = this.late.get(requestID);
    if (!pending && !this.journal.has(requestID)) return;
    if (pending) { clearTimeout(pending.timer); this.pending.delete(requestID); }
    if (late) this.late.delete(requestID);
    this.journal.delete(requestID); this.persist();
    if (pending) result.ok ? pending.resolve() : pending.reject(new Error(result.error || 'Request failed'));
    else if (late?.result) setTimeout(() => late.result?.(result), 0); // Let the rejected promise record its uncertain state first.
    this.changed();
  }
  /** Explicit user acknowledgement only: releases the guard without sending or retrying anything. */
  forget(requestID: string): void {
    if (!this.journal.get(requestID)?.uncertain) return;
    this.late.delete(requestID); this.journal.delete(requestID); this.persist(); this.changed();
  }
  private persist(): void {
    try {
      if (this.journal.size) this.storage?.setItem(JOURNAL_KEY, JSON.stringify([...this.journal.values()]));
      else this.storage?.removeItem(JOURNAL_KEY);
    } catch { /* Session storage may be unavailable or full. */ }
  }
}
