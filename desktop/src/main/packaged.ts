// What a packaged build (electron-builder, Phase 5b) does differently from a development run, kept
// apart from main.ts so the unit tests can check it without Electron.
//
// Tests and `npm run dev*` steer the app with environment variables: a fake CLI, local pages shown
// as web AIs, answered file pickers, a mock keychain, commands handed to Maintainer.
// A packaged app must not be steerable that way by whatever environment it was started from, so
// main drops those variables before it reads any of them, and the core never sees them.

// BOTLING_HIDDEN is operational background mode, not a test authority bypass; keep it when packaged.
/** Variables only tests and development runs mean (exact names). */
export const TEST_ONLY = new Set([
  "BOTLING_FAKE_CLI", "BOTLING_FAKE_CODEX", // the fake CLIs (not shipped)
  "BOTLING_MOCK_KEYCHAIN", // safeStorage on Chromium's mock keychain
  "BOTLING_NO_EXTERNAL", // links are only noted, never opened
  "BOTLING_QUIET", "BOTLING_QUIT_ON_CLOSE", // the e2e window and logs
  "BOTLING_HARMLESS", "BOTLING_HARMLESS_TOOLS", // `npm run dev`'s safe mode for the real CLI
  "BOTLING_PLUGIN_HOST", // the plugin host as a Node child (Electron as Node needs the RunAsNode fuse)
  "BOTLING_PLAIN_SHELL", // component commands without the login shell
  // Commands main hands Maintainer: always this build's own, never one from the environment.
  "BOTLING_SHOT_COMMAND", "BOTLING_CHECK_COMMAND",
  "ELECTRON_RUN_AS_NODE", // has no effect with the fuse off; not passed on either
]);
/** Prefixes of test-only variables: BOTLING_TEST_* (pickers, web sites, sealing key, update feed…) and the fakes' FAKE_*. */
export const TEST_ONLY_PREFIXES = ["BOTLING_TEST_", "FAKE_"];

export function isTestOnly(key: string): boolean {
  return TEST_ONLY.has(key) || TEST_ONLY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Drops the test-only variables from `env` (in place) when packaged, and sets what a packaged app
 * always is: the real `claude`/`codex` heads (`BOTLING_AGENT=claude`; there is no fake CLI to run, and
 * not `npm run dev`'s harmless mode). Returns the names it dropped (for the log). Development runs
 * are left as they are.
 */
export function scrubEnvironment(env: Record<string, string | undefined>, packaged: boolean): string[] {
  if (!packaged) return [];
  const dropped: string[] = [];
  for (const key of Object.keys(env)) {
    if (isTestOnly(key)) {
      dropped.push(key);
      delete env[key];
    }
  }
  if (env.BOTLING_AGENT !== undefined && env.BOTLING_AGENT !== "claude") dropped.push("BOTLING_AGENT");
  env.BOTLING_AGENT = "claude";
  // A real bot, as 1.x: tools asked about, CLAUDE.md, MCP and saved sessions (the core's default is harmless).
  env.BOTLING_HARMLESS = "0";
  return dropped.sort();
}
