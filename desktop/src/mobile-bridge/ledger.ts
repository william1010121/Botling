import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ResponseEnvelope, errorResponse, type RequestEnvelope } from '../contract';
import { withFileLock, writeFileAtomic } from '../core/durable/atomic';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as any)[k])).join(',') + '}';
  return JSON.stringify(value);
}
/** Durable at-most-once dispatch, not an exactly-once transaction with core storage.
 * A pending record after a crash MUST NOT dispatch again. Never prune automatically. */
export class MutationLedger {
  constructor(private directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = statSync(directory);
    if (!stat.isDirectory() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()))
      throw new Error('Mobile mutation journal must be owner-only.');
  }
  async run(clientId: string, request: RequestEnvelope, dispatch: () => Promise<ResponseEnvelope>): Promise<ResponseEnvelope> {
    const file = join(this.directory, hash(JSON.stringify([clientId, request.id])) + '.json');
    const fingerprint = hash(canonical(request.cmd));
    const prior = withFileLock(file, () => {
      if (existsSync(file)) {
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        if (saved.fingerprint !== fingerprint) return errorResponse(request.id, { code: 'conflict', message: 'Request ID already used for another command.' });
        if (saved.response) {
          const response = ResponseEnvelope.parse(saved.response);
          if (response.id !== request.id) throw new Error('Stored response ID mismatch');
          return response;
        }
        return errorResponse(request.id, { code: 'conflict', message: 'Delivery is pending or uncertain. Check chat; do not resend.' });
      }
      writeFileAtomic(file, JSON.stringify({ fingerprint }));
      return null;
    });
    if (prior) return prior;
    // Do not overwrite pending with a guessed failure if dispatch throws or persistence fails.
    const response = ResponseEnvelope.parse(await dispatch());
    if (response.id !== request.id) throw new Error('Response ID mismatch');
    withFileLock(file, () => writeFileAtomic(file, JSON.stringify({ fingerprint, response })));
    return response;
  }
}
