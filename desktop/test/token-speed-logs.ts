// Reference readers for the two on-disk log formats the token-speed CLI reads. They turn a log into
// the same SpeedSample list the app builds live, so the golden and CLI-consistency tests can compare
// one fixture three ways: this reader, the live trackers, and the real CLI.
import { readFileSync } from "node:fs";
import type { SpeedSample } from "../src/core/token-speed";

const lines = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const ms = (stamp: string) => Date.parse(stamp);

/** Claude transcript: a request is every line of one message id; it starts at its first line's parent. */
export function claudeTranscriptSamples(path: string): SpeedSample[] {
  const rows = lines(path);
  const byUuid = new Map<string, any>(rows.filter((row) => row.uuid).map((row) => [row.uuid, row]));
  const requests = new Map<string, { first: any; last: any }>();
  for (const row of rows) {
    const id = row.type === "assistant" ? row.message?.id : null;
    if (typeof id !== "string") continue;
    const entry = requests.get(id);
    if (entry) entry.last = row; else requests.set(id, { first: row, last: row });
  }
  return [...requests.values()].map(({ first, last }) => ({
    outputTokens: last.message.usage.output_tokens,
    startMs: ms(byUuid.get(first.parentUuid)?.timestamp ?? first.timestamp),
    endMs: ms(last.timestamp),
    complete: last.message.stop_reason != null,
  }));
}

/** Codex rollout: a request ends at a token_count and starts at the last thing handed to the model. */
export function codexRolloutSamples(path: string): SpeedSample[] {
  let boundary: number | null = null;
  const out: SpeedSample[] = [];
  for (const row of lines(path)) {
    const payload = row.payload ?? {};
    if (row.type === "response_item" && (payload.type === "function_call_output" || (payload.type === "message" && payload.role === "user"))) boundary = ms(row.timestamp);
    if (row.type === "event_msg" && payload.type === "token_count" && payload.info?.last_token_usage) {
      out.push({ outputTokens: payload.info.last_token_usage.output_tokens, startMs: boundary ?? ms(row.timestamp), endMs: ms(row.timestamp), complete: true });
      boundary = null;
    }
  }
  return out;
}
