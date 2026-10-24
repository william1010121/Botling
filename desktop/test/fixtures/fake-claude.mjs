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
//   tool     — (long-lived) asks to run a Bash command and reports whether it was allowed:
//              "/tool <command>" asks for <command> (default "echo hi"); "/tool:WebFetch …" asks for another tool
//   resume   — replies with how it was started: "session <id> resumed=<bool>"
//   choices  — asks with a <choices> block;  task — replies with a <task …/> line;  team — a <team> request
//   react    — "/react <message id>": a reaction-only reply (👍 on that line)
//   agent    — (long-lived) sends a subagent (Agent tool) that reads a file and reports back, then says so
//   bgagent  — (long-lived) sends one to the background; it reports a moment later, and claude starts
//              a turn of its own to say so ("/bgagent:silent": that turn says only <no-reply/>)
// App notes ("(App: …" paragraphs: the wake briefing, recent lines, reactions) are not the user's
// words: the reply echoes the rest, and the directive is read from the last paragraph. The tidy
// note ("(App: You have been idle …") is answered "OK" after writing the memory file it names.
// FAKE_CLAUDE_INPUT: a file it appends {session, text} to for every message it reads.
// FAKE_CLAUDE_PIDS: a file this process appends "<pid>\n" to, for itself and each helper it starts.
// FAKE_CLAUDE_LOG: a file it appends one JSON line to per start: {pid, args, resume, session, cwd}.
// FAKE_CLAUDE_FORGET=1: `--resume` fails like claude's for a session it does not have (exit 1, stderr only).
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ pid: process.pid, args, resume: !!resumed, session, cwd: process.cwd() }) + "\n");

if (resumed && process.env.FAKE_CLAUDE_FORGET === "1") {
  process.stderr.write(`No conversation found with session ID: ${resumed}\n`);
  process.exit(1);
}

const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const delta = (text) => out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
const result = (text, ok = true, subtype = ok ? "success" : "error_during_execution") => out({ type: "result", subtype, is_error: !ok, result: text, session_id: session, total_cost_usd: 0 });

if (envMode === "stubborn") process.on("SIGTERM", () => {});

// A helper like a tool command or MCP server: it must die with us on stop.
function helper(ignoreTerm) {
  const code = ignoreTerm ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)" : "setInterval(()=>{},1000)";
  const child = spawn(process.execPath, ["-e", code], { stdio: "ignore", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  note(child.pid);
  return child;
}

function directive(prompt) {
  const match = /^\/(normal|slow|stubborn|card|crash|tool|resume|choices|task|team|react|agent|bgagent)(?::([A-Za-z]+))?\s*/.exec(prompt);
  return match ? { mode: match[1], tool: match[2] ?? "Bash", rest: prompt.slice(match[0].length) } : { mode: envMode, tool: "Bash", rest: prompt };
}

/** The user's words in a message the app wrote around them, and the paragraph a directive is read from. */
function words(text) {
  const mine = text.split("\n\n").filter((part) => !part.startsWith("(App: ") && !part.startsWith("(I sent this in parts") && !part.startsWith("(Replying to "));
  return { all: mine.join("\n\n"), last: mine.at(-1) ?? "" };
}

let initSent = false;
function init() {
  if (initSent) return;
  initSent = true;
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

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type === "user") {
    const content = message.message?.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((p) => p.type === "text").map((p) => p.text).join("") : "";
    if (inputLog) appendFileSync(inputLog, JSON.stringify({ session, text }) + "\n");
    queue.push({ text: text.trim() });
    wake?.();
  } else if (message.type === "control_request" && message.request?.subtype === "interrupt") {
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
  if (prompt.startsWith("(App: You have been idle")) {
    // The tidy: write the memory file it names, then OK.
    const file = /Update (\S+) with/.exec(prompt)?.[1];
    if (file) {
      const path = join(process.cwd(), file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `## Current status\nTidied by the fake CLI (session ${session}).\n## In progress\n## Waiting on you\n## Decided\n`);
    }
    await sleep(Number(process.env.FAKE_CLAUDE_SLOW_TIDY_MS ?? 0));
    const text = await stream("OK");
    result(text);
    return;
  }
  if (prompt.startsWith("(App: Your subagent ")) {
    const text = await stream("Reported: the subagent finished.");
    result(text);
    return;
  }
  const said = words(prompt);
  const { mode, tool } = directive(said.last);
  const rest = said.last === said.all ? directive(said.all).rest : said.all;
  current = { interrupted: false, helper: null, ignoreInterrupt: mode === "stubborn" };
  out({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start" } });
  out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
  if (mode === "slow" || mode === "stubborn") {
    if (mode === "stubborn") process.on("SIGTERM", () => {});
    current.helper = helper(mode === "stubborn");
    for (let i = 0; !current.interrupted; i++) {
      delta(`word${i} `);
      await sleep(30);
    }
    result("", false);
    return;
  }
  if (mode === "crash") {
    delta("partial ");
    await sleep(20);
    process.exit(3);
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
    : mode === "team" ? "<team name=\"research\">Find X</team>Handed to the research team."
    : mode === "react" ? `<reaction message="${rest.trim()}" emoji="👍" present="true"/>`
    : `You said: ${rest}`;
  const text = await stream(reply);
  out({ type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text }] } });
  result(text);
}

for (;;) {
  if (queue.length) {
    await turn(queue.shift());
    current = null;
    continue;
  }
  if (closed) break;
  await new Promise((resolve) => { wake = resolve; });
  wake = null;
}
process.exit(0);
