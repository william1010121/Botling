// Source-only release gates. No environment, settings, tool argument or login can change them.
// Agy-only app-managed workers are enabled (2.0.2); every worker file/command action and
// checkpoint still needs exact per-action user approval. The mixed Codex/agy gate stays closed.
// Offline tests replace this module; they must also replace every process/engine transport.
export function agyWorkerRuntimeEnabled(): boolean { return true; }
export function agyMixedRuntimeEnabled(): boolean { return false; }
export function agyPairAllowed(from: string, to: string): boolean {
  return agyMixedRuntimeEnabled() && ((from === 'agy' && to === 'codex') || (from === 'codex' && to === 'agy'));
}
