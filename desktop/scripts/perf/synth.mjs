// Synthetic but realistic data for the performance benchmark, in the shapes the core really reads:
// chat.json (an array of ChatRecord, dates in Swift seconds), projects.json (the bots), and a bot's
// subagents.json index plus subagents/<id>.jsonl step files (src/core/store/subagent-store.ts).
// Everything is deterministic (a seeded generator), so two runs measure the same bytes.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MAIN = "6A0B0000-0000-4000-8000-000000000002";

export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = "the a build test file read write function error line chat bot result token patch commit branch merge check run output path import export class const return value config".split(" ");
export function words(random, count) {
  let text = "";
  while (text.length < count) text += WORDS[Math.floor(random() * WORDS.length)] + (random() < 0.12 ? ".\n" : " ");
  return text.slice(0, count);
}

export function uuid(n, prefix = "00000000") {
  return `${prefix}-0000-4000-8000-${n.toString(16).toUpperCase().padStart(12, "0")}`;
}

/** Swift date: seconds since 2001-01-01. */
const swift = (ms) => (ms - Date.UTC(2001, 0, 1)) / 1000;

/**
 * `count` chat lines, alternating user and bot. `steps` tool steps of `outputBytes` each hang on every
 * bot line (what a real coding turn leaves behind), and every `bigEvery`th bot line has a `bigText` reply.
 */
export function chatRecords({ count, steps = 0, outputBytes = 0, bigEvery = 0, bigText = 0, seed = 1, start = Date.UTC(2026, 0, 1), idBase = 1 }) {
  const random = rng(seed);
  const records = [];
  for (let i = 0; i < count; i++) {
    const user = i % 2 === 0;
    const id = uuid(idBase * 1_000_000 + i, "A0000000");
    const big = !user && bigEvery && Math.floor(i / 2) % bigEvery === 0;
    const record = { id, role: user ? "user" : "bot", text: words(random, user ? 60 + Math.floor(random() * 200) : big ? bigText : 200 + Math.floor(random() * 900)), date: swift(start + i * 60_000) };
    if (!user) {
      record.state = "done";
      record.engine = "claude";
      if (steps) {
        record.steps = Array.from({ length: steps }, (_, s) => ({
          id: `toolu_${i}_${s}`, kind: "tool", tool: s % 3 ? "Bash" : "Read", title: `${s % 3 ? "Bash" : "Read"} step ${s}`,
          detail: words(random, 120), output: words(random, outputBytes), failed: false, done: true, at: start + i * 60_000 + s,
        }));
      }
      if (i % 40 === 1) record.reactions = [{ emoji: "👍", actor: "user" }];
    } else if (i > 2 && i % 50 === 0) {
      record.replyTo = uuid(idBase * 1_000_000 + i - 1, "A0000000");
      record.replyPreview = "an earlier answer";
    }
    records.push(record);
  }
  return records;
}

/** A bot folder's subagents: an index of `count` finished entries, each with a steps file of `steps` steps. */
export function writeSubagents(folder, { count, steps, outputBytes, seed = 7 }) {
  const random = rng(seed);
  mkdirSync(join(folder, "subagents"), { recursive: true });
  const index = [];
  for (let n = 0; n < count; n++) {
    const id = `toolu_sub_${n}`;
    index.push({ id, description: `Subagent ${n}`, type: "general-purpose", prompt: words(random, 1500), status: "completed", background: false,
      startedAt: Date.now() - (count - n) * 600_000, endedAt: Date.now() - (count - n) * 600_000 + 90_000, result: words(random, 3000), stepCount: steps, toolCount: steps, runs: 0 });
    const lines = [];
    for (let s = 0; s < steps; s++) lines.push(JSON.stringify({ k: "step", step: { id: `${id}_${s}`, kind: "tool", tool: "Bash", title: `step ${s}`, detail: words(random, 100), output: words(random, outputBytes), failed: false, done: true } }));
    writeFileSync(join(folder, "subagents", `${id}.jsonl`), lines.join("\n") + "\n");
  }
  writeFileSync(join(folder, "subagents.json"), JSON.stringify({ format: "botling-subagents-v2", subagents: index }));
}

/** Writes a data folder: the main bot's chat, `bots` more bots, and their subagents. Returns the folder's byte count. */
export function writeData(root, { main, bots = 0, bot = { count: 100 }, subagents = null }) {
  mkdirSync(join(root, "main"), { recursive: true });
  writeFileSync(join(root, "main", "chat.json"), JSON.stringify(chatRecords({ ...main, seed: 1, idBase: 1 })));
  if (subagents) writeSubagents(join(root, "main"), subagents);
  const projects = [];
  for (let b = 0; b < bots; b++) {
    const id = uuid(b + 1, "B0000000");
    const folder = join(root, "work", `bot-${b}`);
    mkdirSync(folder, { recursive: true });
    projects.push({ id, name: `Bot ${b}`, folder, avatar: "circle" });
    const store = join(root, "projects", id);
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "chat.json"), JSON.stringify(chatRecords({ ...bot, seed: 100 + b, idBase: 10 + b })));
    if (subagents) writeSubagents(store, subagents);
  }
  if (projects.length) writeFileSync(join(root, "projects.json"), JSON.stringify(projects));
}
