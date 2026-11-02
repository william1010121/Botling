// Writes the head-stream fixtures that are not plain headers over a worker recording (test/head-streams/replay.ts says
// the format): `node test/head-streams/write-fixtures.mjs`. Each is built from recorded CLI lines where a recording has
// them, with the Bot's acts and the head's expected writes ("in") put in by hand from the protocol code:
// - Codex: test/fixtures/codex-recordings.json (real `codex app-server` 0.163.0 output of a coordinator: an approval, a
//   steer, an interrupt), cut to one scenario each;
// - Claude and Antigravity: the handshake of a worker recording (test/fixtures/worker-streams), then lines written
//   from agent/stream.ts and agent/agy-acp.ts (no recording has a head interrupt, steer, approval or failed turn).
// The header's `source` and `notes` say which lines are recorded and which are not. Run it again after changing it;
// the files are checked in.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const fixtures = join(here, "..", "fixtures");
const out = join(fixtures, "head-streams");
const worker = (name) => readFileSync(join(fixtures, "worker-streams", `${name}.jsonl`), "utf8").split("\n").filter(Boolean).slice(1).map((line) => JSON.parse(line));
const codexRecordings = JSON.parse(readFileSync(join(fixtures, "codex-recordings.json"), "utf8"));

function write(engine, scenario, header, lines) {
  mkdirSync(join(out, engine), { recursive: true });
  const body = lines.map((line, i) => JSON.stringify({ t: line.t ?? i, d: line.d, l: line.l }));
  writeFileSync(join(out, engine, `${scenario}.jsonl`), [JSON.stringify({ engine, scenario, ...header }), ...body].join("\n") + "\n");
}
const act = (l) => ({ d: "act", l });
const o = (l) => ({ d: "out", l: typeof l === "string" ? l : JSON.stringify(l) });
const i = (l) => ({ d: "in", l: typeof l === "string" ? l : JSON.stringify(l) });

// ------------------------------------------------------------------------------------------------
// Codex: recorded coordinator lines (codex-recordings.json), one turn each

