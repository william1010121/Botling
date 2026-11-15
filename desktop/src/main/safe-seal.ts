// Plugins' secret sealing in Electron main (2.x and v3). Shared so the Linux backend guard (F5) stays unit-testable
// without Electron running.

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): string;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export const NO_SAFE_STORAGE_ERROR = "This computer offers no safe storage for secrets.";

/** Seals or opens a plugin secret with Electron safeStorage; refuses Linux weak/unknown backends (F5). */
export function sealWithSafeStorage(
  storage: SafeStorageLike,
  op: "seal" | "open",
  text: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!storage.isEncryptionAvailable()) throw new Error(NO_SAFE_STORAGE_ERROR);
  if (platform === "linux") {
    const backend = storage.getSelectedStorageBackend();
    if (backend === "basic_text" || backend === "unknown") throw new Error(NO_SAFE_STORAGE_ERROR);
  }
  return op === "seal" ? storage.encryptString(text).toString("base64") : storage.decryptString(Buffer.from(text, "base64"));
}
