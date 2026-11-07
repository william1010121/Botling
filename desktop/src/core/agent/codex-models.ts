// The models the local Codex offers (1.x's `CodexModels`): asked of `codex app-server` (`model/list`)
// once per app run, so the Codex model menu lists what this Codex and this account have.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { childEnvironment } from "./runner";
import { resolveExecutable } from "../process/executable";
import { killTree } from "../process/kill-tree";

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
      if (!(child.pid && killTree(child.pid))) { try { child.kill(); } catch { /* gone */ } }
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

// The Codex models a coordinator may start a worker on (app_handoff's `model`): the ones Codex lists in its models
// cache (CODEX_HOME/models_cache.json, else ~/.codex), by slug ("gpt-6-luna"), display name ("GPT-6-Luna") or short
// name ("luna": the newest listed model whose slug ends in it). Read synchronously: a handoff answers at once.

export interface CodexModelEntry { slug: string; displayName: string | null; listed: boolean }

/** Codex's models cache for this environment; null: none or unreadable. */
export function readCodexModels(env: NodeJS.ProcessEnv = process.env): CodexModelEntry[] | null {
  try {
    const data = JSON.parse(readFileSync(join(env.CODEX_HOME || join(homedir(), ".codex"), "models_cache.json"), "utf8"));
    const models = Array.isArray(data?.models) ? data.models : [];
    const entries = models.flatMap((m: any): CodexModelEntry[] => typeof m?.slug === "string" && m.slug
      ? [{ slug: m.slug, displayName: typeof m.display_name === "string" ? m.display_name : null, listed: m.visibility !== "hide" }] : []);
    return entries.length ? entries : null;
  } catch { return null; }
}

const SLUG = /^[a-z0-9][a-z0-9._-]*$/;

/** The model slug `wanted` names, or why it names none (`models` null: no list to check, a slug-shaped name is taken). */
export function resolveCodexModel(wanted: string, models: readonly CodexModelEntry[] | null): { model: string } | { error: string } {
  const name = wanted.trim().toLowerCase();
  if (!models) return SLUG.test(name) ? { model: name } : { error: `Unknown Codex model "${wanted}".` };
  const exact = models.find((m) => m.slug.toLowerCase() === name || m.displayName?.toLowerCase().replace(/\s+/g, "-") === name.replace(/\s+/g, "-"));
  if (exact) return { model: exact.slug };
  const short = models.find((m) => m.listed && name.length > 0 && new RegExp(`[-.]${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(m.slug.toLowerCase()));
  if (short) return { model: short.slug };
  return { error: `Unknown Codex model "${wanted}". Codex offers: ${models.filter((m) => m.listed).map((m) => m.slug).join(", ")}.` };
}