{
  const rec = (key) => codexRecordings[key];
  const handshake = (key, turnStartId) => [
    act({ op: "start" }),
    i({ jsonrpc: "2.0", id: 1, method: "initialize" }), o(rec(key)[0]),
    i({ jsonrpc: "2.0", id: 2, method: "thread/start" }), o(rec(key)[1]),
    i({ jsonrpc: "2.0", id: turnStartId, method: "turn/start" }),
  ];
  const lines = (key, from, to) => rec(key).slice(from, to + 1).map(o);
  const before = (key, index) => rec(key)[index];
  const notes = (key, what) => `Out lines verbatim from test/fixtures/codex-recordings.json "${key}" (codex app-server 0.163.0, a real coordinator session), cut to ${what}; the Bot's acts and the head's expected writes are put in from agent/codex.ts.`;

  // A command that needs approval: asked, allowed, run, answered.
  write("codex", "permission", { source: "recorded", cli: "codex-cli 0.163.0", notes: notes("helloAndApproval", "the second turn (lines 13-53)") }, [
    ...handshake("helloAndApproval", 4).slice(0, 5), act({ op: "send", text: "Run the shell command: echo hi > note.txt" }), handshake("helloAndApproval", 4)[5],
    ...lines("helloAndApproval", 13, 32),
    act({ op: "answer", allow: true }), i({ jsonrpc: "2.0", id: 0, result: { decision: "accept" } }),
    ...lines("helloAndApproval", 33, 53),
  ]);
  if (!before("helloAndApproval", 32).includes("requestApproval")) throw new Error("helloAndApproval moved");

  // Words for the turn under way: turn/steer with the turn's id, the user message joins, one reply answers both.
  write("codex", "steer", { source: "recorded", cli: "codex-cli 0.163.0", notes: notes("editSteerInterrupt", "the second turn (lines 29-59): a steer while `sleep 6` runs") }, [
    ...handshake("editSteerInterrupt", 4).slice(0, 5), act({ op: "send", text: "Run sleep 6, then reply first." }), handshake("editSteerInterrupt", 4)[5],
    ...lines("editSteerInterrupt", 29, 44),
    act({ op: "steer", text: "Also say second." }), i({ jsonrpc: "2.0", id: 5, method: "turn/steer" }),
    ...lines("editSteerInterrupt", 45, 59),
  ]);
  if (!before("editSteerInterrupt", 45).includes('"id":5')) throw new Error("editSteerInterrupt moved");

  // Stop while `sleep 30` runs: turn/interrupt with the turn's id; the turn completes interrupted.
  write("codex", "interrupt", { source: "recorded", cli: "codex-cli 0.163.0", notes: notes("editSteerInterrupt", "the third turn (lines 60-80): an interrupt while `sleep 30` runs") }, [
    ...handshake("editSteerInterrupt", 6).slice(0, 5), act({ op: "send", text: "Run sleep 30." }), handshake("editSteerInterrupt", 6)[5],
    ...lines("editSteerInterrupt", 60, 77),
    act({ op: "interrupt" }), i({ jsonrpc: "2.0", id: 7, method: "turn/interrupt" }),
    ...lines("editSteerInterrupt", 78, 80),
  ]);

  // Synthetic edits of the recorded hello turn (lines 2-12): a failed command, a failed turn, a silent reply.
  const hello = (edit) => rec("helloAndApproval").slice(2, 13).map((line) => o(edit(JSON.parse(line)) ?? line)).filter((line) => line.l !== "null");
  const synthetic = (what) => `Synthetic: the recorded hello turn of codex-recordings.json "helloAndApproval" (lines 2-12, codex 0.163.0) edited from agent/codex.ts: ${what}.`;
  const helloStart = [...handshake("helloAndApproval", 3).slice(0, 5), act({ op: "send", text: "Reply with the single word: hello" }), handshake("helloAndApproval", 3)[5]];
  const thread = JSON.parse(rec("helloAndApproval")[1]).result.thread.id;
  const turn = JSON.parse(rec("helloAndApproval")[2]).result.turn.id;
  const command = (status, exitCode) => ({ method: status === "inProgress" ? "item/started" : "item/completed", params: { threadId: thread, turnId: turn,
    item: { type: "commandExecution", id: "call_synthetic_cmd", command: "/bin/zsh -lc 'git status'", cwd: "/tmp/bot", status, commandActions: [{ type: "unknown", command: "git status" }],
      aggregatedOutput: status === "inProgress" ? null : "fatal: not a git repository\n", exitCode: status === "inProgress" ? null : exitCode, durationMs: status === "inProgress" ? null : 3 } } });
  write("codex", "failed-tool", { source: "synthetic", notes: synthetic("a commandExecution (git status) that fails with exit 128 comes before the final answer") }, [
    ...helloStart,
    ...hello((m) => (m.method === "item/started" && m.params.item?.type === "agentMessage" ? null : undefined)).slice(0, 5),
    o(command("inProgress")), o(command("failed", 128)),
    ...hello(() => undefined).slice(5),
  ]);
  write("codex", "failed-turn", { source: "synthetic", notes: synthetic("the model call fails: no answer, turn/completed status failed with Codex's error") }, [
    ...helloStart,
    ...hello((m) => {
      if (m.params?.item?.type === "agentMessage" || m.method === "item/agentMessage/delta") return null;
      if (m.method === "turn/completed") return { ...m, params: { ...m.params, turn: { ...m.params.turn, status: "failed", error: { message: "stream disconnected before completion: error sending request", codexErrorInfo: "responseStreamDisconnected" } } } };
      return undefined;
    }),
  ]);
  write("codex", "silent", { source: "synthetic", notes: synthetic('the final answer is "<no-reply/>"') }, [
    ...helloStart,
    ...hello((m) => {
      if (m.method === "item/agentMessage/delta") return { ...m, params: { ...m.params, delta: "<no-reply/>" } };
      if (m.params?.item?.type === "agentMessage") return { ...m, params: { ...m.params, item: { ...m.params.item, text: m.method === "item/completed" ? "<no-reply/>" : "" } } };
      return undefined;
    }),
  ]);
}

// ------------------------------------------------------------------------------------------------
// Claude: the recorded handshake, then stream-json lines from agent/stream.ts

