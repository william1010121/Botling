// Auto mode (1.x CodexAgentProcess): Codex's own reviewer (`auto_review`) answers escalations for the
// head and its workers; only its refusals become a card; Allow lets that command through and the
// refused thread's next turn asks the app ("user") once, then the reviewer again.
import { describe, expect, it } from "vitest";
import { CodexSession, type CodexConfig, type CodexOutput } from "../../src/core/agent/codex";

const writes = (out: CodexOutput[]) => out.filter((o) => o.kind === "write").map((o) => o.value as any);
const items = (out: CodexOutput[]) => out.filter((o) => o.kind === "item").map((o) => (o as { item: any }).item);

function session(autoMode?: boolean, overrides: Partial<CodexConfig> = {}) {
  const s = new CodexSession({ cwd: "/tmp/bot", instructions: "Coordinator", workerInstructions: "Worker", resumeThread: null, model: null, workerModel: null, effort: null, restoredWorkers: [], ...(autoMode === undefined ? {} : { autoMode }), ...overrides });
  const started = writes([...s.start(), ...s.receive(JSON.stringify({ id: 1, result: {} }))]);
  const thread = started.find((w) => w.method === "thread/start" || w.method === "thread/resume");
  const ready = writes(s.receive(JSON.stringify({ id: thread.id, result: { thread: { id: "coordinator" } } })));
  const refresh = ready.find(w => w.method === "thread/inject_items");
  if (refresh) s.receive(JSON.stringify({ id: refresh.id, result: {} }));
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


describe("explicit Codex permission bypass", () => {
  it.each([false, true])("maps new heads and workers with bypass=%s", (bypassPermissions) => {
    const f = session(true, { bypassPermissions });
    const expected = bypassPermissions
      ? { approvalPolicy: "never", approvalsReviewer: "user", sandbox: "danger-full-access" }
      : { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write" };
    expect(f.thread.params).toMatchObject(expected);
    expect(worker(f).start.params).toMatchObject(expected);
  });

  it.each([false, true])("overrides persisted coordinator and worker permissions on resume: bypass=%s", (bypassPermissions) => {
    const f = session(true, { bypassPermissions, resumeThread: "coordinator", restoredWorkers: [
      { id: "task-1", name: "Worker", instructions: "Build", thread: "old-worker", run: 1, wasActive: false, reportPending: false, status: "completed" },
    ] });
    const expected = bypassPermissions
      ? { approvalPolicy: "never", approvalsReviewer: "user", sandbox: "danger-full-access" }
      : { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write" };
    expect(f.thread.method).toBe("thread/resume");
    expect(f.thread.params).toMatchObject(expected);
    const resumed = writes(f.line({ id: "resume-worker", method: "item/tool/call", params: {
      threadId: "coordinator", tool: "app_send_message", arguments: { task_id: "task-1", message: "Continue" },
    } })).find(w => w.method === "thread/resume");
    expect(resumed?.params).toMatchObject({ ...expected, threadId: "old-worker" });
  });
});


describe("auto risk policy reaches heads and app-managed workers", () => {
  it.each(["low", "medium", "high", "critical", "unknown"])("passes the %s rule to both reviewers without removing the sandbox", (risk) => {
    const f = session();
    const w = worker(f);
    for (const start of [f.thread, w.start]) {
      const policy = start.params.config["auto_review.extra_policy"];
      expect(policy).toContain(`Botling ${risk} risk (${risk === "low" || risk === "medium" ? "allow" : risk === "critical" ? "block" : "ask"})`);
      expect(start.params.sandbox).toBe("workspace-write");
      expect(start.params.approvalPolicy).toBe("on-request");
    }
  });

  it.each(["low", "medium", "high", "critical", null, "future-risk"])("does not override external denied verdicts, including risk=%s", (riskLevel) => {
    const f = session();
    const card = items(f.line({ method: "item/autoApprovalReview/completed", params: { threadId: "coordinator", review: { status: "denied", riskLevel }, action: { type: "command", command: "test-command" } } }));
    expect(card).toMatchObject([{ kind: "permission" }]);
    // Policy is supplied BEFORE review. A refusal is never silently converted to approval/retry.
    expect(writes(f.s.send("continue")).find(w => w.method === "turn/start")?.params.approvalsReviewer).toBeUndefined();
  });

  it.each(["timedOut", "aborted", "future-status", undefined])("surfaces failed/unknown reviewer status %s for both head and worker", (status) => {
    const f = session();
    const w = worker(f);
    for (const threadId of ["coordinator", "worker"]) {
      const out = f.line({ method: "item/autoApprovalReview/completed", params: { threadId, review: { status }, action: { type: "command", command: "test-command" } } });
      expect(writes(out)).toEqual([]);
      expect(items(out)).toMatchObject([{ kind: "permission", input: { reason: expect.stringContaining("No automatic approval") }, ...(threadId === "worker" ? { workerId: w.task } : {}) }]);
    }
  });

  it("bypass and manual modes do not install the auto reviewer policy", () => {
    for (const f of [session(false), session(true, { bypassPermissions: true })]) {
      expect(f.thread.params.config["auto_review.extra_policy"]).toBeUndefined();
      expect(worker(f).start.params.config["auto_review.extra_policy"]).toBeUndefined();
    }
  });
});


it("manual command override is thread/cwd scoped and single-use", () => {
  const f = session();
  worker(f);
  f.s.answer(items(f.denied("coordinator", "echo retry"))[0].requestId, true);
  f.s.send("continue");
  const request = (id: string, threadId: string, cwd: string) => f.line({ id, method: "item/commandExecution/requestApproval", params: { threadId, cwd, command: "echo retry", environmentId: "local" } });
  for (const out of [request("other-worker", "worker", "/tmp/bot"), request("other-cwd", "coordinator", "/tmp/other")]) {
    expect(writes(out).some(w => w.result?.decision === "accept")).toBe(false);
  }
  expect(writes(request("own", "coordinator", "/tmp/bot"))).toMatchObject([{ result: { decision: "accept" } }]);
  expect(writes(request("again", "coordinator", "/tmp/bot")).some(w => w.result?.decision === "accept")).toBe(false);
});
