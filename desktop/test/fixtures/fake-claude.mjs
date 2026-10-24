#!/usr/bin/env node
// A stand-in for `claude -p --output-format stream-json --include-partial-messages`, for tests and
// `npm run dev:fake`. It reads the prompt from stdin and streams a reply in the same line shapes.
//
// FAKE_CLAUDE_MODE:
//   normal   — streams "You said: <prompt>" a word at a time, then a result line (default)
//   slow     — streams words forever until killed (for stop)
//   stubborn — like slow, but ignores SIGTERM, and so does a grandchild it starts (forces SIGKILL)
//   card     — replies with a ccb-card block
//   crash    — streams a little, then exits 3 without a result line
// FAKE_CLAUDE_PIDS: a file this process appends "<pid>\n" for itself and each helper it starts.
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";

const mode = process.env.FAKE_CLAUDE_MODE || "normal";
const pidsFile = process.env.FAKE_CLAUDE_PIDS;
const note = (pid) => { if (pidsFile) appendFileSync(pidsFile, `${pid}\n`); };
note(process.pid);

const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const delta = (text) => out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });

if (mode === "stubborn") process.on("SIGTERM", () => {});

// A helper like a tool command or MCP server: it must die with us on stop.
function helper(ignoreTerm) {
  const code = ignoreTerm ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)" : "setInterval(()=>{},1000)";
  const child = spawn(process.execPath, ["-e", code], { stdio: "ignore", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  note(child.pid);
  return child;
}

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;
prompt = prompt.trim();

out({ type: "system", subtype: "init", session_id: "fake", tools: [], model: "fake" });
out({ type: "stream_event", event: { type: "message_start" } });
out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });

if (mode === "slow" || mode === "stubborn") {
  helper(mode === "stubborn");
  for (let i = 0; ; i++) {
    delta(`word${i} `);
    await sleep(30);
  }
}

if (mode === "crash") {
  delta("partial ");
  await sleep(20);
  process.exit(3);
}

const reply = mode === "card"
  ? "Here is a card.\n```ccb-card\n<button id=\"b\" onclick=\"ccb.save({clicked: true})\">Click</button>\n```"
  : `You said: ${prompt}`;
const keepAlive = helper(false); // Exits with us: the core ends the tree after the result too.
let text = "";
for (const word of reply.split(/(?<=\s)/)) {
  text += word;
  delta(word);
  await sleep(15);
}
out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
out({ type: "result", subtype: "success", is_error: false, result: text, session_id: "fake" });
keepAlive.kill();
process.exit(0);
