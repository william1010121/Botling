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
// FAKE_CLAUDE_PIDS: a file this process appends "<pid>\n" to, for itself and each helper it starts.
// FAKE_CLAUDE_LOG: a file it appends one JSON line to per start: {pid, args, resume, session, cwd}.
// FAKE_CLAUDE_FORGET=1: `--resume` fails like claude's for a session it does not have (exit 1, stderr only).
import { appendFileSync } from "node:fs";
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
  const match = /^\/(normal|slow|stubborn|card|crash|tool|resume)(?::([A-Za-z]+))?\s*/.exec(prompt);
  return match ? { mode: match[1], tool: match[2] ?? "Bash", rest: prompt.slice(match[0].length) } : { mode: envMode, tool: "Bash", rest: prompt };
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
    queue.push(text.trim());
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

async function turn(prompt) {
  init();
  const { mode, rest, tool } = directive(prompt);
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
  const reply = mode === "card"
    ? "Here is a card.\n```ccb-card\n<button id=\"b\" onclick=\"ccb.save({clicked: true})\">Click</button>\n```"
    : mode === "resume" ? `session ${session} resumed=${!!resumed}` : `You said: ${rest}`;
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
