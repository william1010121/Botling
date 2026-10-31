import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addSample, agyPromptRequest, ClaudeRequestTracker, CodexRequestTracker, computeTokenSpeed, emptyTotals, generationSeconds,
  MAX_REQUEST_SECONDS, readTotals, speedOf, speedView, type RequestEvent, type SpeedSample,
} from "../../src/core/token-speed";
import { ClaudeHead } from "../../src/core/agent/head";
import type { StreamItem } from "../../src/core/agent/stream";
import { claudeTranscriptSamples, codexRolloutSamples } from "../token-speed-logs";

const fixtures = resolve(__dirname, "../fixtures/token-speed");
const claudeLog = join(fixtures, "claude/projects/anon/S1.jsonl");
const codexLog = join(fixtures, "codex/sessions/2026/01/05/rollout-2026-01-05T10-00-00-C1.jsonl");
const sample = (outputTokens: number, seconds: number, complete = true): SpeedSample => ({ outputTokens, startMs: 1_000_000, endMs: 1_000_000 + seconds * 1000, complete });

describe("computeTokenSpeed: the one definition", () => {
  it("sums tokens and seconds separately, then divides (not a mean of speeds)", () => {
    // 100 tok in 1 s (100/s) and 100 tok in 9 s (11.1/s): mean of speeds 55.6, definition 20.
    const result = computeTokenSpeed([sample(100, 1), sample(100, 9)]);
    expect(result.tokPerSec).toBeCloseTo(20, 10);
    expect(result).toMatchObject({ tokens: 200, seconds: 10, timed: 2, requests: 2, excluded: 0 });
  });
  it("excludes incomplete, over-300s, zero-length and zero-token requests from BOTH sums", () => {
    const result = computeTokenSpeed([sample(60, 3), sample(999, 2, false), sample(500, MAX_REQUEST_SECONDS + 0.001), sample(50, 0), sample(0, 5)]);
    expect(result).toMatchObject({ tokens: 60, seconds: 3, timed: 1, requests: 5, excluded: 4 });
    expect(result.tokPerSec).toBe(20);
    expect(generationSeconds(sample(10, MAX_REQUEST_SECONDS))).toBe(300);
  });
  it("is null, never 0 or NaN, without timed data", () => {
    expect(computeTokenSpeed([]).tokPerSec).toBeNull();
    expect(computeTokenSpeed([sample(5, 1, false)]).tokPerSec).toBeNull();
    expect(speedView(emptyTotals())).toBeNull();
    expect(speedOf({ tokens: Number.NaN, seconds: 1, timed: 1 })).toBeNull();
  });
  it("running sums equal the batch result and survive a round trip through a record", () => {
    const samples = [sample(120, 5), sample(90, 4), sample(7, 400)];
    const sums = samples.reduce((totals, item) => addSample(totals, item), undefined as ReturnType<typeof addSample> | undefined);
    expect(speedOf(sums)).toBe(computeTokenSpeed(samples).tokPerSec);
    expect(readTotals(JSON.parse(JSON.stringify(sums)))).toEqual(sums);
    expect(readTotals({ tokens: -1, seconds: 1, timed: 1 })).toBeUndefined();
    expect(readTotals("x")).toBeUndefined();
  });
  it("never counts input or cache tokens (output only)", () => {
    // The reader of a log takes output_tokens only: the fixture's input_tokens are 3 per request.
    const tokens = claudeTranscriptSamples(claudeLog).reduce((sum, item) => sum + item.outputTokens, 0);
    expect(tokens).toBe(100 + 80 + 500 + 33);
  });
});

describe("golden: real-format log fixtures (anonymized)", () => {
  it("Claude transcript: 213 tokens / 11 s, the 370 s request and nothing else excluded", () => {
    const result = computeTokenSpeed(claudeTranscriptSamples(claudeLog));
    expect(result).toMatchObject({ tokens: 213, seconds: 11, timed: 3, requests: 4, excluded: 1 });
    expect(result.tokPerSec).toBeCloseTo(213 / 11, 10);
  });
  it("Codex rollout: 210 tokens / 9 s, the 350 s request excluded", () => {
    const result = computeTokenSpeed(codexRolloutSamples(codexLog));
    expect(result).toMatchObject({ tokens: 210, seconds: 9, timed: 2, requests: 3, excluded: 1 });
    expect(result.tokPerSec).toBeCloseTo(210 / 9, 10);
  });
});

