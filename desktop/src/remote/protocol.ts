// The protocol between Botling and `botling-agent`, the small program that runs a Claude worker on another machine
// (multi-machine phase 1, spec/models/remoteworker/RemoteWorker.tla). The same frames travel two ways:
//   ssh:   JSON lines on the stdio of `ssh <host> ~/.botling-agent/bin/botling-agent serve` (one ssh process per
//          connection);
//   relay: inside the end-to-end encrypted channel between Botling and the agent's daemon (one channel carries the
//          connections of every worker on that machine).
//
// A worker's session on the machine is `s` (the worker's id); a connection to it is numbered `g` by the app (the
// model's `gen`). Every worker frame carries both; the agent and the app act only on the connection they are on.
//   app -> agent:  hello, attach(from), start(v), answer(k), cancel        (the model's frames)
//                  send (words into the run under way), finish (close claude's input), toolResult (an app tool's answer)
//   agent -> app:  hi(v), ev(n), attached, refused(k)                     (the model's frames)
//                  tool (an app tool call from claude: app_notify_owner, the browser tools)
// Link frames (no session): rpc/rpcResult (machine checks, git sync, upgrade) and blob (a git bundle, in chunks).
import type { HeadConfig } from "../core/agent/head";
import type { StreamItem } from "../core/agent/stream";
import { version as packageVersion } from "../../package.json";

/** The frame protocol's own version (bumped only when frames change incompatibly). */
export const AGENT_PROTOCOL = 1;
/** The agent's version is the app's: the app goes on only with an agent of its own version (Upgrade otherwise). */
export const APP_VERSION: string = process.env.BOTLING_APP_VERSION?.trim() || packageVersion;

/** One entry of a session's event log on the machine (the model's `log`); `ev` frames carry them with their number. */
export type LogEntry =
  /** One item of claude's stream (text, a tool call, its result, the turn's result, …). */
  | { t: "out"; item: StreamItem }
  /** A tool request (`k`: the agent's key for it, the same when a resumed run asks the same thing again). */
  | { t: "ask"; k: string; item: Extract<StreamItem, { kind: "permission" }> }
  /** The user's answer to request k reached the claude that asked. */
  | { t: "ans"; k: string; allow: boolean }
  /** Claude's process ended by itself (its last words are the entries before). */
  | { t: "done"; exit: RemoteExit }
  /** The user cancelled the worker; the agent stopped claude. */
  | { t: "cancelled" };

export interface RemoteExit { code: number | null; signal: string | null; stderr: string; expected: boolean; silent: boolean }

/** What `start` asks the agent to run: the head's config (made for the machine by the agent) and its first words. */
export interface RunSpec {
  config: HeadConfig;
  /** The folder on the machine it works in (from the `worktree` rpc). */
  cwd: string;
  words: string;
  uuid: string;
}

export type DownFrame =
  | { t: "hello"; s: string; g: number; p: number }
  | { t: "attach"; s: string; g: number; from: number }
  | { t: "start"; s: string; g: number; v: string; run: RunSpec }
  | { t: "answer"; s: string; g: number; k: string; allow: boolean; input: Record<string, unknown>; message?: string }
  | { t: "cancel"; s: string; g: number }
  | { t: "send"; s: string; g: number; text: string; uuid: string }
  | { t: "finish"; s: string; g: number }
  | { t: "toolResult"; s: string; g: number; id: string; ok: boolean; result?: unknown; error?: string }
  | { t: "rpc"; id: string; op: string; args: Record<string, unknown> }
  | BlobFrame;

export type UpFrame =
  | { t: "hi"; s: string; g: number; v: string; sha: string }
  | { t: "ev"; s: string; g: number; n: number; e: LogEntry }
  | { t: "attached"; s: string; g: number }
  | { t: "refused"; s: string; g: number; k: string }
  | { t: "tool"; s: string; g: number; id: string; name: string; args: Record<string, unknown> }
  | { t: "rpcResult"; id: string; ok: boolean; result?: unknown; error?: string }
  | BlobFrame;

/** A chunk of a file (a git bundle) sent with an rpc; `data` is base64; the last chunk says `end`. */
export interface BlobFrame { t: "blob"; id: string; seq: number; data: string; end?: boolean }
export const BLOB_CHUNK = 512 * 1024;

/** The agent's home on the machine. */
export const AGENT_HOME_DIR = ".botling-agent";
/** Where the ssh path installs the agent, relative to the remote home. */
export const AGENT_BIN = `${AGENT_HOME_DIR}/bin/botling-agent`;

/** Exit code the agent's launcher uses when node is missing or too old on the machine. */
export const EXIT_NO_NODE = 90;

const SESSION = /^[A-Za-z0-9_-]{1,80}$/;
export const validSession = (s: unknown): s is string => typeof s === "string" && SESSION.test(s);

/** Parses one frame; null when it is not an object with a string `t`. */
export function parseFrame(text: string): Record<string, unknown> & { t: string } | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { t?: unknown }).t !== "string") return null;
  return value as Record<string, unknown> & { t: string };
}

/** Splits a byte stream into JSON lines. */
export class LineReader {
  private buffer = "";
  constructor(private onLine: (line: string) => void) {}
  push(chunk: string) {
    this.buffer += chunk;
    let at: number;
    while ((at = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (line) this.onLine(line);
    }
  }
}
