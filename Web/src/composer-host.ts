/** Optional acknowledged desktop transport; the native 1.x bridge stays unchanged. */
export interface ComposerHost {
  send(action: { type: 'send'; botID: string; text: string; to?: string }): Promise<void>;
  upload?(file: File): void;
}
export let composerHost: ComposerHost | null = null;
export function setComposerHost(host: ComposerHost | null): void { composerHost = host; }
