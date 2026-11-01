#!/usr/bin/env node
// A stand-in for `claude`, for tests and `npm run dev:fake`. Two ways to run, as claude has:
//
// Per turn (Phase 0): `-p --output-format stream-json …`, the prompt on stdin, one reply, exit.
// Long-lived (a bot's head): `-p --input-format stream-json …`: user messages arrive as JSON lines
//   on stdin, one turn each; control requests (interrupt) and responses (permission answers) too.
//   It stays until stdin closes. Its `system init` line comes with the first message, like claude's.
//
// What a turn does: FAKE_CLAUDE_MODE, or a directive at the start of the message (long-lived only):
//   normal   — streams "You said: <prompt>" a word at a time, then a result line (default)
//   slow     — streams words until interrupted or killed (an interrupt ends the turn)
//   stubborn — like slow, but ignores SIGTERM and interrupts, and so does a helper it starts
//   card     — replies with a ccb-card block
//   crash    — streams a little, then exits 3 without a result line
//   netloss  — (long-lived) claude's API retries, then its connection error that ends the turn (no HTTP answer)
//   tool     — (long-lived) asks to run a Bash command and reports whether it was allowed:
//              "/tool <command>" asks for <command> (default "echo hi"); "/tool:WebFetch …" asks for another tool
//   resume   — replies with how it was started: "session <id> resumed=<bool>"
//   choices  — asks with a <choices> block;  task — replies with a <task …/> line
//   react    — "/react <message id>": a reaction-only reply (👍 on that line)
//   agent    — (long-lived) sends a subagent (Agent tool) that reads a file and reports back, then says so
//   bgagent  — (long-lived) sends one to the background; it reports a moment later, and claude starts
//              a turn of its own to say so ("/bgagent:silent": that turn says only <no-reply/>)
//   worker   — (long-lived) "/worker <instructions>": calls the app's app_handoff tool (its in-process MCP server, an
//              mcp_message control request) and replies "Handed off: <task_id>" (or "Handoff failed: <error>")
//   failtool — "/failtool <words>": a Bash call that fails, then "Recovered after a failed tool: <words>" (a worker's run that succeeds anyway)
//   say      — "/say <text>": replies exactly <text> (a hand-off tag, say)
//   mention  — "/mention <name> <words>[|…]": "Let me ask." and a line "@<name> <words>" each (a bot's @)
//   solo     — "/solo <words>": with two heads, the head that hears the other's words first says only
//              <no-reply/>; the one that reads it first takes it ("I take it: <words>")
//   linger   — "/linger <words>": says "Thinking it over." first, takes FAKE_CLAUDE_LINGER_MS (default 600),
//              then "You said: <words>", with " (heard mid-turn: N)" when the other head's words came meanwhile
// The other head's words ("(App: …, working on this too, says:" / "…, replied in this chat:") that arrive
// while a turn runs are read into that turn, as claude reads messages queued mid-turn; they are logged
// with `midTurn: true` (FAKE_CLAUDE_NO_ABSORB=1: never; each waits for a turn of its own, answered
// <no-reply/> after FAKE_CLAUDE_NOTE_MS). The user's words that arrive while a slow turn ("slow", "/slow …"
// handed over) runs are read into it as well: it stops streaming and answers "You said: <words>" in that
// turn. While any other turn runs they wait for a turn of their own. FAKE_CLAUDE_INTERRUPTS: a file it appends
// a line to for each interrupt it is sent. A message sent with a `uuid` gets `command_lifecycle` lines: "queued" when read,
// "started" when it gets a turn of its own.
// Work the other head hands over ("(App: Codex, this bot's other head, hands you this …") is answered
// "Did it: <task>" ("/say …" as the task: exactly that; "/handoff:claude <task>": it hands <task> on); a hand-back ("… finished what you handed
// over. Its reply: …") "Done: <its reply>".
// "/slow …" as the handed task: it streams until interrupted (work to pause for the user's message);
// the app's "(App: Now carry on with what you were doing…" is answered "Carried on: finished the handed work."
// Work the app hands over ("(From the main bot) …", Maintainer's jobs) is answered "On it.".
// App notes ("(App: …" paragraphs: the wake briefing, recent lines, reactions) are not the user's
// words: the reply echoes the rest, and the directive is read from the last paragraph. The tidy
// note ("(App: You have been idle …") is answered "OK" after writing the memory file it names.
// FAKE_CLAUDE_REPORT_REPLY: what it answers a Claude app worker's report (<app_task_result …>) with, exactly.
// FAKE_CLAUDE_INPUT: a file it appends {session, text} to for every message it reads.
// FAKE_CLAUDE_PIDS: a file this process appends "<pid>\n" to, for itself and each helper it starts.
// FAKE_CLAUDE_CONTROLS: a file it appends {session, request} to for every set_model request.
// FAKE_CLAUDE_LOG: a file it appends one JSON line to per start: {pid, args, resume, session, cwd}.
// FAKE_CLAUDE_FORGET=1: `--resume` fails like claude's for a session it does not have (exit 1, stderr only).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { safeWritePath } from "./safe-write.mjs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const flag = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const longLived = flag("--input-format") === "stream-json";
const resumed = flag("--resume");
const session = resumed ?? flag("--session-id") ?? "fake";
const envMode = process.env.FAKE_CLAUDE_MODE || "normal";
const pidsFile = process.env.FAKE_CLAUDE_PIDS;
const note = (pid) => { if (pidsFile) appendFileSync(pidsFile, `${pid}\n`); };
note(process.pid);
const inputLog = process.env.FAKE_CLAUDE_INPUT;
// FAKE_CLAUDE_ARGS: a file it appends how it was started to (its arguments and the settings' variables).
if (process.env.FAKE_CLAUDE_ARGS) {
  appendFileSync(process.env.FAKE_CLAUDE_ARGS, JSON.stringify({
    args: process.argv.slice(2),
    subagentModel: process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? null,
    subagentCache: process.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL ?? null,
    artifact: process.env.CLAUDE_CODE_ARTIFACT ?? null,
  }) + "\n");
}
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ pid: process.pid, args, resume: !!resumed, session, cwd: process.cwd() }) + "\n");

