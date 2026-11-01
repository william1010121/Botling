#!/usr/bin/env node
// Makes committed fixtures from raw worker-stream recordings (test/record/record-worker-streams.test.ts):
//   node scripts/scrub-worker-streams.mjs <raw folder> <fixtures folder> [--tmp <recording tmp root>] [--only <engine>/<scenario>,…]
// <raw>/<engine>/<scenario>.p<n>.jsonl becomes <fixtures>/<engine>/<scenario>.jsonl (one process) or
// <scenario>-<n>.jsonl (several). What it changes (shared-core spec §5.1):
//   - UUIDs, in order of appearance across a scenario's files: 00000000-0000-4000-8000-00000000000N;
//   - the home folder → /HOME, the scenario's temp folder → /WORK (also in their dashed forms, as in
//     ~/.claude/projects/<-Users-…>), the system temp folder → /TMP, the user name → user, the machine's names → host,
//     e-mail addresses → user@example.com, auth URLs → <auth-url>;
//   - keys that carry credentials or the account (authorization, token, *_token, api_key, email, account, organization,
//     planType, credits) are deleted;
//   - the user's own environment inventories (claude's commands, slash_commands, skills, plugins, mcp_servers, agents,
//     and mcp__ tools) are emptied: they are not part of the protocol and say what is installed on this machine;
//   - stderr lines of Antigravity (they can hold OAuth entry URLs) are dropped.
// A fixture may be at most 200 KB; past that, neighbouring streamed pieces of one block are joined (the text stays
// exactly what was streamed, in fewer chunks) and the scrubber says so. Afterwards every fixture is checked for anything that still looks personal; any hit fails.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, hostname, userInfo } from "node:os";
import { basename, join } from "node:path";

const LIMIT = 200 * 1024;
const args = process.argv.slice(2);
const flag = (name) => { const at = args.indexOf(name); return at >= 0 ? args.splice(at, 2)[1] : null; };
const tmpRoot = flag("--tmp") ?? "/Volumes/My-SSD/botling-work/recordings/tmp";
const only = flag("--only")?.split(",").filter(Boolean) ?? null;
const [raw, out] = args;
if (!raw || !out) {
  console.error("usage: scrub-worker-streams.mjs <raw folder> <fixtures folder> [--tmp <recording tmp root>] [--only engine/scenario,…]");
  process.exit(2);
}

