// The Botling 3 phone page on the relay (the relay's root goes to /v3/): botlingd's durable relay setting
// (`<data>/relay.json`, `botlingd relay set|clear`), the pairing link that names the relay's page when there is no
// tailnet origin, the page pairing through the relay when it was loaded from the relay, and the 2.x import carrying
// the relay address across (never the 2.x room or identity keys).
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  effectiveRelayUrl, readRelaySetting, RELAY_SETTING_FILE, RelaySettingError, relaySettingUrl, writeRelaySetting,
} from "../../src/server/net/relay-setting";
import { pairingAddresses, pairingPageUrl, PLACEHOLDER_TAILNET_ORIGIN } from "../../src/server/botlingd";
import { relayPageOrigin } from "../../src/session";
import { pairsThroughRelay } from "../../web-v3/shell/connection";
import { runImport } from "../../src/server/import/run";
import { botlingdCommand, testRoot } from "../botlingd-harness";
import { make2xFolder } from "../support/fixture-2x";

const roots: string[] = [];
const root = (name: string) => { const dir = testRoot(name); roots.push(dir); return dir; };
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

const RELAY = "wss://relay.example/ws";

describe("relaySettingUrl: the 2.x relay address rules", () => {
  it("takes wss:// anywhere and ws:// only on this machine, ending in /ws", () => {
    expect(relaySettingUrl(" wss://relay.example/ws ")).toBe(RELAY);
    expect(relaySettingUrl("wss://relay.example")).toBe(RELAY);
    expect(relaySettingUrl("wss://relay.example/")).toBe(RELAY);
    expect(relaySettingUrl("ws://127.0.0.1:8080/ws")).toBe("ws://127.0.0.1:8080/ws");
    expect(relaySettingUrl("ws://localhost:9")).toBe("ws://localhost:9/ws");
    for (const bad of [
      "ws://relay.example/ws", "https://relay.example/ws", "wss://u:p@relay.example/ws", "wss://relay.example/ws?x=1",
      "wss://relay.example/ws#k", "wss://relay.example/mobile", "relay.example", "", "off",
    ]) expect(() => relaySettingUrl(bad), bad).toThrow(RelaySettingError);
  });
});

describe("the durable relay setting in the data folder", () => {
  it("writes owner-only JSON, reads it back, and clear removes it", () => {
    const dir = root("relay-setting");
    expect(readRelaySetting(dir)).toBeNull();
    writeRelaySetting(dir, "wss://relay.example");
    const file = join(dir, RELAY_SETTING_FILE);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ url: RELAY });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readRelaySetting(dir)).toBe(RELAY);
    writeRelaySetting(dir, "wss://other.example/ws");
    expect(readRelaySetting(dir)).toBe("wss://other.example/ws");
    writeRelaySetting(dir, null);
    expect(existsSync(file)).toBe(false);
    expect(readRelaySetting(dir)).toBeNull();
    writeRelaySetting(dir, null); // clearing twice is fine
  });

  it("a data folder the setting creates is owner-only", () => {
    const dir = join(root("relay-setting-new"), "data");
    writeRelaySetting(dir, RELAY);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("refuses a bad address before writing anything", () => {
    const dir = root("relay-setting-bad");
    expect(() => writeRelaySetting(dir, "http://relay.example/ws")).toThrow(RelaySettingError);
    expect(existsSync(join(dir, RELAY_SETTING_FILE))).toBe(false);
  });

  it("never follows a symlink at the setting's path, reading or writing", () => {
    const dir = root("relay-setting-link");
    const outside = join(dir, "outside.json");
    writeFileSync(outside, JSON.stringify({ url: "wss://evil.example/ws" }));
    symlinkSync(outside, join(dir, RELAY_SETTING_FILE));
    expect(() => readRelaySetting(dir)).toThrow(RelaySettingError);
    writeRelaySetting(dir, RELAY);
    // The link was replaced by a file; the file it pointed at is untouched.
    expect(lstatSync(join(dir, RELAY_SETTING_FILE)).isFile()).toBe(true);
    expect(JSON.parse(readFileSync(outside, "utf8"))).toEqual({ url: "wss://evil.example/ws" });
    expect(readRelaySetting(dir)).toBe(RELAY);
  });

  it("refuses a malformed file: bad JSON, extra keys, a bad address, a folder, an oversized file", () => {
    const dir = root("relay-setting-malformed");
    const file = join(dir, RELAY_SETTING_FILE);
    for (const text of ["{", "[]", '{"url":"wss://relay.example/ws","roomKey":"x"}', '{"url":"http://relay.example/ws"}', `{"url":"wss://a.example/ws","pad":"${"x".repeat(8_000)}"}`,
      // An address that is valid but not in its plain form (what relay set would have written) is not ours either.
      '{"url":"wss://relay.example"}', '{"url":"wss://RELAY.example/ws"}']) {
      writeFileSync(file, text);
      expect(() => readRelaySetting(dir), text.slice(0, 40)).toThrow(RelaySettingError);
    }
    rmSync(file);
    mkdirSync(file);
    expect(() => readRelaySetting(dir)).toThrow(RelaySettingError);
  });

  it("the environment wins; 'off' turns the relay off; a broken file is logged by name and leaves the relay off", () => {
    const dir = root("relay-setting-effective");
    expect(effectiveRelayUrl({}, dir)).toEqual({ url: null, source: "off" });
    writeRelaySetting(dir, RELAY);
    expect(effectiveRelayUrl({}, dir)).toEqual({ url: RELAY, source: "file" });
    expect(effectiveRelayUrl({ BOTLING_SERVER_RELAY_URL: "ws://127.0.0.1:9/ws" }, dir)).toEqual({ url: "ws://127.0.0.1:9/ws", source: "env" });
    expect(effectiveRelayUrl({ BOTLING_SERVER_RELAY_URL: "off" }, dir)).toEqual({ url: null, source: "env" });
    expect(effectiveRelayUrl({ BOTLING_SERVER_RELAY_URL: "  " }, dir)).toEqual({ url: RELAY, source: "file" });
    writeFileSync(join(dir, RELAY_SETTING_FILE), '{"url":"wss://secret-host.example/ws?k=SECRET"}');
    const lines: string[] = [];
    expect(effectiveRelayUrl({}, dir, (line) => lines.push(line))).toEqual({ url: null, source: "off" });
    expect(lines.join("\n")).toContain(RELAY_SETTING_FILE);
    expect(lines.join("\n")).not.toContain("SECRET");
  });
});

