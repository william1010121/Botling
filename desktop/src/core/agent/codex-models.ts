// The models the local Codex offers (1.x's `CodexModels`): asked of `codex app-server` (`model/list`)
// once per app run, so the Codex model menu lists what this Codex and this account have.
import { spawn } from "node:child_process";
import { childEnvironment } from "./runner";
import { resolveExecutable } from "../process/executable";

export interface CodexModel { id: string; name: string; isDefault: boolean; efforts: string[] | null }

/** The models in a `model/list` response line (`CodexModels.parse`); null for any other line. */
export function parseModelList(line: string): CodexModel[] | null {
  let object: any;
  try { object = JSON.parse(line); } catch { return null; }
  if (!object || object.id !== 2 || !Array.isArray(object.result?.data)) return null;
  return (object.result.data as any[]).flatMap((model): CodexModel[] => {
    if (!model || model.hidden === true || typeof model.id !== "string") return [];
    const efforts = Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts.flatMap((entry: any) => (typeof entry?.reasoningEffort === "string" ? [entry.reasoningEffort] : [])) : null;
    return [{ id: model.id, name: typeof model.displayName === "string" ? model.displayName : model.id, isDefault: model.isDefault === true, efforts }];
  });
}

const LINES = [
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"claudecodebot","version":"1"}}}',
  '{"jsonrpc":"2.0","method":"initialized"}',
  '{"jsonrpc":"2.0","id":2,"method":"model/list","params":{}}',
];

/** Asks once (20 s at most); an empty list when Codex is not there or says nothing. */
export function askModels(command: { file: string; prefixArgs?: string[]; env?: Record<string, string | undefined> }, timeoutMs = 20_000): Promise<CodexModel[]> {
  return new Promise((resolve) => {
    let child;
    try {
      const env = childEnvironment(command.env);
      child = spawn(resolveExecutable(command.file, env), [...(command.prefixArgs ?? []), "app-server"], { env, stdio: ["pipe", "pipe", "ignore"], detached: process.platform !== "win32" });
    } catch { resolve([]); return; }
    let buffer = "";
    let done = false;
    const finish = (models: CodexModel[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* gone */ }
      try { process.platform !== "win32" && child.pid ? process.kill(-child.pid, "SIGTERM") : child.kill(); } catch { /* gone */ }
      resolve(models);
    };
    const timer = setTimeout(() => finish([]), timeoutMs);
    child.on("error", () => finish([]));
    child.on("close", () => finish([]));
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        const models = parseModelList(line);
        if (models) { finish(models); return; }
      }
    });
    child.stdin.write(LINES.join("\n") + "\n");
  });
}

/** Asked once per run: a list that came back is kept. */
export function cachedModels(ask: () => Promise<CodexModel[]>): () => Promise<CodexModel[]> {
  let known: CodexModel[] | null = null;
  return async () => {
    if (known) return known;
    const found = await ask();
    if (found.length) known = found;
    return found;
  };
}