const home = homedir();
const user = userInfo().username;
const scutil = (key) => { try { return execFileSync("scutil", ["--get", key], { encoding: "utf8" }).trim() || null; } catch { return null; } };
/** The machine's names (codex's remoteControl serverName is the host name), longest first. */
const machine = [...new Set([hostname(), scutil("LocalHostName"), scutil("ComputerName")].filter(Boolean))].sort((a, b) => b.length - a.length);
const TEMP = /\/(?:private\/)?var\/folders\/[A-Za-z0-9_+-]+\/[A-Za-z0-9_+-]+\/[TC]\b/g;
const dashed = (path) => path.replace(/[^a-zA-Z0-9]/g, "-");
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const AUTH_URL = /https?:\/\/[^\s"'\\]*(?:oauth|accounts\.google\.com|\/auth\b|\/login)[^\s"'\\]*/gi;
const SECRET_KEY = /^(authorization|token|api_?key|email|account|account_?id|account_?uuid|organization|organization_?id|org_?id|user_?id|cookie|password|secret|plan_?type|subscription_?type|credits|balance)$|_token$|Token$/i;
const INVENTORY = new Set(["commands", "slash_commands", "skills", "plugins", "mcp_servers", "agents"]);

/** Removes credentials and the machine's inventories from a parsed line, in place. */
function clean(value) {
  if (Array.isArray(value)) { value.forEach(clean); return value; }
  if (!value || typeof value !== "object") return value;
  for (const key of Object.keys(value)) {
    if (SECRET_KEY.test(key)) { delete value[key]; continue; }
    if (INVENTORY.has(key) && Array.isArray(value[key])) { value[key] = []; continue; }
    if (key === "tools" && Array.isArray(value[key]) && value[key].every((tool) => typeof tool === "string")) {
      value[key] = value[key].filter((tool) => !tool.startsWith("mcp__"));
      continue;
    }
    clean(value[key]);
  }
  return value;
}

/** Text rules for one scenario (UUID numbering is shared by its files). */
function textScrubber(workDirs) {
  const ids = new Map();
  const paths = [
    ...workDirs.flatMap((dir) => [[dir, "/WORK"], [dashed(dir), "-WORK"]]),
    [tmpRoot, "/WORK-TMP"], [dashed(tmpRoot), "-WORK-TMP"],
    [home, "/HOME"], [dashed(home), "-HOME"],
  ].sort((a, b) => b[0].length - a[0].length);
  return (text) => {
    for (const [from, to] of paths) text = text.replace(new RegExp(escape(from), "g"), to);
    text = text.replace(TEMP, "/TMP").replace(AUTH_URL, "<auth-url>").replace(EMAIL, "user@example.com");
    for (const name of machine) text = text.replace(new RegExp(escape(name), "g"), "host");
    text = text.replace(new RegExp(`\\b${escape(user)}\\b`, "g"), "user");
    return text.replace(UUID, (id) => {
      const key = id.toLowerCase();
      if (!ids.has(key)) ids.set(key, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, "0")}`);
      return ids.get(key);
    });
  };
}

/** The scenario's temp folders as the recording shows them (folder() in the recorder: <tmp>/<engine>-<scenario>-XXXXXX). */
function workDirsOf(texts) {
  const found = new Set();
  const pattern = new RegExp(`${escape(tmpRoot)}/[A-Za-z0-9._-]+?-[A-Za-z0-9]{6}(?=[/"'\\s\\\\.]|$)`, "g");
  for (const text of texts) for (const match of text.matchAll(pattern)) found.add(match[0]);
  return [...found];
}

/**
 * A streamed piece of text or thinking: where its text is, and what it continues (same block / item). Null: not one.
 * claude content_block_delta, Codex item/*Delta, ACP agent_message_chunk / agent_thought_chunk.
 */
function delta(message) {
  if (message?.type === "stream_event" && message.event?.type === "content_block_delta") {
    const piece = message.event.delta ?? {};
    const field = typeof piece.text === "string" ? "text" : typeof piece.thinking === "string" ? "thinking" : null;
    return field ? { key: `claude:${message.event.index}:${piece.type}`, holder: piece, field } : null;
  }
  if (typeof message?.method === "string" && /^item\/.*[dD]elta$/.test(message.method) && typeof message.params?.delta === "string")
    return { key: `codex:${message.method}:${message.params.itemId}:${message.params.summaryIndex ?? message.params.contentIndex ?? ""}`, holder: message.params, field: "delta" };
  const update = message?.params?.update;
  if (/^agent_(message|thought)_chunk$/.test(update?.sessionUpdate ?? "") && typeof update.content?.text === "string")
    return { key: `acp:${update.sessionUpdate}`, holder: update.content, field: "text" };
  return null;
}

/**
 * Under the limit by joining neighbouring pieces of the same block (each pass halves the longest runs): the text still
 * joins up to exactly what was streamed, and stays chunked, only in fewer, longer chunks. No line is dropped otherwise.
 */
function thin(lines) {
  const size = () => lines.reduce((sum, line) => sum + line.length + 1, 0);
  let joined = 0;
  for (let pass = 0; pass < 8 && size() > LIMIT; pass++) {
    const next = [lines[0]];
    let open = null; // the previous line, when it is a delta that this pass may still extend
    for (const line of lines.slice(1)) {
      const record = JSON.parse(line);
      let message; try { message = JSON.parse(record.l); } catch { message = null; }
      const piece = message ? delta(message) : null;
      if (piece && open && open.piece.key === piece.key && open.record.d === record.d) {
        open.piece.holder[open.piece.field] += piece.holder[piece.field];
        next[next.length - 1] = JSON.stringify({ ...open.record, l: JSON.stringify(open.message) });
        open = null; // pairs only: each pass halves a run
        joined++;
        continue;
      }
      next.push(line);
      open = piece ? { record, message, piece } : null;
    }
    lines = next;
  }
  return { lines, joined };
}

/**
 * Joins the neighbouring streamed pieces that a sensitive string runs across (a model's reply naming the work folder,
 * cut between two ACP chunks), so the text rules see it whole. Raw record lines in, raw record lines out.
 */
function joinStraddles(lines, needles) {
  const entries = lines.map((line) => {
    const record = JSON.parse(line);
    let message = null; try { message = JSON.parse(record.l); } catch { /* not JSON */ }
    return { record, message, piece: message ? delta(message) : null };
  });
  const out = [];
  for (let i = 0; i < entries.length;) {
    const first = entries[i];
    let j = i + 1;
    while (first.piece && j < entries.length && entries[j].piece?.key === first.piece.key && entries[j].record.d === first.record.d) j++;
    const run = entries.slice(i, j);
    i = j;
    if (run.length === 1) { out.push(first); continue; }
    const texts = run.map(({ piece }) => piece.holder[piece.field]);
    const starts = texts.map((_, k) => texts.slice(0, k).join("").length);
    const pieceAt = (offset) => starts.findLastIndex((start) => start <= offset);
    const whole = texts.join("");
    const joins = new Set();
    for (const needle of needles) {
      for (let at = whole.indexOf(needle); at >= 0; at = whole.indexOf(needle, at + 1)) {
        for (let k = pieceAt(at) + 1; k <= pieceAt(at + needle.length - 1); k++) joins.add(k);
      }
    }
    run.forEach((entry, k) => {
      if (!joins.has(k)) { out.push(entry); return; }
      const last = out[out.length - 1];
      last.piece.holder[last.piece.field] += entry.piece.holder[entry.piece.field];
      last.record = { ...last.record, l: JSON.stringify(last.message) };
    });
  }
  return out.map(({ record }) => JSON.stringify(record));
}

const CHECKS = [
  [new RegExp(escape(home)), "home folder"], [new RegExp(`\\b${escape(user)}\\b`, "i"), "user name"], [/\/Users\/[^/"\s]+/, "a /Users path"],
  // The one /Volumes path allowed is an example in the app's own tool schema (src/core/agent/codex-tools.json).
  [/\/Volumes\/(?!My-SSD\/botling-work\/<name>)/, "a /Volumes path"], [/\/var\/folders/, "a temp path"], [EMAIL, "an e-mail address"],
  ...machine.map((name) => [new RegExp(escape(name), "i"), "the machine's name"]), [/\bwilliam\b/i, "the git user name"],
  [/Bearer\s+[A-Za-z0-9._-]{10,}/, "a bearer token"], [/\bsk-[A-Za-z0-9_-]{16,}/, "an API key"], [/\beyJ[A-Za-z0-9_-]{20,}\./, "a JWT"],
  [/ya29\.[A-Za-z0-9_-]{10,}/, "a Google token"], [/"(?:refresh|access|id)_?token"/i, "a token key"],
];

const problems = [];
let written = 0;
for (const engine of readdirSync(raw).filter((name) => statSync(join(raw, name)).isDirectory())) {
  const files = readdirSync(join(raw, engine)).filter((name) => /\.p\d+\.jsonl$/.test(name));
  const scenarios = [...new Set(files.map((name) => name.replace(/\.p\d+\.jsonl$/, "")))];
  for (const scenario of scenarios) {
    if (only && !only.includes(`${engine}/${scenario}`)) continue;
    const parts = files.filter((name) => name.startsWith(`${scenario}.p`)).sort((a, b) => Number(/\.p(\d+)\./.exec(a)[1]) - Number(/\.p(\d+)\./.exec(b)[1]));
    const texts = parts.map((name) => readFileSync(join(raw, engine, name), "utf8"));
    const dirs = workDirsOf(texts);
    const scrub = textScrubber(dirs);
    mkdirSync(join(out, engine), { recursive: true });
    parts.forEach((name, index) => {
      const target = join(out, engine, parts.length === 1 ? `${scenario}.jsonl` : `${scenario}-${index + 1}.jsonl`);
      const [head, ...body] = texts[index].split("\n").filter(Boolean);
      let lines = [head, ...joinStraddles(body, [...dirs, tmpRoot, home, user, ...machine])].flatMap((line, i) => {
        const record = JSON.parse(line);
        if (i === 0) { // header
          const { engine: e, cli, recordedAt, scenario: s, process: p, command, args: argv } = record;
          return [scrub(JSON.stringify({ engine: e, cli, recordedAt, scenario: s, process: p, command, args: argv }))];
        }
        if (record.d === "err" && engine === "agy") return [];
        let l = record.l;
        try { l = JSON.stringify(clean(JSON.parse(l))); } catch { /* not JSON: text rules only */ }
        return [JSON.stringify({ t: record.t, d: record.d, l: scrub(l) })];
      });
      const before = lines.reduce((sum, line) => sum + line.length + 1, 0);
      if (before > LIMIT) {
        const thinned = thin(lines);
        lines = thinned.lines;
        console.log(`${basename(target)}: ${Math.round(before / 1024)} KB, joined ${thinned.joined} neighbouring delta lines`);
      }
      const text = lines.join("\n") + "\n";
      if (text.length > LIMIT) problems.push(`${target}: still ${Math.round(text.length / 1024)} KB`);
      for (const [pattern, what] of CHECKS) {
        const hit = pattern.exec(text);
        if (hit) problems.push(`${target}: ${what}: …${text.slice(Math.max(0, hit.index - 40), hit.index + 60)}…`);
      }
      writeFileSync(target, text);
      written++;
      console.log(`${engine}/${basename(target)}: ${lines.length - 1} lines, ${Math.round(text.length / 1024)} KB`);
    });
  }
}
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.join("\n")}`);
  process.exit(1);
}
console.log(`${written} fixture(s) written, all checks passed.`);
