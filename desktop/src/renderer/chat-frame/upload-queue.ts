// The wire permits 40,000,000 base64 characters. Keep originals unchanged and encode one at a time.
export const MAX_UPLOAD_BYTES = 30_000_000;
export interface UploadItem { botID: string; file: File; state: 'queued' | 'uploading' | 'failed'; error?: string }
export class UploadQueue {
  readonly items: UploadItem[] = [];
  private running = false;
  constructor(private upload: (botID: string, file: File) => Promise<void>, private changed: () => void) {}
  blocked(botID: string): boolean { return this.items.some(item => item.botID === botID); }
  add(botID: string, file: File): void {
    if (!file.size || file.size > MAX_UPLOAD_BYTES) throw new Error('Choose a nonempty file up to 30 MB. Larger files can use the + picker.');
    if (this.items.length >= 50 || this.items.reduce((sum, item) => sum + item.file.size, file.size) > 2 * MAX_UPLOAD_BYTES) throw new Error('Wait for the queued attachments before adding more.');
    this.items.push({ botID, file, state: 'queued' }); this.changed(); this.schedule();
  }
  retry(item: UploadItem): void { if (item.state !== 'failed' || !this.items.includes(item)) return; item.state = 'queued'; delete item.error; this.changed(); this.schedule(); }
  remove(item: UploadItem): void { if (item.state === 'uploading') return; const index = this.items.indexOf(item); if (index >= 0) this.items.splice(index, 1); this.changed(); }
  private schedule(): void {
    if (this.running) return;
    this.running = true;
    // Let the queued indicator paint before reading/encoding the first file.
    setTimeout(() => { void this.drain(); }, 0);
  }
  private async drain(): Promise<void> {
    let item: UploadItem | undefined;
    while ((item = this.items.find(entry => entry.state === 'queued'))) {
      item.state = 'uploading'; this.changed();
      try { await this.upload(item.botID, item.file); this.items.splice(this.items.indexOf(item), 1); }
      catch (error) { item.state = 'failed'; item.error = error instanceof Error ? error.message : String(error); }
      this.changed();
    }
    this.running = false;
  }
}
