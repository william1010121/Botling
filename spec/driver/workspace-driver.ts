// The one door spec/tests/workspace.spec.test.ts uses into the app's workspace change watch.
// Plugins are named as in the model (spec/models/workspace); the lines between the plugin host and
// the core wait in the driver until a HostRecv / CoreRecv delivers the next one.
import type { WorkspaceView } from "../reference/workspace";

export interface WorkspaceDriver {
  readonly plugins: string[];
  /** The workspace changes (what every workspace method answers). */
  change(): Promise<void>;
  /** Plugin `p` listens with `workspace.onChange`, then reads at once. */
  listen(p: string): Promise<void>;
  /** Plugin `p` disposes its listener. */
  unlisten(p: string): Promise<void>;
  /** Plugin `p`, told of a change, reads again. */
  read(p: string): Promise<void>;
  /** The host takes the core's next line. */
  hostRecv(): Promise<void>;
  /** The core takes the host's next line. */
  coreRecv(): Promise<void>;
  /** The core looks for a change. */
  check(): Promise<void>;
  view(): WorkspaceView;
  close(): Promise<void>;
}
