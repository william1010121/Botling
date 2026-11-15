// botlingd's test hooks and setup helpers (M7-S20): the corrupt-content and server-origin test hooks, the sole-server VAPID key
// check and `outDirOf`. Moved out of `botlingd.ts` unchanged (`startOriginTestHook` is now exported); `botlingd.ts` re-exports
// every name.
import { appendFileSync, existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Command } from "../contract";
import type { Target } from "../protocol";
import type { ServerOrigin } from "./forward";
import { ensureVapidKeys, readVapidKeys, revokedServerIds } from "./identity";
import type { RosterStore } from "./roster";

/**
 * Test hook (M3 step 10): `BOTLING_SERVER_TEST_CORRUPT_CONTENT=sha256:<hex>` makes this server flip one byte in every
 * chunk of that content it sends to a peer, so a test can show the attached server refuses it. Unset in real use.
 */
export const TEST_CORRUPT_CONTENT_ENV = "BOTLING_SERVER_TEST_CORRUPT_CONTENT";
export function testCorruptContent(env: Record<string, string | undefined>): string | null {
  const value = (env[TEST_CORRUPT_CONTENT_ENV] ?? "").trim();
  return /^sha256:[0-9a-f]{64}$/.test(value) ? value : null;
}


/** Test hook (M5-04a): requires `BOTLING_AGENT=fake` and both test flags (`BOTLING_SERVER_TEST_ORIGIN_HOOK=1` and `BOTLING_SERVER_TEST_ORIGIN_HOOK_ALLOW=1`). */
export const TEST_ORIGIN_HOOK_ENV = "BOTLING_SERVER_TEST_ORIGIN_HOOK";
export const TEST_ORIGIN_HOOK_ALLOW_ENV = "BOTLING_SERVER_TEST_ORIGIN_HOOK_ALLOW";
export function originTestHookEnabled(env: Record<string, string | undefined>): boolean {
  return env.BOTLING_AGENT === "fake"
    && env[TEST_ORIGIN_HOOK_ENV] === "1"
    && env[TEST_ORIGIN_HOOK_ALLOW_ENV] === "1";
}
export function startOriginTestHook(dataDir: string, serverOrigin: ServerOrigin, log: (line: string) => void): () => void {
  const reqDir = join(dataDir, "test-server-origin-requests");
  const submittedFile = join(dataDir, "test-server-origin-submitted.jsonl");
  const outcomesFile = join(dataDir, "test-server-origin-outcomes.jsonl");
  const off = serverOrigin.on((slot, outcome) => {
    try { appendFileSync(outcomesFile, `${JSON.stringify({ slot, outcome })}\n`, { mode: 0o600 }); } catch (error) {
      log(`server-origin hook: writing outcome failed: ${String((error as Error)?.message ?? error)}`);
    }
  });
  let busy = false;
  const poll = () => {
    if (busy || !existsSync(reqDir)) return;
    busy = true;
    void (async () => {
      try {
        for (const name of readdirSync(reqDir).filter((f) => f.endsWith(".json")).sort()) {
          const full = join(reqDir, name);
          let raw: string;
          try { raw = readFileSync(full, "utf8"); unlinkSync(full); } catch { continue; }
          let req: { id?: unknown; target?: unknown; cmd?: unknown } | null = null;
          try {
            req = JSON.parse(raw) as { id?: unknown; target?: unknown; cmd?: unknown };
            if (!req || typeof req.id !== "string" || typeof req.target !== "string" || !req.cmd || typeof req.cmd !== "object") {
              throw new TypeError("malformed server-origin test hook request");
            }
            const slot = await serverOrigin.submit(req.target as Target, req.cmd as Command);
            appendFileSync(submittedFile, `${JSON.stringify({ id: req.id, slot })}\n`, { mode: 0o600 });
          } catch (error) {
            if (req && typeof req.id === "string") {
              appendFileSync(submittedFile, `${JSON.stringify({ id: req.id, error: String((error as Error)?.message ?? error) })}\n`, { mode: 0o600 });
            } else {
              log(`server-origin hook: bad request ${name}: ${String((error as Error)?.message ?? error)}`);
            }
          }
        }
      } finally {
        busy = false;
      }
    })();
  };
  const timer = setInterval(poll, 25);
  timer.unref();
  return () => { clearInterval(timer); off(); };
}

export interface VapidSyncState {
  known: boolean;
  warnedMissing: boolean;
}

/** True when this server belongs to a cluster and is the sole server member in the current roster view (M4-25 F4). */
export function isSoleServerInRoster(roster: Pick<RosterStore, "clusterId" | "memberId" | "view">): boolean {
  if (!roster.clusterId) return false;
  const servers = roster.view.servers;
  return servers.size === 1 && servers.has(roster.memberId);
}

/**
 * Ensures `vapid-keys.json` exists only when this server is the sole server in the cluster roster (M4-25 F4).
 * In a multi-server cluster, a missing or unreadable key file fails closed (logs once, leaves Web Push disabled)
 * instead of minting a divergent pair that would desync from peers.
 */
export async function ensureSoleServerVapidKeys(
  dataDir: string,
  roster: Pick<RosterStore, "clusterId" | "memberId" | "view">,
  log: (line: string) => void,
  state: VapidSyncState,
): Promise<boolean> {
  if (!roster.clusterId) return false;
  if (state.known) return true;
  if (readVapidKeys(dataDir)) {
    state.known = true;
    state.warnedMissing = false;
    return true;
  }
  const root = roster.view.root;
  if (isSoleServerInRoster(roster) && !root) {
    // No valid root chain: the gen is unknown, so do not mint a gen-1 pair (fail closed, retried on the next call).
    if (!state.warnedMissing) {
      state.warnedMissing = true;
      log("vapid: the cluster root is not known yet; leaving Web Push disabled on this server");
    }
    return false;
  }
  if (isSoleServerInRoster(roster) && root) {
    // Same (gen, covers) as the first server pairing (pairing/join.ts), so VapidKeySync does not rotate it again.
    await ensureVapidKeys(dataDir, { gen: root.gen, covers: revokedServerIds(roster.view) });
    state.known = true;
    state.warnedMissing = false;
    return true;
  }
  if (!state.warnedMissing) {
    state.warnedMissing = true;
    log("vapid: cluster vapid-keys.json is missing or invalid in a multi-server cluster; leaving Web Push disabled on this server");
  }
  return false;
}

/** Where the built server's out/ folder is: `<out>/server/main.cjs` → `<out>`. */
export function outDirOf(script: string): string {
  return dirname(dirname(script));
}
