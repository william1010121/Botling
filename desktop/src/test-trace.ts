// Test-only wire contract shared by preload, renderers and the main-owned JSONL writer.
export const TEST_TRACE_CHANNEL = "botling:test-trace";
export const TEST_TRACE_ARGUMENT = "--botling-test-trace=1";
export const TEST_TRACE_QUERY = "__botling_test_trace";
export const TEST_TRACE_MAX_BYTES = 256 * 1024;
export interface TestTraceRecord {
  v: 1;
  scope: "shell" | "chat";
  generation: string;
  timeOrigin: number;
  at: number; // performance.timeOrigin + performance.now(), not IPC arrival order
  seq: number;
  event: string;
  data: Record<string, unknown>;
}
export interface TestTraceBridge { protocol: 1; emit(record: TestTraceRecord): void }
export function isTestTraceRecord(value: unknown): value is TestTraceRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as TestTraceRecord;
  if (r.v !== 1 || !["shell", "chat"].includes(r.scope) || typeof r.generation !== "string" || r.generation.length > 160
      || !Number.isFinite(r.timeOrigin) || !Number.isFinite(r.at) || !Number.isSafeInteger(r.seq) || r.seq < 1
      || typeof r.event !== "string" || r.event.length > 120 || !r.data || typeof r.data !== "object" || Array.isArray(r.data)) return false;
  try { return new TextEncoder().encode(JSON.stringify(r)).length <= TEST_TRACE_MAX_BYTES; } catch { return false; }
}
