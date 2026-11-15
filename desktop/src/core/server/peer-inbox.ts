// M7-S62: `CorePeerInbox` cut out of `Core` (core/server.ts). The briefing the main bot wakes with, the other machines' bots as peers, and the inbox files delivered to them. Same bridge convention as `CoreWatch` (core/server/watch.ts, in its header): a
// block of one-line forwarders to `host` first, then the members as they were in `Core`, byte for byte.
import { PEER_ID, PEER_MESSAGE_BYTES, oneLine, type Core } from "../server";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { botName, firstLine, projectBriefingText, type BriefingRow, type PeerBriefingRow } from "../projects";
import { MESSAGE_TEXT_LIMIT } from "../../contract";
import { Layout, type BotProfile } from "../store/workspace";
import { type RemoteMember } from "../conversations";
import { readdirSync } from "node:fs";
import { maintainerProfile } from "../maintainer";

export class CorePeerInbox {
  constructor(private readonly host: Core) {}

  // The bridge: everything this class borrows from `Core`.
  private get bots() { return this.host.bots; }
  private log(...a: Parameters<Core["log"]>) { return this.host.log(...a); }
  private mainBot(...a: Parameters<Core["mainBot"]>) { return this.host.mainBot(...a); }
  private get maintainerId() { return this.host.maintainerId; }
  private get options() { return this.host.options; }
  private get profiles() { return this.host.profiles; }
  private tellMain(...a: Parameters<Core["tellMain"]>) { return this.host.tellMain(...a); }

  /**
   * The project list the main bot wakes with and its routines get (`Workspace.projectBriefing`): each
   * project's and bot's memory and inbox file and a question waiting in its own chat, Maintainer's, the
   * <open-question> note when one asks.
   */
  projectBriefing(): string {
    const row = (profile: BotProfile, about: string): BriefingRow => ({
      name: profile.name, about, memory: join(profile.folder, profile.memoryPath), inbox: join(profile.folder, ".bot", "inbox.md"),
      question: this.bots.get(profile.id)?.openQuestion()?.text ?? null,
    });
    const maintainer = this.profiles.find((profile) => profile.id === this.maintainerId) ?? maintainerProfile(this.options.dataDir, "", this.maintainerId);
    const peers: PeerBriefingRow[] = this.peerBots().map((peer) => {
      const inbox = this.peerInbox(peer.id);
      mkdirSync(dirname(inbox), { recursive: true });
      return { name: peer.name, machine: peer.serverName, about: "", inbox, chat: this.peerChatCopy(peer.id) };
    });
    return projectBriefingText({
      peers,
      projects: this.profiles.filter((profile) => profile.role === "manager" && profile.id !== this.maintainerId).map((profile) => row(profile, `folder ${profile.folder}`)),
      bots: this.profiles.filter((profile) => profile.role === "bot" && !profile.parent).map((profile) => row(profile, firstLine(profile.job ?? ""))),
      maintainer: row(maintainer, "plugin-library extensions and in-chat components only"),
    });
  }

  /**
   * Bots on other machines the main bot can hand work to (M5-04c): `remoteMembers` (bots and managers of valid peers),
   * leaving out a peer's old 2.x main bot, which the importer turned into an ordinary bot named "Main (old)" (D26).
   */
  peerBots(): RemoteMember[] {
    if (!this.options.remoteCommand || !this.options.remoteMembers) return [];
    // Names and ids come from a peer's rows (schema-checked only): one clean line each, and an id that is one path part.
    return this.options.remoteMembers()
      .map((peer) => ({ ...peer, name: botName(peer.name), serverName: botName(peer.serverName) || peer.server }))
      .filter((peer) => peer.name && peer.name !== "Main (old)" && PEER_ID.test(peer.id));
  }

  /** The file the main bot appends to for a peer's bot; it lives next to the main bot's, never on the peer's machine. */
  private peerInbox(botId: string): string {
    const main = this.profiles.find((profile) => profile.role === "main");
    return join(main?.folder ?? Layout.mainBot(this.options.dataDir), ".bot", "peers", botId, "inbox.md");
  }

  /** M5-04e: the read-only copy of a peer bot's last lines; botlingd's `PeerChatMirror` writes it, never the core. */
  private peerChatCopy(botId: string): string {
    return join(dirname(this.peerInbox(botId)), "chat.md");
  }

  /** An awake main bot hears about bots made or removed with its next message (`briefAwakeMainBot`). */
  briefAwakeMainBot() {
    this.mainBot()?.queueNote("(App: The list of projects and bots changed.)\n" + this.projectBriefing());
  }