{
  const S = "00000000-0000-4000-8000-000000000001";
  const recorded = worker("claude/failed-tool-then-success");
  const policy = recorded.find((line) => line.d === "out" && line.l.includes('"monitor-policy-'));
  const init = recorded.find((line) => line.d === "out" && line.l.includes('"subtype":"init"'));
  const U1 = "00000000-0000-4000-8000-00000000aa01", U2 = "00000000-0000-4000-8000-00000000aa02";
  const base = (uuid) => ({ session_id: S, uuid });
  const ev = (event, n) => ({ type: "stream_event", event, session_id: S, parent_tool_use_id: null, uuid: `00000000-0000-4000-8000-0000000b${String(n).padStart(4, "0")}` });
  let n = 0;
  const lifecycle = (uuid, state) => o({ type: "command_lifecycle", command_uuid: uuid, state, ...base(`00000000-0000-4000-8000-0000000c${String(++n).padStart(4, "0")}`) });
  const usage = (output) => ({ input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 23208, output_tokens: output });
  /** One model message: text chunks and/or a tool call, streamed then whole (as the recordings show). */
  const message = (id, { text, tool, stop }) => {
    const lines = [o(ev({ type: "message_start", message: { model: "claude-opus-5-5", id, type: "message", role: "assistant", content: [], usage: usage(1) } }, ++n))];
    const content = [];
    if (text !== undefined) {
      lines.push(o(ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, ++n)));
      for (const chunk of text.match(/.{1,12}/gs) ?? []) lines.push(o(ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } }, ++n)));
      content.push({ type: "text", text });
    }
    if (tool) {
      lines.push(o(ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} } }, ++n)));
      content.push({ type: "tool_use", id: tool.id, name: tool.name, input: tool.input });
    }
    lines.push(o({ type: "assistant", message: { model: "claude-opus-5-5", id, type: "message", role: "assistant", content, usage: usage(8) }, parent_tool_use_id: null, ...base(`00000000-0000-4000-8000-0000000d${String(++n).padStart(4, "0")}`) }));
    lines.push(o(ev({ type: "message_delta", delta: { stop_reason: stop }, usage: usage(40) }, ++n)), o(ev({ type: "message_stop" }, ++n)));
    return lines;
  };
  const toolResult = (id, output, failed) => o({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output, is_error: failed }] }, parent_tool_use_id: null, ...base(`00000000-0000-4000-8000-0000000e${String(++n).padStart(4, "0")}`) });
  const result = (text, { error = false, subtype = "success" } = {}) => o({ type: "result", subtype, is_error: error, duration_ms: 4000, num_turns: 2, result: text, stop_reason: error ? null : "end_turn", session_id: S, total_cost_usd: 0.0421, usage: usage(48) });
  const start = (text, uuid = U1) => [act({ op: "start" }), act({ op: "send", text, uuid }), i({ type: "control_request", request: { subtype: "initialize" } }), o(policy.l), i({ type: "user", uuid }), lifecycle(uuid, "queued"), lifecycle(uuid, "started"), o(init.l)];
  const notes = (what) => `Synthetic: the handshake (monitor-policy answer, init) is the recorded claude 2.1.311 worker-streams/claude/failed-tool-then-success; the turn is written from agent/stream.ts and agent/head.ts: ${what}.`;
  const bash = { id: "toolu_synthetic_bash", name: "Bash", input: { command: "rm -rf build", description: "Remove the build folder" } };

  write("claude", "permission", { source: "synthetic", notes: notes("a Bash call claude asks about (can_use_tool on stdout), allowed with its input unchanged (control_response allow), then the reply") }, [
    ...start("Remove the build folder."),
    ...message("msg_synthetic_1", { tool: bash, stop: "tool_use" }),
    o({ type: "control_request", request_id: "perm-synthetic-1", request: { subtype: "can_use_tool", tool_name: "Bash", input: bash.input, tool_use_id: bash.id } }),
    act({ op: "answer", allow: true }), i({ type: "control_response", response: { subtype: "success", request_id: "perm-synthetic-1", response: { behavior: "allow" } } }),
    toolResult(bash.id, "", false),
    ...message("msg_synthetic_2", { text: "Removed the build folder.", stop: "end_turn" }),
    result("Removed the build folder."), lifecycle(U1, "completed"),
  ]);
  write("claude", "interrupt", { source: "synthetic", notes: notes("Stop while a Bash call runs: control_request interrupt; claude answers it, the tool result says it was interrupted, and the turn ends with an error result (error_during_execution) while the session goes on") }, [
    ...start("Run sleep 30."),
    ...message("msg_synthetic_1", { tool: { id: "toolu_synthetic_sleep", name: "Bash", input: { command: "sleep 30" } }, stop: "tool_use" }),
    act({ op: "interrupt" }), i({ type: "control_request", request: { subtype: "interrupt" } }),
    o({ type: "control_response", response: { subtype: "success", request_id: "interrupt-00000000-0000-4000-8000-000000000000", response: {} } }),
    toolResult("toolu_synthetic_sleep", "[Request interrupted by user for tool use]", true),
    o({ type: "result", subtype: "error_during_execution", is_error: true, duration_ms: 2100, num_turns: 1, stop_reason: null, session_id: S, total_cost_usd: 0.0198, usage: usage(12), errors: ["Request was aborted."] }),
  ]);
  write("claude", "steer", { source: "synthetic", notes: notes("a second message while the turn runs goes on stdin with its uuid (the Bot's steer for claude); claude reads it into the turn (command_lifecycle queued, never started) and one reply answers both") }, [
    ...start("Run sleep 6, then reply first."),
    ...message("msg_synthetic_1", { tool: { id: "toolu_synthetic_sleep", name: "Bash", input: { command: "sleep 6" } }, stop: "tool_use" }),
    act({ op: "steer", text: "Also say second.", uuid: U2 }), i({ type: "user", uuid: U2 }), lifecycle(U2, "queued"),
    toolResult("toolu_synthetic_sleep", "", false),
    ...message("msg_synthetic_2", { text: "first second", stop: "end_turn" }),
    result("first second"), lifecycle(U1, "completed"), lifecycle(U2, "completed"),
  ]);
  write("claude", "failed-turn", { source: "synthetic", notes: notes("the API fails the turn: a result with is_error and the CLI's error text, no reply") }, [
    ...start("Reply with the single word: hello"),
    result("API Error: 500 Internal server error", { error: true }), lifecycle(U1, "completed"),
  ]);
  write("claude", "silent", { source: "synthetic", notes: notes('the reply is only "<no-reply/>"') }, [
    ...start("Thanks, nothing else."),
    ...message("msg_synthetic_1", { text: "<no-reply/>", stop: "end_turn" }),
    result("<no-reply/>"), lifecycle(U1, "completed"),
  ]);
}