/** The same fixture as live events: times are the log's seconds from t0. */
const feedClaude = (): RequestEvent[] => {
  const tracker = new ClaudeRequestTracker();
  const out: RequestEvent[] = [];
  const at = (seconds: number) => 1_000_000 + seconds * 1000;
  const request = (id: string, tokens: number, startAt: number, endAt: number, stale: number) => {
    const events: any[] = [
      { type: "stream_event", event: { type: "message_start", message: { id, usage: { output_tokens: stale } } } },
      { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: tokens } } },
      { type: "stream_event", event: { type: "message_stop" } },
    ];
    out.push(...tracker.observe(events[0], at(startAt)), ...tracker.observe(events[1], at(endAt)), ...tracker.observe(events[2], at(endAt)));
  };
  tracker.boundary(null, at(0)); request("msg_a", 100, 2, 5, 1);
  tracker.observe({ type: "user", message: {} }, at(20)); request("msg_b", 80, 22, 24, 1);
  tracker.observe({ type: "user", message: {} }, at(30)); request("msg_c", 500, 31, 400, 1);
  tracker.observe({ type: "user", message: {} }, at(401)); request("msg_d", 33, 402, 403, 1);
  return out;
};

describe("live trackers produce the golden numbers from the same timeline", () => {
  it("Claude: boundary-to-message_stop, final usage from message_delta (not the stale count)", () => {
    // msg_a starts at the boundary t0, not at its message_start t2: 5 s, as the transcript reader.
    expect(computeTokenSpeed(feedClaude().map((event) => event.sample))).toMatchObject({ tokens: 213, seconds: 11, timed: 3, excluded: 1 });
  });
  it("Claude: an interrupted request (no message_delta) is incomplete and excluded; subagent scopes are independent", () => {
    const tracker = new ClaudeRequestTracker();
    const start = { type: "stream_event", parent_tool_use_id: "toolu_child", event: { type: "message_start", message: { id: "m", usage: { output_tokens: 1 } } } };
    tracker.observe(start, 1_000);
    const out = tracker.observe({ type: "stream_event", parent_tool_use_id: "toolu_child", event: { type: "message_stop" } }, 4_000);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ scope: "toolu_child", sample: { complete: false } });
    expect(computeTokenSpeed([out[0]!.sample]).tokPerSec).toBeNull();
    // A parent turn's request does not touch the child's open request.
    tracker.observe(start, 5_000);
    expect(tracker.observe({ type: "stream_event", event: { type: "message_stop" } }, 6_000)).toEqual([]);
  });
  it("Codex: last.outputTokens per tokenUsage update, boundary at turn start / completed tool items, repeats ignored", () => {
    const tracker = new CodexRequestTracker();
    const at = (seconds: number) => 1_000_000 + seconds * 1000;
    const usage = (last: number, total: number) => ({ threadId: "th", tokenUsage: { last: { outputTokens: last }, total: { outputTokens: total } } });
    const out: RequestEvent[] = [];
    out.push(...tracker.observe(null, "turn/started", {}, at(1)));
    out.push(...tracker.observe(null, "item/completed", { item: { type: "reasoning" } }, at(3)));
    out.push(...tracker.observe(null, "thread/tokenUsage/updated", usage(120, 120), at(6)));
    out.push(...tracker.observe(null, "thread/tokenUsage/updated", usage(120, 120), at(6.1)));
    out.push(...tracker.observe(null, "item/completed", { item: { type: "commandExecution" } }, at(30)));
    out.push(...tracker.observe(null, "thread/tokenUsage/updated", usage(90, 210), at(34)));
    out.push(...tracker.observe(null, "item/completed", { item: { type: "commandExecution" } }, at(100)));
    out.push(...tracker.observe(null, "thread/tokenUsage/updated", usage(600, 810), at(450)));
    expect(computeTokenSpeed(out.map((event) => event.sample))).toMatchObject({ tokens: 210, seconds: 9, timed: 2, requests: 3, excluded: 1 });
  });
  it("Codex: workers and the head keep separate boundaries", () => {
    const tracker = new CodexRequestTracker();
    tracker.observe("w1", "turn/started", {}, 1_000);
    tracker.observe(null, "turn/started", {}, 5_000);
    const worker = tracker.observe("w1", "thread/tokenUsage/updated", { threadId: "a", tokenUsage: { last: { outputTokens: 10 }, total: { outputTokens: 10 } } }, 3_000);
    expect(worker[0]).toMatchObject({ scope: "w1", sample: { startMs: 1_000, endMs: 3_000 } });
  });
});

