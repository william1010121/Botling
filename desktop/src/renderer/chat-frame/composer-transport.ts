import { setComposerHost } from '../../../../Web/src/composer-host';
import { fromShell, toShell } from './transport';
import { UploadQueue } from './upload-queue';

const waiting = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
const sending = new Set<string>();
let selected: string | undefined;
let picker = false;
let warning = '';
let status: HTMLElement | null = null;
function request(action: { type: string; [key: string]: unknown }): Promise<void> {
  const requestID = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    waiting.set(requestID, { resolve, reject });
    try {
      if (!toShell({ botling: 'action', action: { ...action, requestID } })) throw new Error('Editor disconnected; your draft is retained.');
    } catch (error) {
      waiting.delete(requestID); reject(error);
    }
  });
}
export function readOriginal(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onabort = () => reject(new Error(`Reading ${file.name} was cancelled`));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      if (comma < 0) reject(new Error(`Could not encode ${file.name}`));
      else resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}
const uploads = new UploadQueue(async (botID, file) => {
  const base64 = await readOriginal(file);
  await request({ type: 'addFileData', botID, name: file.name || `Pasted image.${file.type.split('/')[1] || 'png'}`, base64 });
}, render);
function render(): void {
  const composer = document.querySelector('.composer');
  if (!composer) return;
  if (!status?.isConnected) { status = document.createElement('div'); status.className = 'composer-upload-status'; status.setAttribute('role', 'status'); composer.append(status); }
  status.replaceChildren();
  if (warning || picker) { const line = document.createElement('div'); line.textContent = warning || 'Choosing / adding attachments…'; status.append(line); }
  for (const item of uploads.items.filter(item => item.botID === selected)) {
    const row = document.createElement('div');
    row.textContent = `${item.file.name}: ${item.state === 'failed' ? item.error : item.state === 'queued' ? 'Queued…' : 'Adding…'}`;
    if (item.state === 'failed') {
      const retry = document.createElement('button'); retry.textContent = 'Retry'; retry.onclick = () => uploads.retry(item); row.append(retry);
    }
    if (item.state !== 'uploading') {
      const remove = document.createElement('button'); remove.textContent = 'Remove'; remove.onclick = () => uploads.remove(item); row.append(remove);
    }
    status.append(row);
  }
}
fromShell(message => {
  if (message.botling === 'composerResult') {
    const pending = waiting.get(message.requestID); if (!pending) return;
    waiting.delete(message.requestID);
    if (message.ok) pending.resolve(); else pending.reject(new Error(message.error || 'Request failed'));
  } else if (message.botling === 'state') {
    selected = message.state.botID; queueMicrotask(render);
  }
});
setComposerHost({
  async send(action) {
    if (uploads.blocked(action.botID) || picker) throw new Error('Finish or remove the pending attachments before sending.');
    if (sending.has(action.botID)) throw new Error('Still waiting for acceptance.');
    sending.add(action.botID);
    try { await request(action); } finally { sending.delete(action.botID); }
  },
  upload(file) {
    const botID = document.documentElement.dataset.chat;
    try {
      if (!botID || sending.has(botID)) throw new Error('Wait for message acceptance before adding attachments.');
      warning = ''; uploads.add(botID, file);
    } catch (error) { warning = error instanceof Error ? error.message : String(error); render(); }
  },
});
export function pickAttachments(): void {
  const botID = document.documentElement.dataset.chat;
  if (!botID || picker) return;
  if (sending.has(botID)) { warning = 'Wait for message acceptance before adding attachments.'; render(); return; }
  picker = true; warning = ''; render();
  void request({ type: 'pickFiles', botID }).catch(error => { warning = String(error); }).finally(() => { picker = false; render(); });
}