// ------------------------------------------------------------------------------------------------
// Antigravity: the recorded ACP handshake, then session/update lines from agent/agy-acp.ts

{
  const recorded = worker("agy/chunked-text");
  const prompt = recorded.findIndex((line) => line.d === "in" && line.l.includes('"method":"session/prompt"'));
  const handshake = recorded.slice(0, prompt).filter((line) => line.d === "in" || line.d === "out").map((line) => ({ d: line.d, l: line.l }));
  const session = JSON.parse(handshake.find((line) => line.d === "out" && line.l.includes('"sessionId"') && line.l.includes('"id":2')).l).result.sessionId;
  const update = (u) => o({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session, update: u } });
  const chunk = (text) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  const done = (id, stopReason) => o({ jsonrpc: "2.0", id, result: { stopReason, usage: { totalTokens: 6400, inputTokens: 6200, outputTokens: 60, thoughtTokens: 140, cachedReadTokens: 0, cachedWriteTokens: 0 } } });
  const start = (text) => [act({ op: "start" }), act({ op: "send", text }), ...handshake];
  const promptIn = (id) => i({ jsonrpc: "2.0", id, method: "session/prompt" });
  const modeIn = (id) => i({ jsonrpc: "2.0", id, method: "session/set_config_option" });
  const modeOut = (id) => ({ ...handshake.filter((line) => line.d === "out" && line.l.includes('"configOptions"')).at(-1), l: handshake.filter((line) => line.d === "out" && line.l.includes('"configOptions"')).at(-1).l.replace(/"id":\d+/, `"id":${id}`) });
  const notes = (what) => `Synthetic: the handshake (initialize, session/new, the mode confirmations) is the recorded ACP 1.4.3 worker-streams/agy/chunked-text; the turn is written from agent/agy-acp.ts: ${what}.`;
  // The recorded handshake ends with the mode confirmation each prompt asks for (id 5); the prompt is id 6.
  write("agy", "steer", { source: "synthetic", notes: notes("ACP cannot steer: a second message while the turn runs waits in the head's queue, and goes as the next session/prompt (after its own mode confirmation) once the first turn ends") }, [
    ...start("Reply with the single word: first"), promptIn(6), chunk("fir"),
    act({ op: "steer", text: "Now reply with the single word: second" }),
    chunk("st"), done(6, "end_turn"),
    modeIn(7), modeOut(7), promptIn(8), chunk("second"), done(8, "end_turn"),
  ]);
  write("agy", "failed-turn", { source: "synthetic", notes: notes("the model refuses: stopReason refusal, no reply") }, [
    ...start("Reply with the single word: hello"), promptIn(6), done(6, "refusal"),
  ]);
  write("agy", "silent", { source: "synthetic", notes: notes('the reply is only "<no-reply/>"') }, [
    ...start("Thanks, nothing else."), promptIn(6), chunk("<no-reply/>"), done(6, "end_turn"),
  ]);
}
