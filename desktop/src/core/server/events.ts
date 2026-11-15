// M7-S66: `CoreEvents` cut out of `Core` (core/server.ts). The core's event fan-out (`event`), the inbound `receive`, the phone bridge and relay, and the machines view. Same bridge convention as `CoreWatch` (core/server/watch.ts, in its header): a block of one-line
// forwarders to `host` first, then the members as they were in `Core`, byte for byte (a member that `Core` or another collaborator calls lost its `private`).
import type { Core } from "../server";
import { mobileCommand } from "../../mobile-bridge/adapter";
import { MobileDesk, OFF as MOBILE_OFF } from "../../mobile-bridge/desk";
import type { RelayConnector } from "../../mobile-relay/connector";
import { ContractError, PROTOCOL_VERSION, errorResponse, okResponse, parseInbound, type Event, type MachinesView } from "../../contract";
import { isDetached } from "../agent-registry";

export class CoreEvents {
  constructor(private readonly host: Core) {}

  // The bridge: everything this class borrows from `Core`.
  private agentBotName(...a: Parameters<Core["agentBotName"]>) { return this.host.agentBotName(...a); }
  private get agents() { return this.host.agents; }
  private bot(...a: Parameters<Core["bot"]>) { return this.host.bot(...a); }
  private get bots() { return this.host.bots; }
  private checkWorkspaceSoon(...a: Parameters<Core["checkWorkspaceSoon"]>) { return this.host.checkWorkspaceSoon(...a); }
  private closeCopiesOf(...a: Parameters<Core["closeCopiesOf"]>) { return this.host.closeCopiesOf(...a); }
  private closeRelayedCopies(...a: Parameters<Core["closeRelayedCopies"]>) { return this.host.closeRelayedCopies(...a); }
  private get copies() { return this.host.copies; }
  private get epoch() { return this.host.epoch; }
  private handle(...a: Parameters<Core["handle"]>) { return this.host.handle(...a); }
  private log(...a: Parameters<Core["log"]>) { return this.host.log(...a); }
  private get maintainerId() { return this.host.maintainerId; }
  private get options() { return this.host.options; }
  private get pending() { return this.host.pending; }
  private pluginEvent(...a: Parameters<Core["pluginEvent"]>) { return this.host.pluginEvent(...a); }
  private get removed() { return this.host.removed; }
  private get reportStarts() { return this.host.reportStarts; }
  private get reportTurns() { return this.host.reportTurns; }
  private serverAskClosed(...a: Parameters<Core["serverAskClosed"]>) { return this.host.serverAskClosed(...a); }
  private get serverAsks() { return this.host.serverAsks; }
  private snapshot(...a: Parameters<Core["snapshot"]>) { return this.host.snapshot(...a); }
  private waitingSoon(...a: Parameters<Core["waitingSoon"]>) { return this.host.waitingSoon(...a); }

  seq = 0;
  /** The next event number: the one transition that moves `seq` (`event` here, and the other collaborators through `Core.nextSeq`; nobody sets it). */
  nextSeq() { return ++this.seq; }
  inflight = new Map<string, AbortController>();

  event(event: Event) {
    // A removed bot (still stopping) is heard no more.
    if (this.removed.size && (("botId" in event && this.removed.has(event.botId)) || (event.type === "bot.updated" && this.removed.has(event.bot.id)))) return;
    if (event.type === "bot.updated" && event.bot.id === this.maintainerId && event.bot.maintainer !== true) {
      event = { ...event, bot: { ...event.bot, maintainer: true } };
    }
    this.options.emit({ v: PROTOCOL_VERSION, epoch: this.epoch, seq: this.nextSeq(), event });
    if (event.type === "message.updated" && this.serverAsks.size) this.serverAskClosed(event.message.id);
    this.pluginEvent(event);
    this.checkWorkspaceSoon();
    // An agent another bot owns: its owner's view of it follows too.
    if (event.type === "subagent.updated") {
      const record = this.agents.byHostBot(event.botId, event.subagent.id);
      if (record && isDetached(record) && !this.removed.has(record.owner.botId) && this.bots.has(record.owner.botId)) {
        this.event({ ...event, botId: record.owner.botId, subagent: { ...event.subagent, owner: this.agentBotName(record.owner.botId).slice(0, 200), host: this.agentBotName(record.host.botId).slice(0, 200) } });
      }
    }
    // A sub bot's row under its project bot follows it (working or not, unread).
    if (event.type === "bot.updated" && event.bot.parent) this.bots.get(event.bot.parent)?.refresh();
    if (this.changeListeners.size) {
      const botId = event.type === "bot.updated" ? event.bot.id : "botId" in event ? event.botId : undefined;
      for (const listener of [...this.changeListeners]) { try { listener(botId === undefined ? {} : { botId }); } catch { /* a listener never stops the core */ } }
    }
    // An owner's turn with an agent's report began: that report is delivered.
    if (event.type === "turn.started") {
      this.reportStarts?.add(event.turnId);
      const report = this.reportTurns.get(event.turnId);
      if (report) { this.reportTurns.delete(event.turnId); this.agents.reportDelivered(report.agentId, report.run); }
    }
    // A question copied into the main bot's chat was settled in its own: so is the copy.
    if (event.type === "message.updated" && (this.copies.size || event.message.ignoredAt)) this.closeCopiesOf(event.botId, event.message.id);
    // A called-in bot's question relayed into the chat that called it was answered in its own: so is the copy there.
    if (event.type === "message.updated") this.closeRelayedCopies(event.botId, event.message.id);
    // A question asked or answered, a bot added: what waits on you may have changed.
    if (event.type === "message.added" || event.type === "message.updated" || event.type === "message.removed" || event.type === "bot.updated") this.waitingSoon();
  }

