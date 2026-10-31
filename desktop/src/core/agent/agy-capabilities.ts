// Source-only release gate. No environment, settings, tool argument or login can change it.
// Agy-only app-managed workers are enabled (2.0.2); every worker file/command action and
// checkpoint still needs exact per-action user approval.
// Offline tests replace this module; they must also replace every process/engine transport.
export function agyWorkerRuntimeEnabled(): boolean { return true; }
