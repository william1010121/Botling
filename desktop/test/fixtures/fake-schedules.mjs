// A headless Claude stream fixture: the test supplies the exact frames for each turn.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const trace = (direction, frame) => {
  if (process.env.FAKE_SCHEDULES_TRACE) appendFileSync(process.env.FAKE_SCHEDULES_TRACE, JSON.stringify({ pid: process.pid, direction,
    type: frame.type, subtype: frame.request?.subtype ?? frame.response?.subtype ?? frame.subtype,
    requestId: frame.request_id ?? frame.response?.request_id, uuid: frame.uuid, hooks: frame.request?.hooks,
    response: frame.response?.response }) + "\n");
};
const out = (frame) => { trace("out", frame); process.stdout.write(JSON.stringify(frame) + "\n"); };
function completeTurn(message) {
  out({ type: "system", subtype: "init", session_id: message.session_id });
  const text = JSON.stringify(message.message.content);
  const encoded = [...text.matchAll(/SCHEDULE_FRAMES:([A-Za-z0-9+/=]+)/g)].map((match) => match[1]).at(-1);
  if (encoded) for (const frame of JSON.parse(Buffer.from(encoded, "base64").toString())) out(frame);
  out({ type: "result", subtype: "success", result: "Schedule checked." });
}
let monitorHook;
let pendingTurn;
let probed = false;
const pendingReplies = new Set();
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  trace("in", message);
  if (message.type === "control_request" && message.request?.subtype === "initialize") {
    monitorHook = message.request.hooks?.PreToolUse?.find(hook => hook.matcher === "^Monitor$")?.hookCallbackIds?.[0];
    out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
    continue;
  }
  if (message.type === "control_response" && pendingReplies.delete(message.response?.request_id)) {
    if (!pendingReplies.size) { completeTurn(pendingTurn); pendingTurn = undefined; }
    continue;
  }
  if (message.type !== "user") continue;
  if (process.env.FAKE_SCHEDULES_PROBE_MONITOR === "1" && !probed) {
    if (!monitorHook) throw new Error("The schedule owner did not register its Monitor hook.");
    probed = true;
    pendingTurn = message;
    // Exercise the real owning head's policy only. No Monitor tool call or shell runs.
    for (const [requestId, identity] of [["schedule-owner-monitor", {}], ["schedule-child-monitor", { agent_id: "schedule-child" }]]) {
      pendingReplies.add(requestId);
      out({ type: "control_request", request_id: requestId, request: { subtype: "hook_callback", callback_id: monitorHook,
        input: { hook_event_name: "PreToolUse", tool_name: "Monitor", tool_input: { command: "fixture-only; never executed" }, ...identity } } });
    }
    continue;
  }
  completeTurn(message);
}