describe("the pairing link and addresses", () => {
  it("names the tailnet page when there is one, else the relay's page, else the placeholder", () => {
    expect(pairingPageUrl("https://mac.tail.ts.net", RELAY)).toBe("https://mac.tail.ts.net/v3/");
    expect(pairingPageUrl(null, RELAY)).toBe("https://relay.example/v3/");
    expect(pairingPageUrl(null, "wss://relay.example:8443/ws")).toBe("https://relay.example:8443/v3/");
    expect(pairingPageUrl(null, "ws://127.0.0.1:8080/ws")).toBe("http://127.0.0.1:8080/v3/");
    expect(pairingPageUrl(null, null)).toBe(`${PLACEHOLDER_TAILNET_ORIGIN}/v3/`);
  });

  it("drops the placeholder tailnet address when the relay carries the device", () => {
    const relay = { url: RELAY, room: "room_1" };
    expect(pairingAddresses("https://mac.tail.ts.net", relay)).toEqual({ tailnet: "https://mac.tail.ts.net", relay });
    expect(pairingAddresses(null, relay)).toEqual({ relay });
    expect(pairingAddresses(null, null)).toEqual({ tailnet: PLACEHOLDER_TAILNET_ORIGIN });
  });

  it("relayPageOrigin is the relay's https origin (http for a local ws relay)", () => {
    expect(relayPageOrigin(RELAY)).toBe("https://relay.example");
    expect(relayPageOrigin("wss://relay.example:8443/ws")).toBe("https://relay.example:8443");
    expect(relayPageOrigin("ws://127.0.0.1:8080/ws")).toBe("http://127.0.0.1:8080");
  });
});

describe("the page pairs through the relay when it was loaded from the relay", () => {
  const relay = { url: RELAY, room: "room_1" };
  it("relay page: through the relay, even with no ?via (a Home Screen app opens /v3/ without it)", () => {
    expect(pairsThroughRelay(null, relay, "https://relay.example")).toBe(true);
    expect(pairsThroughRelay("relay", relay, "https://relay.example")).toBe(true);
  });
  it("tailnet or loopback page: direct, unless ?via=relay asks for the relay", () => {
    expect(pairsThroughRelay(null, relay, "https://mac.tail.ts.net")).toBe(false);
    expect(pairsThroughRelay(null, relay, "http://127.0.0.1:8744")).toBe(false);
    expect(pairsThroughRelay("relay", relay, "https://mac.tail.ts.net")).toBe(true);
  });
  it("never without a relay in the offer, and ?via=tailnet keeps it direct", () => {
    expect(pairsThroughRelay("relay", undefined, "https://relay.example")).toBe(false);
    expect(pairsThroughRelay(null, undefined, "https://relay.example")).toBe(false);
    expect(pairsThroughRelay("tailnet", relay, "https://relay.example")).toBe(false);
  });
});