describe("ClaudeHead wiring", () => {
  it("turns raw stream-json lines into request items for the head and for a subagent", () => {
    const items: StreamItem[] = [];
    const head = new ClaudeHead({ command: "claude", cwd: "/", sessionId: "s" } as any, { onItem: (item) => items.push(item), onExit() {} });
    const line = (parent: string | null, event: unknown) => (head as any).line(JSON.stringify({ type: "stream_event", parent_tool_use_id: parent, event }));
    for (const parent of [null, "toolu_child"]) {
      line(parent, { type: "message_start", message: { id: `m-${parent}`, usage: { output_tokens: 1 } } });
      line(parent, { type: "message_delta", usage: { output_tokens: 50 } });
      line(parent, { type: "message_stop" });
    }
    const requests = items.filter((item): item is Extract<StreamItem, { kind: "request" }> => item.kind === "request").map((item) => item.request);
    expect(requests.map((request) => [request.scope, request.sample.outputTokens, request.sample.complete])).toEqual([[null, 50, true], ["toolu_child", 50, true]]);
  });
});

describe("Antigravity: ACP has one usage block per prompt and no per-request timing", () => {
  it("is the whole prompt turn, output + thought tokens, marked estimated", () => {
    const event = agyPromptRequest("u1", { inputTokens: 5000, cachedReadTokens: 100, outputTokens: 70, thoughtTokens: 30 }, 0, 4_000, true)!;
    expect(event.estimated).toBe(true);
    expect(computeTokenSpeed([event.sample]).tokPerSec).toBe(25);
    expect(speedView(addSample(undefined, event.sample, event.estimated))).toEqual({ tokPerSec: 25, estimated: true });
  });
  it("has no value without usage or when the turn did not finish", () => {
    expect(agyPromptRequest("u", undefined, 0, 1000, true)).toBeNull();
    expect(computeTokenSpeed([agyPromptRequest("u", { outputTokens: 9 }, 0, 1000, false)!.sample]).tokPerSec).toBeNull();
  });
});

describe("consistency: the app's number against the token-speed CLI on the same fixture", () => {
  const cli = [process.env.TOKEN_SPEED_BIN, join(homedir(), ".local/bin/token-speed"), "/opt/homebrew/bin/token-speed"].find((path) => path && existsSync(path));
  it.skipIf(!cli)("matches within 0.1% for Claude and Codex (CLI --max-gap 300, UTC)", () => {
    const folder = mkdtempSync(join(tmpdir(), "token-speed-"));
    try {
      const run = (provider: "claude" | "codex") => {
        const { stdout, status } = spawnSync(cli!, ["--claude-dir", join(fixtures, "claude"), "--codex-dir", join(fixtures, "codex"), "--cache", join(folder, "c.sqlite3"),
          "--provider", provider, "--all-time", "--group", "model", "--timezone", "UTC", "--json", "--refresh"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: folder } });
        expect(status).toBe(0);
        const rows = JSON.parse(stdout).data as { tokens_per_second: number; timed_output_tokens: number; seconds: number; timed_requests: number }[];
        expect(rows).toHaveLength(1);
        return rows[0]!;
      };
      for (const [provider, samples] of [["claude", claudeTranscriptSamples(claudeLog)], ["codex", codexRolloutSamples(codexLog)]] as const) {
        const app = computeTokenSpeed(samples);
        const reference = run(provider);
        expect(app.timed).toBe(reference.timed_requests);
        expect(app.tokens).toBe(reference.timed_output_tokens);
        expect(app.seconds).toBeCloseTo(reference.seconds, 6);
        expect(Math.abs(app.tokPerSec! - reference.tokens_per_second) / reference.tokens_per_second).toBeLessThan(0.001);
      }
      // The live Claude tracker agrees with the CLI too.
      const live = computeTokenSpeed(feedClaude().map((event) => event.sample));
      expect(Math.abs(live.tokPerSec! - run("claude").tokens_per_second)).toBeLessThan(1e-9);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
});
