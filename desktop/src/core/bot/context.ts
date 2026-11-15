// BotContext (M7-S41): what every part of a bot shares and nobody owns. Who the bot is (`id`, `profile`, `paths`), where
// its words go (`log`, `emit`), which bot's chat it speaks in (`owner`, `chat`, `heads`, `peers`, `botFor` ...), what
// routes between its heads are allowed (`allowsEngineRoute`, `requireEngineRoute`), and the read-only deps it was made
// with (`options`, `store`, `engine`, `subagents`). It has no field of its own: it reads the `Bot` it belongs to.
//
// THE BRIDGE CONVENTION (every collaborator class cut out of `Bot` follows it; the cards M7-S42 ... M7-S53 copy it):
//   1. A moved method body is byte for byte what it was in `Bot`: it still says `this.options`, `this.log(...)`,
//      `this.owner`. Nothing in a body is rewritten to make it compile.
//   2. So the class begins with a BRIDGE BLOCK: one line per borrowed name, no logic, one forwarder each, e.g.
//      `get options(): BotOptions { return this.host.options; }`, `log(line: string) { this.host.log(line); }`.
//      The block is the collaborator's whole interface to the rest of `Bot`, readable on one screen.
//      A name the collaborator owns itself is not in the block; a name another collaborator owns is forwarded to it.
//   3. A forwarder that SETS another owner's field (`set turn(v) { this.host.turn = v; }`) is allowed only until the
//      refinement cards (M7-S54 ...) replace it by a named transition on the owner; `check-lines.mjs` counts them.
//   4. `Bot` keeps a one-line delegate for every name it moved (`private get chat() { return this.ctx.chat; }`), so
//      importers, spec adapters and the private names of `bot-private-names.test.ts` stay as they were. A delegate is
//      a method or accessor, never an arrow stored in a field: `emit` is passed around as a value and a delegate keeps
//      `this` bound the way the old method did.
//   5. Where a body names `this` as the Bot itself (not a field of it), it cannot move unchanged; it stays in `Bot`
//      (`owner`, `members`) or says `this.host` there (`emit`, `primary.fromPartner(this.host, event)`).
//   6. The fields the bridge reads are no longer `private` on `Bot` (TypeScript only: a class in another file cannot
//      see a private one); they are marked "read by BotContext" there and become the owners' until phase 2.
import { ContractError, type Event } from "../../contract";
import { AGY_EXECUTION_BLOCKED } from "../agent/agy";
import { verifyAcpRuntime } from "../agent/agy-acp";
import type { Bot } from "../bot";
import { displayName, hasTwo, otherHead, type Engine, type Heads } from "../heads";
import { profilePaths } from "../prompts";
import type { SubagentBook } from "../subagents";
import type { BotStore } from "../store/bot-store";
import type { ChatRecord } from "../store/records";
import type { BotOptions } from "./types";

export class BotContext {
  constructor(private readonly host: Bot) {}

  // ---- Bridge: the names borrowed from `Bot` (one line each) ----
  get options(): BotOptions { return this.host.options; }
  get store(): BotStore { return this.host.store; }
  get engine(): Engine { return this.host.engine; }
  get subagents(): SubagentBook { return this.host.subagents; }
  get owner(): Bot { return this.host.owner; }
  get members(): Bot[] { return this.host.members; }
  private get partners() { return this.host.partners; }
  private get session() { return this.host.session; }
  private get turn() { return this.host.turn; }
  private get deferred() { return this.host.deferred; }
  private get queue() { return this.host.queue; }
  private get claimHold() { return this.host.claimHold; }

  // ---- Moved from `Bot` ----
  get partner(): Bot | null { return this.partners.values().next().value ?? null; }
  get peers(): Bot[] { return [...this.partners.values()]; }
  ownsTurn(id: string): boolean { return this.turn?.id === id || this.deferred?.id === id || this.queue.some(t => t.id === id) || this.claimHold?.turn.id === id; }

  /** It shares its chat with another head. */
  get sharesChat(): boolean {
    return !!this.options.primary || this.peers.length > 0 || hasTwo(this.heads);
  }

  /** The chat it speaks in: its own, or for a partner the primary's. */
  get chat(): ChatRecord[] {
    return this.owner.records;
  }

  get heads(): Heads {
    return this.owner.headsSettings;
  }

  peerEngine(head: Engine): Engine {
    const owner = this.owner;
    return owner.engine !== head ? owner.engine : owner.partner?.engine ?? otherHead(head, this.heads);
  }

  get singleActionApprovals(): boolean { return this.engine === "agy"; }

  /** Execution policy, including on-demand and restored routes (not just selected heads). */
  allowsEngineRoute(head: Engine, from: Engine = this.engine): boolean {
    return head === from || this.owner.headsSettings.engines.includes(head) || (head !== "agy" && from !== "agy" && !this.owner.headsSettings.engines.includes("agy"));
  }

  requireEngineRoute(head: Engine, from: Engine = this.engine): void {
    if (!this.allowsEngineRoute(head, from)) throw new ContractError("conflict", "This collaboration route is not enabled. Nothing was routed.");
    // Peer sessions use the existing provider lifecycle, never the dormant ACP worker bridge.
    // Verify app-owned provider availability before constructing any peer or submitting work.
    if (head === "codex" && !this.options.codexConfig) throw new ContractError("conflict", "Codex is not available here.");
    if (head === "agy" && head !== from) {
      const config = this.options.agyConfig?.(this.profile, {command:"agy",cwd:this.profile.folder,sessionId:this.session.sessionId,resume:false});
      if (config?.transport !== "acp") throw new ContractError("conflict", AGY_EXECUTION_BLOCKED);
      verifyAcpRuntime(config.command);
    }
  }

  /** The bot that runs `head`: this one, or its partner. */
  botFor(head: Engine): Bot | null {
    const owner = this.owner;
    if (owner.engine === head || owner.switchTo === head) return owner;
    if (owner.partners.has(head)) return owner.partners.get(head)!;
    return null;
  }

  get id() {
    return this.options.profile.id;
  }
  get profile() {
    return this.options.profile;
  }
  get paths() {
    return profilePaths(this.profile);
  }

  log(line: string) {
    this.options.log(`[${this.profile.name}${this.sharesChat ? ` · ${displayName(this.engine)}` : ""}] ${line}`);
  }

  emit(event: Event) {
    const primary = this.options.primary;
    if (primary) primary.fromPartner(this.host, event);
    else this.options.emit(event);
  }
}
