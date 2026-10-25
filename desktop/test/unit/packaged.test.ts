// Phase 5b: a packaged build ignores the variables tests steer the app with (src/main/packaged.ts).
import { describe, expect, it } from "vitest";
import { isTestOnly, scrubEnvironment } from "../../src/main/packaged";

describe("packaged environment", () => {
  it("drops every test-only variable and runs the real heads, not harmless", () => {
    const env: Record<string, string | undefined> = {
      BOTLING_AGENT: "fake", BOTLING_FAKE_CLI: "/x/fake-claude.mjs", BOTLING_FAKE_CODEX: "/x/fake-codex.mjs",
      BOTLING_TEST_WEB_SITES: "[]", BOTLING_TEST_PICK: "[\"/etc/passwd\"]", BOTLING_TEST_PICK_FOLDER: "/", BOTLING_TEST_SEAL_KEY: "k",
      BOTLING_TEST_FIRST_SNAPSHOT_MS: "100", BOTLING_TEST_UPDATE_FEED: "http://127.0.0.1/feed", FAKE_CLAUDE_INPUT: "/tmp/x", FAKE_CODEX_JUDGE: "1",
      BOTLING_MOCK_KEYCHAIN: "1", BOTLING_NO_EXTERNAL: "1", BOTLING_HIDDEN: "1", BOTLING_QUIET: "1", BOTLING_QUIT_ON_CLOSE: "1",
      BOTLING_HARMLESS: "1", BOTLING_HARMLESS_TOOLS: "Bash", BOTLING_PLUGIN_HOST: "node", BOTLING_PLAIN_SHELL: "1",
      BOTLING_SHOT_COMMAND: "rm -rf ~", BOTLING_CHECK_COMMAND: "rm -rf ~", ELECTRON_RUN_AS_NODE: "1",
      // Kept: the user's own knobs.
      BOTLING_DATA_DIR: "/data", BOTLING_IMPORT_FROM: "", BOTLING_CLAUDE_PATH: "/bin/claude", BOTLING_CODEX_PATH: "/bin/codex",
      BOTLING_IDLE_MS: "1000", BOTLING_NODE_PATH: "/opt/node", PATH: "/usr/bin", HOME: "/Users/x",
    };
    const dropped = scrubEnvironment(env, true);
    expect(env).toEqual({
      BOTLING_AGENT: "claude", BOTLING_HARMLESS: "0",
      BOTLING_DATA_DIR: "/data", BOTLING_IMPORT_FROM: "", BOTLING_CLAUDE_PATH: "/bin/claude", BOTLING_CODEX_PATH: "/bin/codex",
      BOTLING_IDLE_MS: "1000", BOTLING_NODE_PATH: "/opt/node", PATH: "/usr/bin", HOME: "/Users/x",
    });
    expect(dropped).toContain("BOTLING_AGENT");
    expect(dropped).toContain("BOTLING_TEST_WEB_SITES");
    expect(dropped).toContain("FAKE_CLAUDE_INPUT");
    expect(dropped).not.toContain("BOTLING_DATA_DIR");
  });

  it("leaves a development run as it is", () => {
    const env = { BOTLING_AGENT: "fake", BOTLING_TEST_WEB_SITES: "[]", BOTLING_MOCK_KEYCHAIN: "1" };
    expect(scrubEnvironment(env, false)).toEqual([]);
    expect(env).toEqual({ BOTLING_AGENT: "fake", BOTLING_TEST_WEB_SITES: "[]", BOTLING_MOCK_KEYCHAIN: "1" });
  });

  it("knows the test-only names", () => {
    for (const key of ["BOTLING_TEST_ANYTHING", "FAKE_ANYTHING", "BOTLING_FAKE_CLI", "BOTLING_HIDDEN"]) expect(isTestOnly(key), key).toBe(true);
    for (const key of ["BOTLING_DATA_DIR", "BOTLING_MODEL", "BOTLING_CODEX_EFFORT", "PATH"]) expect(isTestOnly(key), key).toBe(false);
  });
});
