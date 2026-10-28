// Read-only, bounded historical metadata. No CLI/session discovery, archive walk or prompt parsing.
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TokenFlowHistoryView } from "../contract";
import type { Bot } from "./bot";
import { exclusiveOutputTokens, readSubagent, SubagentBook, type SubagentRecord } from "./subagents";
import { taskAgentIds } from "./task-agents";
import { shownTasks } from "./tasks";

const LIMIT_BYTES = 8 * 1024 * 1024;
const cache = new Map<string, { stamp: string; rows: SubagentRecord[]; unreadable?: boolean }>();
async function savedRows(file: string): Promise<{ rows: SubagentRecord[]; unreadable: boolean }> {
  let stamp = "";
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > LIMIT_BYTES) return { rows: [], unreadable: true };
    stamp = `${info.mtimeMs}:${info.size}`;
    if (cache.get(file)?.stamp === stamp) return { rows: cache.get(file)!.rows, unreadable: cache.get(file)!.unreadable ?? false };
    const handle = await open(file, "r");
    let value: unknown;
    try {
      const buffer = Buffer.alloc(info.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > LIMIT_BYTES) return { rows: [], unreadable: true };
      value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } finally { await handle.close(); }
    if (!Array.isArray(value)) throw new Error("Invalid saved worker list");
    const rows = value.slice(-500).flatMap(raw => {
      if (!raw || typeof raw !== "object") return [];
      // Retain only metadata/counters, never prompt, result, steps or session credentials.
      const row = readSubagent({ id: raw.id, description: raw.description, parentID: raw.parentID,
        startedAt: raw.startedAt, endedAt: raw.endedAt, status: raw.status,
        outputTokenCounters: raw.outputTokenCounters, prompt: "", steps: [] });
      return row ? [row] : [];
    });
    if (cache.size >= 4) cache.delete(cache.keys().next().value!);
    cache.set(file, { stamp, rows });
    return { rows, unreadable: false };
  } catch (error) {
    const unreadable = (error as NodeJS.ErrnoException).code !== "ENOENT";
    if (stamp && unreadable) {
      if (cache.size >= 4) cache.delete(cache.keys().next().value!);
      cache.set(file, { stamp, rows: [], unreadable: true });
    }
    return { rows: [], unreadable };
  }
}

export async function tokenFlowHistory(bot: Bot): Promise<TokenFlowHistoryView> {
  const sources = [{ engine: bot.engine, list: bot.subagents.list.slice(-500) }];
  let unreadable = false;
  // Include saved inactive heads without constructing a Bot or launching an engine.
  for (const engine of ["claude", "codex"] as const) {
    if (bot.partner?.engine === engine) sources.push({ engine, list: bot.partner.subagents.list.slice(-500) });
    else {
      const saved = await savedRows(join(bot.profile.storeDir, `partner-${engine}`, "subagents.json"));
      unreadable ||= saved.unreadable;
      if (saved.rows.length) sources.push({ engine, list: saved.rows });
    }
  }
  // Same head/id from an old store and the live book is one worker. Live wins.
  const unique = new Map<string, { engine: "claude" | "codex"; record: SubagentRecord }>();
  for (const source of sources) for (const record of source.list) {
    const key = JSON.stringify([source.engine, record.id]);
    if (!unique.has(key)) unique.set(key, { engine: source.engine, record });
  }
  const retained = [...unique.values()].sort((a, b) => a.record.startedAt - b.record.startedAt).slice(-500);
  const exclusive = exclusiveOutputTokens(retained.map(item => item.record));
  const rows = retained.map(({ engine, record }) => new SubagentBook([record]).delegationRows(engine, exclusive)[0]);
  const tasks = bot.tasks.tasks.filter(card => shownTasks([card]).length || card.history?.some(event => event.kind === "subagent" && !!event.text)).slice(-300).map(card => {
    const recorded = (card.history ?? []).filter(event => event.kind === "subagent" && /^[A-Za-z0-9_.:-]{1,200}$/.test(event.text ?? "")).map(event => event.text!);
    const ids = new Set(taskAgentIds({ ...card, subagentIDs: [...(card.subagentIDs ?? []), ...recorded] }, [], sources));
    const workers = rows.filter(row => ids.has(row.id)).map(row => ({ id: row.id, head: row.head }));
    // Preserve explicit missing records as unreported rather than silently implying zero work.
    for (const id of ids) if (!workers.some(worker => worker.id === id)) workers.push({ id: id.slice(0, 200), head: null });
    return { id: card.id.slice(0, 200), name: card.name.slice(0, 400) || "Task", workers: workers.slice(0, 500) };
  });
  return { botId: bot.id, asOf: Date.now(), limited: true, unreadable, rows, tasks };
}