if (resumed && process.env.FAKE_CLAUDE_FORGET === "1") {
  process.stderr.write(`No conversation found with session ID: ${resumed}\n`);
  process.exit(1);
}

const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const delta = (text) => out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
// FAKE_CLAUDE_USAGE=1 (Phase 5c): each result says a running cost (0.01 more each turn) and its tokens, and a
// rate_limit_event comes before it, as a subscription account's claude writes them.
let turns = 0;
const result = (text, ok = true, subtype = ok ? "success" : "error_during_execution") => {
  turns += 1;
  if (process.env.FAKE_CLAUDE_USAGE === "1") {
    const now = Math.floor(Date.now() / 1000);
    out({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.42, resetsAt: now + 2 * 3600 + 780, unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: now + 2 * 3600 + 780 }, seven_day: { utilization: 0.18, resetsAt: now + 3 * 86400 } } } });
    return out({ type: "result", subtype, is_error: !ok, result: text, session_id: session, total_cost_usd: 0.01 * turns, usage: { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 500, cache_read_input_tokens: 4000 } });
  }
  out({ type: "result", subtype, is_error: !ok, result: text, session_id: session, total_cost_usd: 0 });
};

if (envMode === "stubborn") process.on("SIGTERM", () => {});

// A helper like a tool command or MCP server: it must die with us on stop.
function helper(ignoreTerm) {
  const code = ignoreTerm ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)" : "setInterval(()=>{},1000)";
  const child = spawn(process.execPath, ["-e", code], { stdio: "ignore", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  note(child.pid);
  return child;
}

function directive(prompt) {
  const match = /^\/(normal|slow|stubborn|card|crash|netloss|tool|resume|choices|task|react|agent|bgagent|worker|failtool)(?::([A-Za-z]+))?\s*/.exec(prompt);
  return match ? { mode: match[1], tool: match[2] ?? "Bash", rest: prompt.slice(match[0].length) } : { mode: envMode, tool: "Bash", rest: prompt };
}

/** The user's words in a message the app wrote around them, and the paragraph a directive is read from. */
function words(text) {
  const mine = text.split("\n\n").filter((part) => !part.startsWith("(App: ") && !part.startsWith("(I sent this in parts") && !part.startsWith("(Replying to "));
  return { all: mine.join("\n\n"), last: mine.at(-1) ?? "" };
}

/** Handed-over work that streams until it is interrupted ("/slow …" as the task). */
const SLOW_HANDED = "\u0000slow";

/** What it answers to work the other head handed over, or to its hand-back (null: neither). */
function conductedReply(prompt) {
  const handed = /\(App: (?:Claude|Codex), this bot's other head, (?:hands you this|asks you to review this|wants your view on this) \(hand-off \d+ of \d+ for the user's latest message\):\n([\s\S]*?)\n\nDo it, then reply/.exec(prompt);
  if (handed) {
    const on = /^\/handoff:(claude|codex) ([\s\S]*)$/.exec(handed[1]);
    if (on) return `Over to you. <handoff to="${on[1]}">${on[2]}</handoff>`;
    if (handed[1].startsWith("/slow")) return SLOW_HANDED;
    return handed[1].startsWith("/say ") ? handed[1].slice(5) : `Did it: ${handed[1]}`;
  }
  const back = /\(App: (?:Claude|Codex) finished what you handed over\. Its reply:\n([\s\S]*?)\n\nCarry on from there/.exec(prompt);
  if (back) return back[1].startsWith("/say ") ? back[1].slice(5) : `Done: ${back[1]}`;
  if (/finished what you handed over without a user-facing reply|The user went with your version/.test(prompt)) return "<no-reply/>";
  return null;
}

let initSent = false;
function init() {
  if (initSent) return;
  initSent = true;
  // Like claude, it keeps the session's transcript under CLAUDE_CONFIG_DIR (only when a test gives one, and
  // not with --no-session-persistence); Phase 5c's brief looks whether it is there.
  if (process.env.CLAUDE_CONFIG_DIR && !args.includes("--no-session-persistence") && !args.includes("--fork-session")) {
    const folder = join(process.env.CLAUDE_CONFIG_DIR, "projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(folder, { recursive: true });
    appendFileSync(join(folder, `${session.toLowerCase()}.jsonl`), JSON.stringify({ type: "fake", session }) + "\n");
  }
  out({ type: "system", subtype: "init", session_id: session, tools: [], model: "fake", permissionMode: flag("--permission-mode") ?? "default" });
}

async function stream(text) {
  let said = "";
  for (const word of text.split(/(?<=\s)/)) {
    said += word;
    delta(word);
    await sleep(15);
  }
  return said;
}

// ---------------------------------------------------------------------------------------------
// Per turn

if (!longLived) {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) prompt += chunk;
  prompt = prompt.trim();
  init();
  out({ type: "stream_event", event: { type: "message_start" } });
  out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
  if (envMode === "slow" || envMode === "stubborn") {
    helper(envMode === "stubborn");
    for (let i = 0; ; i++) {
      delta(`word${i} `);
      await sleep(30);
    }
  }
  if (envMode === "crash") {
    delta("partial ");
    await sleep(20);
    process.exit(3);
  }
  const reply = envMode === "card"
    ? "Here is a card.\n```ccb-card\n<button id=\"b\" onclick=\"ccb.save({clicked: true})\">Click</button>\n```"
    : `You said: ${prompt}`;
  const keepAlive = helper(false);
  const text = await stream(reply);
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
  result(text);
  keepAlive.kill();
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// Long-lived

const queue = [];
let current = null; // { interrupted, helper, ignoreInterrupt }
const pending = new Map(); // permission request id → resolve
let wake = null;
let closed = false;
/** A turn is under way; what the other head said meanwhile. */
let busy = false;
let heard = [];

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type === "user") {
    const content = message.message?.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((p) => p.type === "text").map((p) => p.text).join("") : "";
    const uuid = typeof message.uuid === "string" ? message.uuid : null;
    // Pictures sent as base64 blocks (logged as their media types).
    const images = Array.isArray(content) ? content.filter((p) => p.type === "image").map((p) => p.source?.media_type ?? "?") : [];
    if (uuid) out({ type: "command_lifecycle", command_uuid: uuid, state: "queued", uuid: `cl-${Math.random().toString(36).slice(2, 10)}` });
    if (busy && process.env.FAKE_CLAUDE_NO_ABSORB !== "1" && /^\(App: (?:Claude|Codex), (?:working on this too, says:|this bot's other head, replied in this chat:)/.test(text.trim())) {
      // Read into the turn under way (claude takes queued messages in at its next step).
      heard.push(text.trim());
      if (inputLog) appendFileSync(inputLog, JSON.stringify({ session, text, midTurn: true }) + "\n");
      return;
    }
    if (busy && current?.absorbs && !current.steered && process.env.FAKE_CLAUDE_NO_ABSORB !== "1" && words(text.trim()).all.trim()) {
      // The user's words while a long turn runs are read into it too (claude's queued message, taken in at
      // its next step): that turn goes on and answers them. A turn that ends first leaves them queued.
      current.steered = text.trim();
      if (inputLog) appendFileSync(inputLog, JSON.stringify({ session, text, midTurn: true, ...(images.length ? { images } : {}) }) + "\n");
      return;
    }
    if (inputLog) appendFileSync(inputLog, JSON.stringify({ session, text, ...(images.length ? { images } : {}) }) + "\n");
    queue.push({ text: text.trim(), uuid });
    wake?.();
  } else if (message.type === "control_request" && message.request?.subtype === "initialize") {
    out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
  } else if (message.type === "control_request" && message.request?.subtype === "set_model") {
    // As claude 2.1.311: the running session's model changes; FAKE_CLAUDE_SET_MODEL refuses it.
    const model = message.request.model ?? "default";
    if (process.env.FAKE_CLAUDE_CONTROLS) appendFileSync(process.env.FAKE_CLAUDE_CONTROLS, JSON.stringify({ session, request: message.request }) + "\n");
    if (process.env.FAKE_CLAUDE_SET_MODEL === "refuse") out({ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: `Unknown model ${model}` } });
    else out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { model } } });
  } else if (message.type === "control_request" && message.request?.subtype === "interrupt") {
    if (process.env.FAKE_CLAUDE_INTERRUPTS) appendFileSync(process.env.FAKE_CLAUDE_INTERRUPTS, `${session}\n`);
    out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
    if (current && !current.ignoreInterrupt) {
      current.interrupted = true;
      current.helper?.kill("SIGKILL");
      for (const resolve of pending.values()) resolve(null);
    }
  } else if (message.type === "control_response") {
    const resolve = pending.get(message.response?.request_id);
    if (resolve) resolve(message.response?.response ?? null);
  }
});
lines.on("close", () => { closed = true; wake?.(); });

