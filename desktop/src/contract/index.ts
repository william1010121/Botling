// The versioned contract between the renderer, the Electron main process and the core process.
//
// Three kinds of envelope travel on every hop (renderer ⇄ main ⇄ core):
//   request  {v, id, cmd}               — a command, answered by exactly one response with that id
//   cancel   {v, cancel: id}            — the sender no longer wants that request's result
//   response {v, id, ok, result|error}  — the answer
//   event    {v, epoch, seq, event}     — something that happened; seq is gapless per epoch
//
// `epoch` changes whenever the core process starts, so a renderer that sees a new epoch or a gap in
// `seq` takes a fresh `chat.snapshot` instead of guessing. Every hop validates what it receives
// with the schemas below: the renderer is not trusted by main, and main does not let anything but
// these shapes reach the core.
//
// This file only re-exports: the shared views are in ./views and ./views-settings, the commands in ./commands, the events,
// envelopes, results and errors in ./results (M7-S02a, M7-S02b, M7-S02c).
export { DoctorCheck, DoctorView } from "./doctor";
export { CARD_SAVE_LIMIT, FILE_DATA_LIMIT } from "./editor-card";
export * from "./views";
export { AntigravityQuotaBucket, AntigravityQuotaView, BotSettingsView, BotView, ChatDecoration, HandoffView, HeadsView, HeldBotColor, ImportView, MachineView, MobileClusterView, MobileDeskView, MobilePairView, MobileRelayView, MobileRouteView, MobileV3Offer, MobileV3View, ReleaseView, RoutineView, RunningView, SettingsChange, SettingsView, UpdateView, UsageView } from "./views-settings";
export type { RunView } from "./views-settings";
export { CLAUDE_MODEL_ALIASES, CLAUDE_MODEL_HINT, claudeModelOrNull, isClaudeModel } from "./claude-model";
export * from "./commands";
export * from "./results";
