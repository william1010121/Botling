/** Optional acknowledged desktop transport; the native 1.x bridge stays unchanged. */
export interface DeliveryResult { ok: boolean; error?: string }
/** A lost acknowledgement is not evidence that the core rejected the operation. */
export class DeliveryUncertain extends Error {
  constructor(readonly requestID: string) {
    super('Delivery unconfirmed. It may already have been accepted. Sending again can duplicate it. Check the chat and attachments first.');
  }
}
export interface ComposerHost {
  send(action: { type: 'send'; botID: string; text: string; to?: string }, lateResult?: (result: DeliveryResult) => void): Promise<void>;
  upload?(file: File): void;
  uncertainSend?(botID: string): string | undefined;
  releaseUncertain?(requestID: string): void;
}
export let composerHost: ComposerHost | null = null;
export function setComposerHost(host: ComposerHost | null): void { composerHost = host; }
