// The only door spec/tests/rules.spec.test.ts uses into the app's orchestration rules book: one method per step of
// spec/models/rules/OrchestrationRules.tla that the app or the plugin takes, and an observation in spec/reference/rules.ts's
// `View` vocabulary.
import type { Src, View } from "../reference/rules";

export interface RulesDriverOptions {
  /** A folder of the test's own for the chosen plugin's rules.json. */
  dataDir: string;
  /** The plugin's state at the start. */
  start: Src;
  /** Lets `ms` of the app's timers pass (the test owns time). */
  wait(ms: number): Promise<void>;
}

export interface RulesDriver {
  /** `sendWith`: the rules plugin is asked (`refresh`, with a notice to the chat or not), then the turn takes `current()`. */
  send(say: boolean): Promise<void>;
  /** The plugin's answer (the bytes it read when asked, or its throw) reaches the book. */
  answer(): Promise<void>;
  /** The time limit runs out. */
  timeout(): Promise<void>;
  /** The plugin changes: rules.json edited or put back, the plugin turned off, or it stops answering. */
  brk(src: Src): Promise<void>;
  view(): View;
  close(): Promise<void>;
}