  private changeListeners = new Set<(change: { botId?: string }) => void>();
  /** The phone bridge's event stream: told that something changed (and in which bot), never what. */
  onChange(listener: (change: { botId?: string }) => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  mobileDesk: MobileDesk | null = null;
  /** Called once by the bridge's start when the phone connection is configured (mobile-bridge/start.ts). */
  attachMobile(desk: MobileDesk) { this.mobileDesk = desk; }
  mobileOr(): MobileDesk { if (!this.mobileDesk) throw new Error("The phone connection is not set up."); return this.mobileDesk; }
  relay: RelayConnector | null = null;
  /** Called once at startup (mobile-relay/start.ts): the end-to-end encrypted relay, off until Settings › Phone gives it an address. */
  attachRelay(relay: RelayConnector) { this.relay = relay; }
  /** Settings › Phone: the bridge's routes and phones, plus the relay and the phones paired through it. */
  mobileView() {
    const view = this.mobileDesk ? this.mobileDesk.view() : MOBILE_OFF;
    if (!this.relay) return view;
    const relayed = this.relay.devices().map(({ id, label, pairedAt, expiresAt, botIds }) => ({ id, label: label ?? "", pairedAt, expiresAt, botIds: [...botIds], via: "relay" as const }));
    return { ...view, devices: [...view.devices.map((device) => ({ ...device, via: "bridge" as const })), ...relayed].sort((a, b) => b.pairedAt - a.pairedAt), relay: this.relay.view() };
  }

  /** Settings › Machines (remote/service.ts); off when this app runs no remote workers (tests, probes). */
  machinesView(): MachinesView {
    return this.options.remoteWorkers?.view() ?? { enabled: false, relay: { url: null, state: "off" }, machines: [] };
  }
  machinesOr() {
    const remote = this.options.remoteWorkers;
    if (!remote) throw new ContractError("conflict", "Workers on other machines are not available here.");
    return remote;
  }

  /** Private mobile transport: the guard and handle's synchronous send prefix share this loop. */
  mobileCommand(raw: unknown, allowedBots: readonly string[]) {
    return mobileCommand({
      pending: botId => this.pending.views(botId),
      snapshot: botId => this.snapshot(botId),
      history: command => this.bot(command.botId).history(command.before, command.bytes, command.until),
      handle: command => this.handle(command, new AbortController().signal),
    }, raw, allowedBots);
  }

  /** Handles one message from main. Exactly one response per request id, cancelled or not. */
  receive(raw: unknown) {
    const parsed = parseInbound(raw);
    if (!parsed.ok) {
      this.log(`refused: ${parsed.error.code} ${parsed.error.message}`);
      if (parsed.id) this.options.emit(errorResponse(parsed.id, parsed.error));
      return;
    }
    const message = parsed.value;
    if ("cancel" in message) {
      this.inflight.get(message.cancel)?.abort();
      return;
    }
    if (this.inflight.has(message.id)) {
      this.options.emit(errorResponse(message.id, { code: "conflict", message: "A request with this id is already running." }));
      return;
    }
    const controller = new AbortController();
    this.inflight.set(message.id, controller);
    const cancelled = new Promise<never>((_, reject) =>
      controller.signal.addEventListener("abort", () => reject(new ContractError("cancelled", "The request was cancelled."))),
    );
    cancelled.catch(() => {});
    Promise.resolve()
      .then(() => Promise.race([this.handle(message.cmd, controller.signal), cancelled]))
      .then((result) => this.options.emit(okResponse(message.id, result)))
      .catch((error) => {
        const wire = error instanceof ContractError ? error.toWire() : { code: "internal" as const, message: String((error as Error)?.message ?? error) };
        if (wire.code === "internal") this.log(`internal error: ${(error as Error)?.stack ?? error}`);
        this.options.emit(errorResponse(message.id, wire));
      })
      .finally(() => this.inflight.delete(message.id));
  }
}
