// agents.json: the agent registry on disk (core/agent-registry.ts). App-wide, because an agent's owner and host can be
// different bots. Written atomically; progress is debounced 250 ms, while move intents, state changes and owner changes
// are written at once. A file that cannot be read is moved aside (agents.json.broken-<time>) and the registry starts
// again from the host books: that is the same as deleting it, which is always safe (every owner becomes the host).
//
// The first start with the registry (no agents.json) adopts every host book's index (`migrationRecords`): the native
// files are only read, never written.
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../durable/atomic";
import { readJSON } from "./bot-store";
import { INDEX_FORMAT } from "./subagent-store";
import { readHeads, type Engine } from "../heads";
import { readSubagent } from "../subagents";
import { fromSwiftDate } from "./records";
import { safeToken } from "../sub-bots";
import { AGENTS_FORMAT, agentEngine, agentId, hostKind, recordHostKind, stateFor, type AgentRecord, type AgentsFile, type HostFacts } from "../agent-registry";
import type { BotProfile } from "./workspace";

const DEBOUNCE_MS = 250;

export class AgentStore {
  readonly file: string;
  private timer: NodeJS.Timeout | null = null;
  private latest: (() => AgentsFile) | null = null;

  constructor(dataDir: string, private readonly log: (line: string) => void = () => {}) {
    this.file = join(dataDir, "agents.json");
  }

  /** The file, or null when there is none yet (the first start with the registry). */
  load(): AgentsFile | null {
    if (!existsSync(this.file)) return null;
    try {
      const value = readJSON(this.file) as Partial<AgentsFile> | undefined;
      if (!value || value.format !== AGENTS_FORMAT || !Array.isArray(value.agents)) throw new Error("not an agents file");
      return {
        format: AGENTS_FORMAT,
        agents: value.agents.filter(validRecord),
        moves: Array.isArray(value.moves) ? value.moves.filter((move) => !!move && typeof move.id === "string" && typeof move.agentId === "string" && typeof move.phase === "string") : [],
      };
    } catch (error) {
      const aside = `${this.file}.broken-${Date.now()}`;
      try { renameSync(this.file, aside); } catch { /* it is rebuilt either way */ }
      this.log(`agents.json could not be read (${(error as Error).message}); moved to ${aside} and rebuilt from the bots' subagent lists`);
      return null;
    }
  }

  save(file: AgentsFile): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.latest = null;
    writeFileAtomic(this.file, JSON.stringify(file));
  }

  saveSoon(file: () => AgentsFile): void {
    this.latest = file;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const take = this.latest;
      this.latest = null;
      if (!take) return;
      try { writeFileAtomic(this.file, JSON.stringify(take())); } catch (error) { this.log(`agents.json save failed: ${(error as Error).message}`); }
    }, DEBOUNCE_MS);
    this.timer.unref?.();
  }

  flush(): void {
    const take = this.latest;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.latest = null;
    if (take) writeFileAtomic(this.file, JSON.stringify(take()));
  }
}

function validRecord(value: unknown): value is AgentRecord {
  const record = value as Partial<AgentRecord> | null;
  return !!record && typeof record === "object" && record.v === 1 && typeof record.id === "string" && typeof record.nativeId === "string"
    && !!record.owner && typeof record.owner.botId === "string" && !!record.host && typeof record.host.botId === "string"
    && typeof record.host.engine === "string" && !!record.summary && typeof record.state === "string" && !!record.ownerView;
}

/** One host book's folder: the bot's own (its primary head) or partner-<engine>/. */
export interface HostBook { profile: BotProfile; engine: Engine; directory: string }

/** Every host book of these bots: the primary's (its engine from bot.json, as `Bot` reads it) and each partner-<engine>/ that exists. */
export function hostBooks(profiles: readonly BotProfile[]): HostBook[] {
  const books: HostBook[] = [];
  for (const profile of profiles) {
    let settings: Record<string, unknown> = {};
    try { const value = readJSON(join(profile.storeDir, "bot.json")); if (value && typeof value === "object" && !Array.isArray(value)) settings = value as Record<string, unknown>; } catch { /* defaults */ }
    const heads = readHeads(settings.heads, settings.engine);
    const saved = settings.engine === "agy" || settings.engine === "codex" || settings.engine === "claude" ? settings.engine : null;
    const primary: Engine = saved && heads.engines.includes(saved) ? saved : heads.engines[0]!;
    books.push({ profile, engine: primary, directory: profile.storeDir });
    for (const engine of ["claude", "codex", "agy"] as const) {
      if (engine === primary) continue;
      const directory = join(profile.storeDir, `partner-${engine}`);
      if (existsSync(join(directory, "subagents.json"))) books.push({ profile, engine, directory });
    }
  }
  return books;
}

