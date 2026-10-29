import { setComposerHost, DeliveryUncertain } from '../../../../Web/src/composer-host';
import { fromShell, toShell, onTransportDisconnect } from './transport';
import { UploadQueue } from './upload-queue';
import { ComposerRequests, ACCEPTANCE_TIMEOUT_MS } from './composer-requests';
import { pageDraftStore } from './draft-keep';

let fileRequestID = 0;
const fileRequests = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
function projectRequest(botID: string, type: string, value: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const requestID = ++fileRequestID;
    const timer = setTimeout(() => { fileRequests.delete(requestID); reject(new Error('File request timed out')); }, 10000);
    fileRequests.set(requestID, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    toShell({botling: 'action', action: {type, botID, requestID, value}});
  });
}
fromShell(message => {
  if(message.botling !== 'projectFilesResult') return;
  const pending = fileRequests.get(message.requestID); fileRequests.delete(message.requestID);
  if(message.error) pending?.reject(new Error(message.error)); else pending?.resolve(message.value);
});
const sending = new Set<string>();
let selected: string | undefined;
let picker = false;
let warning = '';
let status: HTMLElement | null = null;
const requests = new ComposerRequests(action => toShell({ botling: 'action', action }), () => queueMicrotask(render), pageDraftStore());
onTransportDisconnect(() => requests.disconnect());
export function readOriginal(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const timer = setTimeout(() => { reject(new Error(`Reading ${file.name} timed out; no upload was dispatched.`)); reader.abort(); }, ACCEPTANCE_TIMEOUT_MS);
    reader.onloadend = () => clearTimeout(timer);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onabort = () => reject(new Error(`Reading ${file.name} was cancelled`));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      if (comma < 0) reject(new Error(`Could not encode ${file.name}`));
      else resolve(result.slice(comma + 1));
    };
    try { reader.readAsDataURL(file); } catch (error) { clearTimeout(timer); reject(error); }
  });
}
const uploads = new UploadQueue(async (botID, file) => {
  const base64 = await readOriginal(file);
  let uncertainID: string | undefined;
  try {
    await requests.request({ type: 'addFileData', botID, name: file.name || `Pasted image.${file.type.split('/')[1] || 'png'}`, base64 }, result => { if (uncertainID) uploads.settle(uncertainID, result); });
  } catch (error) {
    if (error instanceof DeliveryUncertain) uncertainID = error.requestID;
    throw error;
  }
}, render);
function render(): void {
  const composer = document.querySelector('.composer');
  if (!composer) return;
  if (!status?.isConnected) { status = document.createElement('div'); status.className = 'composer-upload-status'; status.setAttribute('role', 'status'); composer.append(status); }
  status.replaceChildren();
  if (warning || picker) { const line = document.createElement('div'); line.textContent = warning || 'Choosing / adding attachments…'; status.append(line); }
  for (const item of uploads.items.filter(item => item.botID === selected)) {
    const row = document.createElement('div');
    row.textContent = `${item.file.name}: ${item.state === 'failed' || item.state === 'uncertain' ? item.error : item.state === 'queued' ? 'Queued…' : 'Adding…'}`;
    if (item.state === 'failed') {
      const retry = document.createElement('button'); retry.textContent = 'Retry'; retry.onclick = () => uploads.retry(item); row.append(retry);
    }
    if (item.state !== 'uploading' && item.state !== 'uncertain') {
      const remove = document.createElement('button'); remove.textContent = 'Remove'; remove.onclick = () => uploads.remove(item); row.append(remove);
    }
    status.append(row);
  }
  for (const delivery of (selected ? requests.unknown(selected) : []).filter(item => item.type !== 'send')) {
    const row = document.createElement('div');
    row.textContent = 'Attachment delivery unconfirmed. It may already be attached. Check the attachment list before adding it again. ';
    const checked = document.createElement('button'); checked.textContent = 'I checked attachments — discard queued copy';
    checked.onclick = () => {
      const item = uploads.items.find(item => item.requestID === delivery.requestID);
      if (item) uploads.remove(item);
      requests.forget(delivery.requestID);
    };
    row.append(checked); status.append(row);
  }
}
fromShell(message => {
  if (message.botling === 'composerResult') {
    requests.response(message.requestID, { ok: message.ok, ...(message.error ? { error: message.error } : {}) });
  } else if (message.botling === 'state') {
    selected = message.state.botID; queueMicrotask(render);
  }
});
setComposerHost({
  searchFiles: (botID, query) => projectRequest(botID, "searchProjectFiles", query),
  previewFile: (botID, path) => projectRequest(botID, "previewProjectFile", path),
  uncertainSend(botID) { return requests.unknown(botID).find(item => item.type === 'send')?.requestID; },
  releaseUncertain(requestID) { requests.forget(requestID); },
  async send(action, lateResult) {
    const unknown = requests.unknown(action.botID).find(item => item.type === 'send');
    if (unknown) throw new DeliveryUncertain(unknown.requestID);
    if (requests.unknown(action.botID).length) throw new Error('Check the unconfirmed attachments before sending.');
    if (uploads.blocked(action.botID) || picker) throw new Error('Finish or remove the pending attachments before sending.');
    if (sending.has(action.botID)) throw new Error('Still waiting for acceptance.');
    sending.add(action.botID);
    try { await requests.request(action, lateResult); } finally { sending.delete(action.botID); }
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
  if (requests.unknown(botID).some(item => item.type === 'pickFiles')) { render(); return; }
  if (sending.has(botID)) { warning = 'Wait for message acceptance before adding attachments.'; render(); return; }
  picker = true; warning = ''; render();
  void requests.request({ type: 'pickFiles', botID }).catch(error => { if (!(error instanceof DeliveryUncertain)) warning = String(error); }).finally(() => { picker = false; render(); });
}