  /** Hands what the main bot wrote into an inbox.md to that bot, emptying the file (`deliverInboxes`). */
  deliverInboxes() {
    if (!this.mainBot()) return;
    for (const profile of this.profiles) {
      // A sub bot shares its project bot's folder, so that folder's inbox is the project bot's alone.
      if (profile.role === "main" || profile.parent || profile.problem) continue;
      const file = join(profile.folder, ".bot", "inbox.md");
      let text: string;
      try { text = readFileSync(file, "utf8"); } catch { continue; }
      if (!text.trim()) continue;
      const bot = this.bots.get(profile.id);
      if (!bot) continue;
      // Handed over first, then emptied: a bot that cannot take it now (read-only, closing) keeps it for later.
      try { bot.relay(text); } catch (error) { this.log(`inbox of ${profile.name} kept: ${(error as Error).message}`); continue; }
      try { writeFileSync(file, ""); } catch (error) { this.log(`inbox of ${profile.name} not emptied: ${(error as Error).message}`); }
    }
    this.deliverPeerInboxes();
  }

  /** Peer bots whose inbox is in flight (committed not settled yet): never sent twice (M5-04c). */
  private peerSending = new Set<string>();

  /** Peers whose over-limit inbox the main bot was told about (M5-04d, U3). */
  private peerOverTold = new Set<string>();

  /** Gone peers whose kept inbox was already logged: once is enough. */
  private peerGoneLogged = new Set<string>();

  /**
   * M5-04c: what the main bot appended to a peer bot's inbox goes out as `chat.send` with this server as origin. The
   * file is emptied only after the slot is committed (a crash or a refusal before that keeps the text, so it is sent
   * again); text added meanwhile stays. No inbox.md is ever written on the peer's machine.
   */
  private deliverPeerInboxes() {
    const remoteCommand = this.options.remoteCommand;
    if (!remoteCommand) return;
    const peers = this.peerBots();
    const listed = new Set(peers.map((peer) => peer.id));
    for (const peer of peers) {
      if (this.peerSending.has(peer.id)) continue;
      const file = this.peerInbox(peer.id);
      let text: string;
      try { text = readFileSync(file, "utf8"); } catch { continue; }
      if (!text.trim()) continue;
      const who = `${peer.name} on ${peer.serverName}`;
      const machine = typeof this.options.machineName === "function" ? this.options.machineName() : this.options.machineName;
      const wrapped = `From the main bot on ${machine || "this machine"}:\n${text}`;
      const tooLong = wrapped.length > MESSAGE_TEXT_LIMIT ? `the text is longer than ${MESSAGE_TEXT_LIMIT} characters`
        : Buffer.byteLength(JSON.stringify(wrapped), "utf8") > PEER_MESSAGE_BYTES ? `the text is bigger than ${PEER_MESSAGE_BYTES} bytes on the wire` : null;
      if (tooLong) {
        this.log(`inbox of ${who} kept: ${tooLong}`);
        // U3: the file is kept and logged on every turn, but the main bot is told once (again after it fits and went).
        if (!this.peerOverTold.has(peer.id)) {
          this.peerOverTold.add(peer.id);
          this.tellMain((p) => `The message for "${p(peer.name)}" on ${p(peer.serverName)} is too long to send, so it was not sent. Cut it down in its inbox file.`);
        }
        continue;
      }
      this.peerOverTold.delete(peer.id);
      let sent: ReturnType<typeof remoteCommand>;
      try { sent = remoteCommand(`bot:${peer.id}`, { type: "chat.send", botId: peer.id, text: wrapped }); } catch (error) { this.log(`inbox of ${who} kept: ${(error as Error).message}`); continue; }
      this.peerSending.add(peer.id);
      sent.committed.then(() => {
        this.peerSending.delete(peer.id);
        // Only what was sent goes; a line appended while it was on its way stays for the next turn.
        let now: string;
        try { now = readFileSync(file, "utf8"); } catch { return; }
        try { writeFileSync(file, now.startsWith(text) ? now.slice(text.length) : now); } catch (error) { this.log(`inbox of ${who} not emptied: ${(error as Error).message}`); }
      }, (error: unknown) => {
        this.peerSending.delete(peer.id);
        this.log(`inbox of ${who} kept: ${(error as Error).message}`);
      });
      // The slot committed but the owner refused it (the bot is gone, the server was removed): told to the main bot, once per slot.
      sent.outcome.then((outcome) => {
        if (outcome.ok) return;
        const why = oneLine(outcome.why);
        this.log(`message to ${who} was not delivered: ${why}`);
        this.tellMain((p) => `The message to "${p(peer.name)}" on ${p(peer.serverName)} was not delivered: ${p(why)}.`);
      }, () => undefined);
    }
    // A bot that left (its server was removed): its text stays in the file, and the log says so once.
    const root = join(dirname(this.peerInbox("x")), "..");
    let folders: string[] = [];
    try { folders = readdirSync(root); } catch { /* no peers yet */ }
    for (const id of folders) {
      if (listed.has(id) || this.peerGoneLogged.has(id)) continue;
      let text = "";
      try { text = readFileSync(join(root, id, "inbox.md"), "utf8"); } catch { continue; }
      if (!text.trim()) continue;
      this.peerGoneLogged.add(id);
      this.log(`inbox of ${id} kept: that bot is no longer on a machine of this cluster`);
    }
  }
}