describe("botlingd relay (CLI)", () => {
  it("shows, sets and clears the relay address in the data folder", () => {
    const dir = root("relay-cli");
    const off = botlingdCommand(dir, ["relay"]);
    expect(off.code, off.stderr).toBe(0);
    expect(off.stdout).toContain("relay: off");

    const set = botlingdCommand(dir, ["relay", "set", "wss://relay.example"]);
    expect(set.code, set.stderr).toBe(0);
    expect(set.stdout).toContain(`relay: ${RELAY}`);
    expect(set.stdout).toContain("next start");
    expect(readRelaySetting(dir)).toBe(RELAY);

    const shown = botlingdCommand(dir, ["relay"]);
    expect(shown.stdout).toContain(`relay: ${RELAY}`);
    expect(shown.stdout).toContain("https://relay.example/v3/");

    const fromEnv = botlingdCommand(dir, ["relay"], { BOTLING_SERVER_RELAY_URL: "off" });
    expect(fromEnv.stdout).toContain("BOTLING_SERVER_RELAY_URL");

    const bad = botlingdCommand(dir, ["relay", "set", "http://relay.example/ws"]);
    expect(bad.code).toBe(2);
    expect(readRelaySetting(dir)).toBe(RELAY);

    const usage = botlingdCommand(dir, ["relay", "nope"]);
    expect(usage.code).toBe(2);

    const cleared = botlingdCommand(dir, ["relay", "clear"]);
    expect(cleared.code, cleared.stderr).toBe(0);
    expect(cleared.stdout).toContain("relay: off");
    expect(readRelaySetting(dir)).toBeNull();
  }, 60_000);

  it("never writes into a Botling 2.x data folder", () => {
    const base = root("relay-cli-2x");
    const src = join(base, "v2");
    make2xFolder(src);
    const refused = botlingdCommand(src, ["relay", "set", RELAY]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("2.x");
    expect(existsSync(join(src, RELAY_SETTING_FILE))).toBe(false);
  }, 60_000);
});

describe("import carries the 2.x relay address (never its keys)", () => {
  const relayJson = (url: string | null) => JSON.stringify({
    url, roomKey: "R".repeat(43), privateKey: "PRIVATEKEYSECRET".repeat(4), publicKey: "P".repeat(43),
  });
  const put2xRelay = (src: string, url: string | null) => {
    mkdirSync(join(src, "mobile"), { recursive: true, mode: 0o700 });
    writeFileSync(join(src, "mobile", "relay.json"), relayJson(url), { mode: 0o600 });
    chmodSync(join(src, "mobile", "relay.json"), 0o600);
  };

  it("sets botlingd's relay from 2.x mobile/relay.json and reports it; the keys stay behind", async () => {
    const base = root("import-relay");
    const src = join(base, "v2");
    const target = join(base, "v3");
    make2xFolder(src);
    put2xRelay(src, "wss://relay.example/ws");
    const result = await runImport({ sourceDir: src, targetDir: target });
    expect(readRelaySetting(target)).toBe(RELAY);
    const stored = readFileSync(join(target, RELAY_SETTING_FILE), "utf8");
    expect(stored).not.toContain("PRIVATEKEY");
    expect(stored).not.toContain("R".repeat(43));
    expect(result.reportText).toContain(`Phone relay: ${RELAY}`);
    expect(result.reportText).not.toContain("PRIVATEKEY");
  }, 120_000);

  it("keeps a relay already set in Botling 3, and a dry run writes nothing", async () => {
    const base = root("import-relay-kept");
    const src = join(base, "v2");
    const target = join(base, "v3");
    make2xFolder(src);
    put2xRelay(src, "wss://relay.example/ws");
    const dry = await runImport({ sourceDir: src, targetDir: target, dryRun: true });
    expect(existsSync(join(target, RELAY_SETTING_FILE))).toBe(false);
    expect(dry.reportText).toContain(`Phone relay: ${RELAY}`);
    mkdirSync(target, { recursive: true });
    writeRelaySetting(target, "wss://mine.example/ws");
    const result = await runImport({ sourceDir: src, targetDir: target });
    expect(readRelaySetting(target)).toBe("wss://mine.example/ws");
    expect(result.reportText).toContain("Phone relay: wss://mine.example/ws (already set; 2.x had wss://relay.example/ws)");
  }, 120_000);

  it("never follows a link: a symlinked 2.x mobile folder or relay.json carries nothing", async () => {
    for (const kind of ["folder", "file"] as const) {
      const base = root(`import-relay-link-${kind}`);
      const src = join(base, "v2");
      const target = join(base, "v3");
      const outside = join(base, "outside");
      make2xFolder(src);
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "relay.json"), relayJson("wss://evil.example/ws"));
      if (kind === "folder") symlinkSync(outside, join(src, "mobile"));
      else { mkdirSync(join(src, "mobile")); symlinkSync(join(outside, "relay.json"), join(src, "mobile", "relay.json")); }
      const result = await runImport({ sourceDir: src, targetDir: target });
      expect(readRelaySetting(target), kind).toBeNull();
      expect(result.problems.join("\n"), kind).toContain("phone relay: not carried");
      expect(result.reportText, kind).not.toContain("evil.example");
    }
  }, 240_000);

  it("no relay.json, a relay that was off, or a bad address: nothing is set", async () => {
    for (const url of [undefined, null, "http://relay.example/ws"] as const) {
      const base = root("import-relay-none");
      const src = join(base, "v2");
      const target = join(base, "v3");
      make2xFolder(src);
      if (url !== undefined) put2xRelay(src, url);
      const result = await runImport({ sourceDir: src, targetDir: target });
      expect(readRelaySetting(target), String(url)).toBeNull();
      if (url === "http://relay.example/ws") expect(result.problems.join("\n")).toContain("relay");
    }
  }, 240_000);
});
