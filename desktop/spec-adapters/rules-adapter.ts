// spec/driver/rules-driver.ts against the real code: `OrchestrationRulesBook` (core/orchestration/plugin-rules.ts) asking the
// real `chosenSource` (the plugin the user chose, its rules.json read from disk and checked against the sha256 the user wrote)
// and called as `CoreSend.sendWith` calls it (`refresh`, then the turn takes `current()`). The only thing held here is when
// the plugin's answer reaches the book: it is read when the book asks (as the plugin reads it), and let through on `answer`.
// A plugin that hangs never answers. The time limit is the book's own RULES_TIME_LIMIT_MS on the test's fake timers.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RulesDriver, RulesDriverOptions } from "../../spec/driver/rules-driver";
import type { Rules, Src } from "../../spec/reference/rules";
import { DEFAULT_ORCHESTRATION_RULES, type OrchestrationRules } from "../src/core/orchestration/default-rules";
import { chosenSource, OrchestrationRulesBook, RULES_NOTICE, RULES_TIME_LIMIT_MS, type Slots } from "../src/core/orchestration/plugin-rules";

const GOOD = "Look things up one at a time (the chosen plugin's pinned text).";
const EDITED = "Look things up however you like (a bot's edit after the user pinned the file).";
const bytes = (text: string) => Buffer.from(JSON.stringify({ format: 1, slots: { "worker.lookup": text } }));

/** Lets the book's promise chains and file reads run to their end (real I/O; only setTimeout is fake). */
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve)); };

export async function createRulesDriver({ dataDir, start, wait }: RulesDriverOptions): Promise<RulesDriver> {
  const folder = join(dataDir, "plugins", "my-rules");
  mkdirSync(folder, { recursive: true });
  const pinned = createHash("sha256").update(bytes(GOOD)).digest("hex");
  let src: Src = start;
  let said = 0;
  let used: "none" | Rules = "none";
  const put = (s: Src) => {
    src = s;
    writeFileSync(join(folder, "rules.json"), bytes(s === "edited" ? EDITED : GOOD));
  };
  put(start);
  /** The answer of the ask under way, held until `answer`. */
  let release: (() => void) | null = null;
  const real = () => chosenSource({ folder, enabled: src !== "throws" }, pinned)();
  const book = new OrchestrationRulesBook(() => {
    if (src === "hangs") return new Promise<Slots>(() => {});
    const read = real();
    read.catch(() => {});
    return new Promise<void>((resolve) => { release = resolve; }).then(() => read);
  });
  const rulesOf = (rules: OrchestrationRules): Rules => {
    if (rules === DEFAULT_ORCHESTRATION_RULES) return "core";
    const text = rules.workerRules().lookup.text;
    return text === GOOD ? "plugin" : text === EDITED ? "edited" : (() => { throw new Error(`unknown rules text: ${text}`); })();
  };
  const say = (text: string) => { if (text !== RULES_NOTICE) throw new Error(`unexpected notice: ${text}`); said += 1; };
  const settle = async () => { await flush(); };
  return {
    async send(withSay) {
      void book.refresh(withSay ? say : undefined);
      used = rulesOf(book.current());
      await settle();
    },
    async answer() {
      const go = release;
      if (!go) throw new Error("no answer is held");
      release = null;
      go();
      await settle();
      // An answer taken starts a new failure period: the notices the model counts are since the last answer.
      if (book.current() !== DEFAULT_ORCHESTRATION_RULES) said = 0;
    },
    async timeout() {
      release = null;
      await wait(RULES_TIME_LIMIT_MS);
      await settle();
    },
    async brk(s) { put(s); await settle(); },
    view() {
      const flight = (book as unknown as { flight: Promise<void> | null }).flight;
      return { rules: rulesOf(book.current()), asking: flight !== null, said, used };
    },
    async close() { release = null; },
  };
}
