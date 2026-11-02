// The one door spec/tests/folders.spec.test.ts uses into the core's side of `sessions.folder`: the built-in
// plugin's lines to the core wait in the driver until a CoreRecv delivers the next one. Places are named as in
// the model (spec/models/folders): a worktree's name, or "P" for the bot's project folder.
import type { FoldersView, Place } from "../reference/folders";

export interface FoldersDriver {
  /** The plugin assigns the bot `f` and pushes `sessions.folder`. */
  use(f: Place): Promise<void>;
  /** The plugin loads and pushes its whole picture (`sessions.folders`). */
  load(): Promise<void>;
  /** The host dies with the plugin: the first `keep` lines still arrive, the rest are lost. */
  crash(keep: number): Promise<void>;
  /** The host starts again; the plugin is loading. */
  hostRestart(): Promise<void>;
  /** The user turns the plugin off, or on. */
  disable(): Promise<void>;
  enable(): Promise<void>;
  /** The core takes the next line (`dup`: it comes again); `saved`: the write of plugin-session-folders.json works. */
  coreRecv(dup: boolean, saved: boolean): Promise<void>;
  /** Botling starts again over the same data folder. */
  appRestart(): Promise<void>;
  view(): FoldersView;
  close(): Promise<void>;
}
