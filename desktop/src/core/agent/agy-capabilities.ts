// Source-only release gate. No environment, settings, tool argument or login can enable it.
// Offline tests replace this module; they must also replace every process/engine transport.
export function agyWorkerRuntimeEnabled(): boolean { return false; }
export function agyMixedRuntimeEnabled(): boolean { return false; }
export function agyPairAllowed(from: string, to: string): boolean {
  return agyMixedRuntimeEnabled() && ((from === 'agy' && to === 'codex') || (from === 'codex' && to === 'agy'));
}