/**
 * The first start's records (A1.2): one per entry of each host book's subagents.json index (the index only, never the
 * steps; an old-format file is left for the bot to split and is picked up by `reconcile`). Owner = host. A record that
 * was running is interrupted (its process went with the app). A sub bot's `handoff` marks the record it continued.
 */
export function migrationRecords(profiles: readonly BotProfile[], now = Date.now()): AgentRecord[] {
  const records: AgentRecord[] = [];
  for (const book of hostBooks(profiles)) {
    let index: unknown;
    try { index = readJSON(join(book.directory, "subagents.json")); } catch { continue; }
    const value = index as { format?: unknown; subagents?: unknown } | undefined;
    if (!value || value.format !== INDEX_FORMAT || !Array.isArray(value.subagents)) continue;
    let head: { sessionId?: unknown } | undefined;
    try { head = readJSON(join(book.directory, "head.json")) as typeof head; } catch { /* none */ }
    const book_host: HostFacts = { botId: book.profile.id, engine: book.engine, sessionId: typeof head?.sessionId === "string" ? head.sessionId : null, folder: book.profile.folder, kind: hostKind(book.engine) };
    for (const raw of value.subagents) {
      const rec = readSubagent(raw);
      if (!rec || rec.parentID) continue;
      const execution = rec.execution;
      // A Claude worker runs in a process of its own whatever head lists it (never a sidechain).
      const host: HostFacts = { ...book_host, kind: recordHostKind(book_host, rec) };
      const handle: AgentRecord["handle"] = host.kind === "claude-process"
        ? { kind: "claude-session", sessionId: execution?.threadId ?? "", configDir: null }
        : host.kind === "codex-thread"
        ? { kind: "codex-thread", threadId: execution?.threadId ?? null, coordinatorSessionId: execution?.ownerSessionId ?? host.sessionId ?? "", run: execution?.run ?? 1 }
        : host.kind === "agy-acp"
          ? { kind: "agy-session", sessionId: execution?.threadId ?? null, acpHome: "", run: execution?.run ?? 1 }
          : { kind: "claude-sidechain", parentSessionId: execution?.ownerSessionId ?? host.sessionId ?? "", toolUseId: rec.id, agentId: typeof rec.agentID === "string" ? rec.agentID : null, configDir: null, checkpoint: null };
      const effort = (rec as { runtime?: { reasoningEffort?: unknown } }).runtime?.reasoningEffort;
      const state = rec.status === "running" ? "interrupted" : stateFor(rec, host.kind);
      const successor = profiles.find((profile) => profile.parent === book.profile.id && profile.handoff && profile.handoff === safeToken(rec.id));
      records.push({
        v: 1, id: agentId(host.botId, host.engine, rec.id), nativeId: rec.id, engine: agentEngine(rec, host.engine), background: rec.background,
        owner: { botId: host.botId, engine: host.engine, since: now, history: [] },
        host: { ...host },
        handle,
        promptHash: null,
        model: typeof rec.model === "string" ? rec.model : null, effort: typeof effort === "string" ? effort : null,
        state,
        summary: {
          description: rec.description.slice(0, 400), prompt: rec.prompt.slice(0, 4_000), lastReport: typeof rec.result === "string" && rec.result ? rec.result.slice(0, 4_000) : null,
          stepCount: typeof rec.stepCount === "number" ? rec.stepCount : 0, toolCount: typeof rec.toolCount === "number" ? rec.toolCount : 0, lastStepAt: null,
          statusFile: null, handoffFile: null,
        },
        relay: { muted: false, pendingMessages: [], report: null },
        ownerView: { settledAt: null, unsettledAt: null },
        ...(successor ? { succeededBy: { kind: "subBot" as const, botId: successor.id } } : {}),
        createdAt: now, updatedAt: now, endedAt: typeof rec.endedAt === "number" ? fromSwiftDate(rec.endedAt) : now,
        rev: 1,
      });
    }
  }
  return records;
}
