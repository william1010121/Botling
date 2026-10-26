// Auto mode (1.x CodexAgentProcess): Codex's own reviewer (`auto_review`) answers escalations for the
// head and its workers; only its refusals become a card; Allow lets that command through and the
// refused thread's next turn asks the app ("user") once, then the reviewer again.
import { describe, expect, it } from "vitest";
import { CodexSession, type CodexOutput } from "../../src/core/agent/codex";

const writes = (out: CodexOutput[]) => out.filter((o) => o.kind === "write").map((o) => o.value as any);
const items = (out: CodexOutput[]) => out.filter((o) => o.kind === "item").map((o) => (o as { item: any }).item);

function session(autoMode?: boolean) {
  const s = new CodexSession({ cwd: "/tmp/bot", instructions: "Coordinator", workerInstructions: "Worker", resumeThread: null, model: null, workerModel: null, effort: null, restoredWorkers: [], ...(autoMode === undefined ? {} : { autoMode }) });
  const started = writes([...s.start(), ...s.receive(JSON.stringify({ id: 1, result: {} }))]);
  const thread = started.find((w) => w.method === "thread/start");
  s.receive(JSON.stringify({ id: thread.id, result: { thread: { id: "coordinator" } } }));
  const line = (value: unknown) => s.receive(JSON.stringify(value));
  const denied = (threadId: string, command = "rm -rf build") => line({ method: "item/autoApprovalReview/completed", params: {
    threadId, turnId: "t", reviewId: "r1", targetItemId: "exec-1", decisionSource: "agent",
    review: { status: "denied", riskLevel: "high", userAuthorization: null, rationale: "Deletes files outside the task." },
    action: { type: "command", source: "shell", command, cwd: "/tmp/bot" },
  } });
  return { s, thread, line, denied };
}

function worker(f: ReturnType<typeof session>) {
  const handed = writes(f.line({ id: "h", method: "item/tool/call", params: { threadId: "coordinator", tool: "app_handoff", arguments: { instructions: "Do work" } } }));
  const task = JSON.parse(handed[0].result.contentItems[0].text).task_id as string;
  const start = handed.find((v) => v.method === "thread/start");
  const turn = writes(f.line({ id: start.id, result: { thread: { id: "worker" } } })).find((v) => v.method === "turn/start");
  f.line({ id: turn.id, result: { turn: { id: "worker-turn" } } });
  return { task, start, turn };
}

describe("Codex auto mode (auto_review)", () => {
  it("is on by default for the head and its workers; off means the user reviews", () => {
    const f = session();
    expect(f.thread.params.approvalsReviewer).toBe("auto_review");
    expect(worker(f).start.params).toMatchObject({ approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write" });
    const off = session(false);
    expect(off.thread.params.approvalsReviewer).toBe("user");
    expect(worker(off).start.params.approvalsReviewer).toBe("user");
  });

  it("an approved review shows nothing; a refusal becomes a card with the reviewer's reason", () => {
    const f = session();
    expect(f.line({ method: "item/autoApprovalReview/completed", params: { threadId: "coordinator", review: { status: "approved" }, action: { type: "command", command: "git commit -m x" } } })).toEqual([]);
    const card = items(f.denied("coordinator"))[0];
    expect(card).toMatchObject({ kind: "permission", tool: "Bash" });
    expect(card.requestId).toMatch(/^codex-review:/);
    expect(card.summary).toBe("rm -rf build");
    expect(card.input).toMatchObject({ reviewRefused: true, reason: "[high risk] Deletes files outside the task." });
    expect(card.workerId).toBeUndefined();
  });

  it("Allow on the head: the next turn asks the app once, and the allowed command is accepted", () => {
    const f = session();
    const card = items(f.denied("coordinator"))[0];
    expect(f.s.answer(card.requestId, true)).toEqual([]);
    const first = writes(f.s.send("go on")).find((w) => w.method === "turn/start");
    expect(first.params.approvalsReviewer).toBe("user");
    expect(writes(f.line({ id: "a1", method: "item/commandExecution/requestApproval", params: { kind: "command", threadId: "coordinator", turnId: "x", environmentId: "local", command: "rm -rf build", cwd: "/tmp/bot" } })))
      .toEqual([{ jsonrpc: "2.0", id: "a1", result: { decision: "accept" } }]);
    // Any other command still asks the user.
    expect(writes(f.line({ id: "a2", method: "item/commandExecution/requestApproval", params: { kind: "command", threadId: "coordinator", environmentId: "local", command: "rm -rf src", cwd: "/tmp/bot" } })).some((w) => w.result?.decision === "accept")).toBe(false);
    f.line({ id: first.id, result: { turn: { id: "turn-1" } } });
    f.line({ method: "turn/completed", params: { threadId: "coordinator", turn: { id: "turn-1", status: "completed" } } });
    const second = writes(f.s.send("again")).find((w) => w.method === "turn/start");
    expect(second.params.approvalsReviewer).toBe("auto_review");
    f.line({ id: second.id, result: { turn: { id: "turn-2" } } });
    f.line({ method: "turn/completed", params: { threadId: "coordinator", turn: { id: "turn-2", status: "completed" } } });
    const third = writes(f.s.send("and again")).find((w) => w.method === "turn/start");
    expect(third.params.approvalsReviewer).toBeUndefined();
  });

  it("Don't allow changes nothing", () => {
    const f = session();
    const card = items(f.denied("coordinator"))[0];
    expect(f.s.answer(card.requestId, false)).toEqual([]);
    expect(writes(f.s.send("go on")).find((w) => w.method === "turn/start").params.approvalsReviewer).toBeUndefined();
    expect(items(f.line({ id: "a1", method: "item/commandExecution/requestApproval", params: { kind: "command", threadId: "coordinator", environmentId: "local", command: "rm -rf build", cwd: "/tmp/bot" } })).map((i) => i.kind)).toContain("permission");
  });

  it("a worker's refusal is that worker's card; Allow switches the worker's next turn to the user once", () => {
    const f = session();
    const { task } = worker(f);
    const card = items(f.denied("worker"))[0];
    expect(card).toMatchObject({ kind: "permission", tool: "Bash", workerId: task });
    f.s.answer(card.requestId, true);
    f.line({ method: "turn/completed", params: { threadId: "worker", turn: { id: "worker-turn", status: "completed" } } });
    const follow = writes(f.line({ id: "m", method: "item/tool/call", params: { threadId: "coordinator", tool: "app_send_message", arguments: { task_id: task, message: "Try again" } } }));
    const next = follow.find((w) => w.method === "turn/start" && w.params.threadId === "worker");
    expect(next?.params.approvalsReviewer).toBe("user");
  });
});
