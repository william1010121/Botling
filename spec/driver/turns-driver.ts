// The one door spec/tests/turns.spec.test.ts uses into a bot's turn schedule (spec/models/turns): the real Bot over a
// claude head that is a stand-in, whose stdin lines wait in the driver until the model says what claude does with
// them. Lines are named as in the model: a user's ("u1"), the app's ("a1"), the resume note ("resume").
import type { TurnsView } from "../reference/turns";

export interface TurnsDriver {
  /** A line comes in: yours (chat.send), or the app's (a routine, a report; `conducted`: handed-over work). */
  arrive(line: string, from: { user: boolean; conducted: boolean }): Promise<void>;
  /** Esc: the turn under way stops; or the line waiting, or the turn set aside, is taken back. */
  stop(): Promise<void>;
  stopQueued(line: string): Promise<void>;
  stopDeferred(): Promise<void>;
  /** claude begins the next line on its stdin as a turn of its own ("started"). */
  begin(): Promise<void>;
  /** claude reads the next line into the turn under way ("started" or not, then "completed"). */
  read(said: boolean): Promise<void>;
  /** The turn under way shows its first words. */
  show(): Promise<void>;
  /** claude's turn ends: its result, then the "completed" of the line it began with. */
  end(): Promise<void>;
  /** Its own work starts (workers whose news is still to come). */
  startWork(): Promise<void>;
  /** The working folder moves (a plugin's `sessions.folder`). */
  move(): Promise<void>;
  /** The core is to be swapped; or the swap is called off. */
  swap(on: boolean): Promise<void>;
  /** The 15 s look at a held line. */
  releaseHold(): Promise<void>;
  view(): TurnsView;
  close(): Promise<void>;
}
