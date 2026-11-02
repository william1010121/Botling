// The only door spec/tests/approval.spec.test.ts uses into the app's approval of a plugin frame's ask: one
// method per thing a frame or the user does in spec/models/approval/Approval.tla, and an observation in
// spec/reference/approval.ts's `View` vocabulary. The app's own steps (the core's answer, the sheet opening)
// happen inside `ask`, as they do in the app: the model's Ask, CoreAsk and Open in one call.
import type { Cmd, Folder, Slot, View } from "../reference/approval";

export interface ApprovalWorld {
  slots: Slot[];
  cmds: Cmd[];
  /** Lets `ms` of the app's timers pass (the test owns time; 0 lets what is due now run). */
  wait(ms: number): Promise<void>;
}

export interface ApprovalSession {
  /** The frame asks (`ccb.requestApproval`) with a command and a folder (the bot's own, or another), and waits until the app has done what it does. */
  ask(slot: Slot, cmd: Cmd, folder: Folder): Promise<void>;
  /** A click that was already on its way lands on the sheet's Allow before it is live. */
  strayClick(): Promise<void>;
  /** The arming moment passes. */
  arm(): Promise<void>;
  /** The user presses Allow, and the app finishes what that sends. */
  allow(): Promise<void>;
  /** The user presses Cancel. */
  cancel(): Promise<void>;
  observe(): View;
  close(): Promise<void>;
}

export interface ApprovalDriver {
  open(world: ApprovalWorld): Promise<ApprovalSession>;
}