const toolId = () => `toolu_${Math.random().toString(36).slice(2, 10)}`;
const assistant = (content, parent = null) => out({ type: "assistant", parent_tool_use_id: parent, message: { role: "assistant", content } });
const toolResult = (id, content, parent = null, extra = {}) => out({ type: "user", parent_tool_use_id: parent, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: false }] }, ...extra });

/** A subagent at work: what it reads and says, its lines marked with the call that sent it. */
async function subagentWork(id) {
  const read = toolId();
  assistant([{ type: "tool_use", id: read, name: "Read", input: { file_path: "/tmp/notes.md" } }], id);
  await sleep(30);
  toolResult(read, "three notes", id);
  assistant([{ type: "text", text: "Found 3 things." }], id);
  await sleep(30);
}

/** A background job: claude's own turn once its subagent reports. */
async function backgroundTurn(job) {
  out({ type: "system", subtype: "task_notification", task_id: "task-1", tool_use_id: job.id, status: "completed", summary: "Found 3 things" });
  await sleep(20);
  out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
  const text = await stream(job.silent ? "<no-reply/>" : "The background research finished: Found 3 things.");
  assistant([{ type: "text", text }]);
  result(text);
}

async function turn(job) {
  init();
  if (job.background) return backgroundTurn(job);
  const prompt = job.text;
  // A worker's report (Claude app workers) answered with exactly FAKE_CLAUDE_REPORT_REPLY ("" ends the turn with nothing).
  if (process.env.FAKE_CLAUDE_REPORT_REPLY !== undefined && prompt.startsWith("<app_task_result ")) {
    result(await stream(process.env.FAKE_CLAUDE_REPORT_REPLY));
    return;
  }
  if (prompt.startsWith("(App: You have been idle")) {
    // The tidy: write the memory file it names, then OK.
    const file = /Update (\S+) with/.exec(prompt)?.[1];
    if (file) {
      const path = safeWritePath(join(process.cwd(), file));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `## Current status\nTidied by the fake CLI (session ${session}).\n## In progress\n## Waiting on you\n## Decided\n`);
    }
    await sleep(Number(process.env.FAKE_CLAUDE_SLOW_TIDY_MS ?? 0));
    const text = await stream("OK");
    result(text);
    return;
  }
  // A switch of engine (Phase 5c, 1.x's handoff/resume notes): the handoff goes into memory's "In
  // progress"; the head that takes over reads it and says what it carries on with (OK: nothing).
  if (prompt.startsWith("(App: The model is about to change")) {
    const file = /section of (\S+?),/.exec(prompt)?.[1];
    if (file) {
      const path = safeWritePath(join(process.cwd(), file));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `## Current status\nHanded over by the fake CLI.\n## In progress\n${process.env.FAKE_HANDOFF_WORK ?? "Finish the parser."}\n## Waiting on you\n## Decided\n`);
    }
    result(await stream("OK"));
    return;
  }
  if (prompt.startsWith("(App: You just took over with a new model")) {
    const file = /Read (\S+) first/.exec(prompt)?.[1];
    const memory = file && existsSync(join(process.cwd(), file)) ? readFileSync(join(process.cwd(), file), "utf8") : "";
    const work = /## In progress\n([^#\n][^\n]*)/.exec(memory)?.[1];
    result(await stream(work ? `Took over: ${work}` : "OK"));
    return;
  }
  if (prompt.startsWith("(App: Your subagent ")) {
    const text = await stream("Reported: the subagent finished.");
    result(text);
    return;
  }
  // The app asks it to carry on with work it paused for the user's message (1.x's resumeNote).
  if (prompt.startsWith("(App: Now carry on with what you were doing")) {
    const text = await stream("Carried on: finished the handed work.");
    result(text);
    return;
  }
  // The completion judge found the task unfinished (1.x's follow-up): it says where it stands.
  if (prompt.startsWith("(App: The completion judge found unfinished work") || prompt.startsWith("(App: Your terminal evidence is missing")) {
    const text = await stream(process.env.FAKE_CLAUDE_CONTINUE ?? "Still working on the parser.");
    result(text);
    return;
  }
  // A component made from its reply, to draw (Phase 5a's fill request): <show> with the data FAKE_CLAUDE_FILL names (else {"filled":true}).
  const fill = /^\(App: Draw the component "([^"]+)" for your reply/.exec(prompt);
  if (fill) {
    const text = await stream(process.env.FAKE_CLAUDE_FILL === "refuse" ? "That reply does not fit this component." : `<show name="${fill[1]}">${process.env.FAKE_CLAUDE_FILL ?? '{"filled":true}'}</show>`);
    result(text);
    return;
  }
  // Work the app hands over (Maintainer's jobs): taken on, never echoed (an echo would repeat the job's tags).
  if (prompt.includes("(From the main bot) ")) {
    const text = await stream("On it.");
    result(text);
    return;
  }
  // A called-in bot's answer handed back to the bot that asked ("silent" in what it asked: <no-reply/>;
  // "loop": it @s again at once).
  const answered = /^\(App: "[^"]*", whom you called in with @, answered you[\s\S]*?You asked: <<<\n([\s\S]*?)\n>>>\nIt answered: <<<\n([\s\S]*?)\n>>>/.exec(prompt);
  if (answered) {
    const text = answered[1].includes("silent") ? "<no-reply/>" : `Heard: ${answered[2]}${answered[1].includes("loop") ? "\n@Maintainer again" : ""}`;
    result(await stream(text));
    return;
  }
  // A turn in another chat (a call-in by @, a bot's @, a group chat; Phase 4c): "<name> here: <what it was
  // asked>"; "/guestsay <text>" in what it was asked: exactly <text>; a group turn not addressed to it: PASS.
  const guestAt = prompt.search(/\(App: (?:The user called you into |A bot called you in with @\. |Group chat )/);
  if (guestAt >= 0) {
    // Woken for it, the wake briefing comes first.
    const asked = prompt.slice(guestAt);
    const me = /you are "([^"]*)"/.exec(asked)?.[1] ?? "?";
    const quotes = [...asked.matchAll(/<<<\n([\s\S]*?)\n>>>/g)].map((match) => match[1]);
    const body = asked.startsWith("(App: A bot called you in") ? quotes[1] ?? "" : null;
    const newest = /^User \(newest\): (.*)$/m.exec(quotes[0] ?? "")?.[1] ?? null;
    const ask = /\n>>>\n(.*)\. It answers your line above: carry on with it\./.exec(asked)?.[1] ?? null;
    const what = body ?? ask ?? newest ?? "";
    await sleep(Number(process.env.FAKE_CLAUDE_GUEST_MS ?? 0));
    const own = /\/guestsay(?::([^ ]+))? (.*)$/.exec(what.replaceAll(" ⏎ ", "\n").split("\n")[0] ?? "");
    let text;
    if (own && (!own[1] || own[1].toLowerCase() === me.toLowerCase().replaceAll(" ", "_"))) text = own[2].replaceAll("\\n", "\n");
    else if (asked.includes("Otherwise reply with exactly PASS")) text = "PASS";
    else text = `${me} here: ${what}`;
    text = await stream(text);
    result(text);
    return;
  }
  const conducted = conductedReply(prompt);
  if (conducted === SLOW_HANDED) {
    current = { interrupted: false, helper: null, ignoreInterrupt: false, absorbs: true, steered: null };
    out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    let soFar = "";
    for (let i = 0; !current.interrupted && !current.steered; i++) {
      delta(`step${i} `);
      soFar += `step${i} `;
      await sleep(30);
    }
    if (current.steered) return result(soFar + await stream(`You said: ${words(current.steered).last}`));
    result("", false);
    return;
  }
  if (conducted !== null) {
    const text = await stream(conducted);
    out({ type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text }] } });
    result(text);
    return;
  }
  const said = words(prompt);
  // Only the app's notes (the other head's words read too late for its turn): nothing for the user.
  if (!said.all.trim()) {
    await sleep(Number(process.env.FAKE_CLAUDE_NOTE_MS ?? 0));
    const text = await stream("<no-reply/>");
    result(text);
    return;
  }
  const solo = /^\/solo\b\s*/.exec(said.last);
  if (solo) {
    const peer = /this bot's other head, replied in this chat|working on this too, says:/.test(prompt);
    const text = await stream(peer ? "<no-reply/>" : `I take it: ${said.last.slice(solo[0].length)}`);
    result(text);
    return;
  }
  const linger = /^\/linger\b\s*/.exec(said.last);
  if (linger) {
    out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    const first = await stream("Thinking it over.");
    // Words between steps: the app passes them on to the other head.
    const id = toolId();
    assistant([{ type: "text", text: first }, { type: "tool_use", id, name: "Read", input: { file_path: "notes.md" } }]);
    await sleep(Number(process.env.FAKE_CLAUDE_LINGER_MS ?? 600));
    toolResult(id, "notes");
    out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    const text = await stream(`You said: ${said.last.slice(linger[0].length)}${heard.length ? ` (heard mid-turn: ${heard.length})` : ""}`);
    result(`${first}\n\n${text}`);
    return;
  }
  // "/mention <name> <words>[|<name> <words>…]": a reply whose lines call other bots with @ (Phase 4c).
  const mention = /^\/mention\s+/.exec(said.last);
  if (mention) {
    const lines = said.last.slice(mention[0].length).split("|").map((part) => `@${part.trim()}`);
    const text = await stream(`Let me ask.\n${lines.join("\n")}`);
    result(text);
    return;
  }
  const say = /^\/say\s+/.exec(said.last);
  if (say) {
    const text = await stream(said.last.slice(say[0].length));
    result(text);
    return;
  }
  const { mode, tool } = directive(said.last);
  const rest = said.last === said.all ? directive(said.all).rest : said.all;
  current = { interrupted: false, helper: null, ignoreInterrupt: mode === "stubborn", absorbs: mode === "slow", steered: null };
  out({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start" } });
  out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
  if (mode === "slow" || mode === "stubborn") {
    if (mode === "stubborn") process.on("SIGTERM", () => {});
    current.helper = helper(mode === "stubborn");
    let soFar = "";
    for (let i = 0; !current.interrupted && !current.steered; i++) {
      delta(`word${i} `);
      soFar += `word${i} `;
      await sleep(30);
    }
    if (current.steered) {
      current.helper?.kill("SIGKILL");
      return result(soFar + await stream(`You said: ${words(current.steered).last}`));
    }
    result("", false);
    return;
  }
  if (mode === "netloss") {
    // claude's retries with no answer from the API, then its API error with no HTTP status (1.x's connectionLost).
    out({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, error_status: null, error: "unknown" });
    out({ type: "assistant", parent_tool_use_id: null, is_api_error_message: true, error: "unknown", message: { role: "assistant", content: [{ type: "text", text: "API Error: Connection error." }] } });
    result("API Error: Connection error.", false, "success");
    return;
  }
  if (mode === "crash") {
    delta("partial ");
    await sleep(20);
    process.exit(3);
  }
  if (mode === "failtool") {
    // A tool that fails on the way, then a normal end with a reply (a run that succeeds anyway).
    const id = toolId();
    assistant([{ type: "tool_use", id, name: "Bash", input: { command: "false", description: "Try it" } }]);
    out({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "exit 1", is_error: true }] } });
    result(await stream(`Recovered after a failed tool: ${rest}`));
    return;
  }
  if (mode === "tool") {
    const command = rest || "echo hi";
    const id = `toolu_${Math.random().toString(36).slice(2, 10)}`;
    const intro = await stream("Let me run that. ");
    out({ type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: intro }, { type: "tool_use", id, name: tool, input: { command, description: "Run it" } }] } });
    const requestId = `req-${Math.random().toString(36).slice(2, 10)}`;
    const answer = await new Promise((resolve) => {
      pending.set(requestId, resolve);
      out({ type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_name: tool, input: { command, description: "Run it" }, tool_use_id: id } });
    });
    pending.delete(requestId);
    if (current.interrupted || answer === null) {
      out({ type: "control_cancel_request", request_id: requestId });
      result("", false);
      return;
    }
    const allowed = answer.behavior === "allow";
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: allowed ? `ran: ${answer.updatedInput?.command}` : `denied: ${answer.message}`, is_error: !allowed }] } });
    out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    const text = await stream(allowed ? `Allowed: ran ${answer.updatedInput?.command}` : `Denied: ${answer.message}`);
    result(`${intro}\n\n${text}`);
    return;
  }
  if (mode === "worker") {
    // As claude calls an MCP tool of an "sdk" server: the host answers on the control channel.
    const requestId = `mcp-${Math.random().toString(36).slice(2, 10)}`;
    const answer = new Promise((resolve) => pending.set(requestId, resolve));
    out({ type: "control_request", request_id: requestId, request: { subtype: "mcp_message", server_name: "botling", message: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "app_handoff", arguments: { name: "Research", instructions: rest } } } } });
    const response = await answer;
    pending.delete(requestId);
    const content = response?.mcp_response?.result?.content?.[0]?.text ?? "";
    let text;
    try { text = response.mcp_response.result.isError ? `Handoff failed: ${content}` : `Handed off: ${JSON.parse(content).task_id}`; }
    catch { text = `Handoff failed: ${JSON.stringify(response)}`; }
    result(await stream(text));
    return;
  }
  if (mode === "agent" || mode === "bgagent") {
    const id = toolId();
    const background = mode === "bgagent";
    const intro = await stream(background ? "Sending one to the background. " : "Sending a subagent. ");
    assistant([{ type: "text", text: intro }, { type: "tool_use", id, name: "Agent", input: { description: "Research the API", prompt: "Look up the API and report", subagent_type: "general-purpose", ...(background ? { run_in_background: true } : {}) } }]);
    out({ type: "system", subtype: "task_started", task_id: "task-1", tool_use_id: id, task_type: "local_agent", description: "Research the API", subagent_type: "general-purpose", prompt: "Look up the API and report", is_backgrounded: background });
    if (background) {
      toolResult(id, "Async agent launched successfully. agentId: a1b2", null, { tool_use_result: { status: "async_launched", agentId: "a1b2" } });
      out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
      const text = await stream("It is at work.");
      result(`${intro}\n\n${text}`);
      setTimeout(async () => {
        await subagentWork(id);
        queue.push({ background: true, id, silent: tool === "silent" });
        wake?.();
      }, Number(process.env.FAKE_CLAUDE_BG_DELAY_MS ?? 300));
      return;
    }
    await subagentWork(id);
    toolResult(id, "Found 3 things.", null, { tool_use_result: { status: "completed", agentId: "a1b2" } });
    out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    const text = await stream("The subagent found 3 things.");
    result(`${intro}\n\n${text}`);
    return;
  }
  const reply = mode === "card"
    ? "Here is a card.\n```ccb-card\n<button id=\"b\" onclick=\"ccb.save({clicked: true})\">Click</button>\n```"
    : mode === "resume" ? `session ${session} resumed=${!!resumed}`
    : mode === "choices" ? "Which way?\n<choices>\n* Fast | done today\n- Slow | costs a week\n</choices>"
    : mode === "task" ? "Working on the docs.\n<task name=\"Docs\" now=\"writing the intro\" next=\"examples\" state=\"running\"/>"
    : mode === "react" ? `<reaction message="${rest.trim()}" emoji="👍" present="true"/>`
    : `You said: ${rest}`;
  const text = await stream(reply);
  out({ type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text }] } });
  result(text);
}

for (;;) {
  if (queue.length) {
    const job = queue.shift();
    if (job.uuid) out({ type: "command_lifecycle", command_uuid: job.uuid, state: "started", uuid: `cl-${Math.random().toString(36).slice(2, 10)}` });
    busy = true;
    heard = [];
    await turn(job);
    busy = false;
    current = null;
    continue;
  }
  if (closed) break;
  await new Promise((resolve) => { wake = resolve; });
  wake = null;
}
process.exit(0);
