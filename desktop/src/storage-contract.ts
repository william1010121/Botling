// Explicit rollback compatibility, independent of transport/schema protocol versions.
// A hot update may write the live profile before a later page failure restarts old code.
// Unknown metadata is therefore NOT evidence that either direction is safe.
export interface StorageContract { version: 1; epoch: number }
export const STORAGE_CONTRACT_FILE = 'storage-contract.json';
export function parseStorageContract(value: unknown): StorageContract | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'epoch,version' || record.version !== 1 ||
      !Number.isSafeInteger(record.epoch) || (record.epoch as number) < 1) return null;
  return { version: 1, epoch: record.epoch as number };
}
export function storageCompatible(a: unknown, b: unknown): boolean {
  const left = parseStorageContract(a), right = parseStorageContract(b);
  return !!left && !!right && left.epoch === right.epoch;
}
export const STORAGE_RESTART_REASON = 'storage compatibility is unknown or changed; use the restart installer';
