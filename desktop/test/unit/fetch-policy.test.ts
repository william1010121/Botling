import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { classify, DENY, isDeniedPath, Limits, realInside, type FetchWhat } from "../../src/server/fetch";
import type { EntryRef } from "../../src/protocol";
import type { FetchWhat as ProtocolFetchWhat } from "../../src/protocol/fetch";

const ENTRY: EntryRef = { stream: "bot:bot-a", seq: 1 };
const BLOB_ID = "sha256:" + "a".repeat(64);
const realpath = realpathSync.native ?? realpathSync;

describe("fetch policy (M5-06a)", () => {
  let root: string;
  let botA: string;
  let artifactsA: string;
  let dataDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "botling-fetch-policy-"));
    botA = join(root, "bots", "bot-a");
    artifactsA = join(botA, ".bot", "artifacts");
    dataDir = join(root, "botling-data");
    mkdirSync(artifactsA, { recursive: true });
    mkdirSync(join(botA, "src"), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(artifactsA, "report.html"), "<h1>ok</h1>");
    writeFileSync(join(botA, "src", "main.ts"), "export const x = 1;\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("1. classifies bot artifacts as free and other bot files as ask", () => {
    const botFolders = new Map<string, string>([["bot-a", botA]]);
    const referenced = () => false;

    const byArtifact = classify({
      what: { kind: "artifact", botId: "bot-a", path: "report.html" },
      botFolders,
      referenced,
      dataDir,
    });
    expect(byArtifact.kind).toBe("free");

    const byArtifactAbs = classify({
      what: { kind: "artifact", botId: "bot-a", path: join(artifactsA, "report.html") },
      botFolders,
      referenced,
      dataDir,
    });
    expect(byArtifactAbs.kind).toBe("free");

    const byPathArtifact = classify({
      what: { kind: "path", path: join(artifactsA, "report.html") },
      botFolders,
      referenced,
      dataDir,
    });
    expect(byPathArtifact.kind).toBe("free");

    const byPathSrc = classify({
      what: { kind: "path", path: join(botA, "src", "main.ts") },
      botFolders,
      referenced,
      dataDir,
    });
    expect(byPathSrc.kind).toBe("ask");

    const byGit = classify({
      what: { kind: "git", path: botA },
      botFolders,
      referenced,
      dataDir,
    });
    expect(byGit.kind).toBe("ask");

    // artifact kind pointing outside .bot/artifacts/ (not on deny-list) is denied as outside
    const artifactEscape = classify({
      what: { kind: "artifact", botId: "bot-a", path: "../../src/main.ts" },
      botFolders,
      referenced,
      dataDir,
    });
    expect(artifactEscape).toEqual({ kind: "denied", reason: "outside" });

    // unknown botId for artifact kind is denied as outside
    const unknownBot = classify({
      what: { kind: "artifact", botId: "bot-unknown", path: "report.html" },
      botFolders,
      referenced,
      dataDir,
    });
    expect(unknownBot).toEqual({ kind: "denied", reason: "outside" });
  });

  it("2. denies a symlink inside .bot/artifacts/ pointing to .ssh as deny-list, plus other DENY patterns", () => {
    const botFolders = new Map<string, string>([["bot-a", botA]]);
    const referenced = () => false;

    const fakeSsh = join(root, "home", ".ssh");
    const fakeSshSub = join(fakeSsh, "sub");
    mkdirSync(fakeSshSub, { recursive: true });
    writeFileSync(join(fakeSsh, "config"), "Host *");
    writeFileSync(join(fakeSsh, "id_ed25519"), "secret");

    const symlinkInArtifacts = join(artifactsA, "ssh-link");
    symlinkSync(fakeSsh, symlinkInArtifacts);

    const symlinkSubInArtifacts = join(artifactsA, "ssh-sub-link");
    symlinkSync(fakeSshSub, symlinkSubInArtifacts);

    expect(classify({
      what: { kind: "artifact", botId: "bot-a", path: "ssh-link" },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "denied", reason: "deny-list" });

    expect(classify({
      what: { kind: "artifact", botId: "bot-a", path: "ssh-link/id_ed25519" },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "denied", reason: "deny-list" });

    // `..` after a symlink must follow the symlink first, not collapse lexically
    expect(classify({
      what: { kind: "artifact", botId: "bot-a", path: "ssh-sub-link/../config" },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "denied", reason: "deny-list" });

    expect(classify({
      what: { kind: "path", path: join(symlinkInArtifacts, "config") },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "denied", reason: "deny-list" });

    // Dangling symlink and NUL bytes fail closed as outside
    const dangling = join(artifactsA, "dangling");
    symlinkSync(join(root, "does-not-exist"), dangling);
    expect(classify({
      what: { kind: "artifact", botId: "bot-a", path: "dangling" },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "denied", reason: "outside" });

    expect(classify({
      what: { kind: "path", path: join(artifactsA, "bad\0path") },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "denied", reason: "outside" });

    // Other deny-list patterns on real paths (even when placed inside .bot/artifacts/)
    const deniedPaths = [
      join(root, "u", ".gnupg", "pubring.kbx"),
      join(root, "u", ".aws", "credentials"),
      join(root, "u", ".kube", "config"),
      join(root, "u", "Library", "Keychains", "login.keychain-db"),
      join(root, "u", "Custom", "my.keychain"),
      join(root, "u", "Custom", "my.keychain-db"),
      join(root, "u", "Library", "Application Support", "Google", "Chrome", "Default", "Cookies"),
      join(root, "u", "Library", "Application Support", "Firefox", "Profiles", "p1"),
      join(root, "u", "Library", "Application Support", "Safari", "Bookmarks.plist"),
      join(root, "u", ".mozilla", "firefox", "prefs.js"),
      join(root, "u", ".config", "google-chrome", "Default", "Login Data"),
      join(root, "u", ".config", "chromium", "Default", "Login Data"),
      join(artifactsA, "id_rsa"),
      join(artifactsA, "id_rsa.pub"),
      join(artifactsA, "id_ed25519_work"),
      join(artifactsA, "cert.pem"),
      join(artifactsA, "private.key"),
    ];

    for (const p of deniedPaths) {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, "x");
      expect(isDeniedPath(p, dataDir)).toBe(true);
      expect(classify({
        what: { kind: "path", path: p },
        botFolders,
        referenced,
        dataDir,
      })).toEqual({ kind: "denied", reason: "deny-list" });
    }

    // Sibling names that must NOT false-positive
    const allowedArtifact = join(artifactsA, "ssh-guide.md");
    writeFileSync(allowedArtifact, "# ssh");
    expect(isDeniedPath(allowedArtifact, dataDir)).toBe(false);
    expect(classify({
      what: { kind: "artifact", botId: "bot-a", path: "ssh-guide.md" },
      botFolders,
      referenced,
      dataDir,
    }).kind).toBe("free");
  });

  it("3. realInside checks symlink escape, prefix+-other, and .. paths on separator boundaries", () => {
    const prefix = join(root, "prefix");
    const sibling = join(root, "prefix-other");
    const outside = join(root, "outside");
    mkdirSync(join(prefix, "nested"), { recursive: true });
    mkdirSync(sibling, { recursive: true });
    mkdirSync(outside, { recursive: true });

    const insideFile = join(prefix, "nested", "a.txt");
    const siblingFile = join(sibling, "b.txt");
    const outsideFile = join(outside, "c.txt");
    writeFileSync(insideFile, "a");
    writeFileSync(siblingFile, "b");
    writeFileSync(outsideFile, "c");

    const escapingSymlink = join(prefix, "escape");
    symlinkSync(outsideFile, escapingSymlink);

    const prefixSymlink = join(root, "prefix-alias");
    symlinkSync(prefix, prefixSymlink);

    expect(realInside(prefix, prefix)).toBe(true);
    expect(realInside(prefix, insideFile)).toBe(true);
    expect(realInside(prefixSymlink, insideFile)).toBe(true);

    expect(realInside(prefix, escapingSymlink)).toBe(false);
    expect(realInside(prefix, sibling)).toBe(false);
    expect(realInside(prefix, siblingFile)).toBe(false);
    expect(realInside(prefix, join(prefix, "..", "outside", "c.txt"))).toBe(false);
    expect(realInside(prefix, join(prefix, "does-not-exist.txt"))).toBe(false);
  });

  it("4. classifies referenced blobs as free and unreferenced blobs as ask", () => {
    const botFolders = new Map<string, string>([["bot-a", botA]]);
    const what: FetchWhat = { kind: "blob", id: BLOB_ID, entry: ENTRY };

    const free = classify({
      what,
      botFolders,
      referenced: (id, entry) => id === BLOB_ID && entry.stream === ENTRY.stream && entry.seq === ENTRY.seq,
      dataDir,
    });
    expect(free.kind).toBe("free");

    const ask = classify({
      what,
      botFolders,
      referenced: () => false,
      dataDir,
    });
    expect(ask.kind).toBe("ask");
  });

  it("5. denies Botling dataDir and any folder holding a server.db", () => {
    const botFolders = new Map<string, string>([["bot-a", botA]]);
    const referenced = () => false;

    const dataFile = join(dataDir, "prefs.json");
    writeFileSync(dataFile, "{}");

    expect(classify({
      what: { kind: "path", path: dataDir },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "denied", reason: "deny-list" });

    expect(classify({
      what: { kind: "path", path: dataFile },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "denied", reason: "deny-list" });

    // Symlink inside .bot/artifacts/ pointing to dataDir
    const dataLink = join(artifactsA, "data-link");
    symlinkSync(dataFile, dataLink);
    expect(classify({
      what: { kind: "artifact", botId: "bot-a", path: "data-link" },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "denied", reason: "deny-list" });

    // Sibling folder named botling-data-other is NOT denied
    const dataOther = join(root, "botling-data-other");
    mkdirSync(dataOther, { recursive: true });
    writeFileSync(join(dataOther, "ok.txt"), "ok");
    expect(classify({
      what: { kind: "path", path: join(dataOther, "ok.txt") },
      botFolders,
      referenced,
      dataDir,
    }).kind).toBe("ask");

    // Any folder holding server.db (and files inside it, plus symlinks to it)
    const otherDbDir = join(root, "other-server");
    mkdirSync(join(otherDbDir, "blobs"), { recursive: true });
    writeFileSync(join(otherDbDir, "server.db"), "sqlite");
    writeFileSync(join(otherDbDir, "blobs", "b1"), "bytes");

    const dbLink = join(artifactsA, "db-link");
    symlinkSync(join(otherDbDir, "blobs", "b1"), dbLink);

    expect(classify({
      what: { kind: "path", path: otherDbDir },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "denied", reason: "deny-list" });

    expect(classify({
      what: { kind: "path", path: join(otherDbDir, "server.db") },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "denied", reason: "deny-list" });

    expect(classify({
      what: { kind: "path", path: join(otherDbDir, "blobs", "b1") },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "denied", reason: "deny-list" });

    expect(classify({
      what: { kind: "artifact", botId: "bot-a", path: "db-link" },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "denied", reason: "deny-list" });
  });

  it("exports Limits constants and DENY pattern list", () => {
    expect(Limits.PER_REQUEST_BYTES).toBe(500 * 2 ** 20);
    expect(Limits.PER_REQUEST_FILES).toBe(20_000);
    expect(Limits.PER_DAY_BYTES_PER_BOT).toBe(2 * 2 ** 30);
    expect(Array.isArray(DENY)).toBe(true);
    expect(DENY.length).toBeGreaterThan(0);
  });

  it("R1. artifacts symlink outside botFolder downgrades free to ask, while symlinked botFolder stays free", () => {
    const referenced = () => false;

    // Case A: .bot/artifacts is a symlink pointing outside botFolder (e.g., home folder)
    const externalHome = join(root, "external-home");
    mkdirSync(join(externalHome, "Documents"), { recursive: true });
    const taxPdf = join(externalHome, "Documents", "tax.pdf");
    writeFileSync(taxPdf, "pdf-bytes");

    const botWithSymlinkArtifacts = join(root, "bots", "bot-symlink-artifacts");
    mkdirSync(join(botWithSymlinkArtifacts, ".bot"), { recursive: true });
    const linkedArtifacts = join(botWithSymlinkArtifacts, ".bot", "artifacts");
    symlinkSync(externalHome, linkedArtifacts);

    const botFolders = new Map<string, string>([["bot-sym", botWithSymlinkArtifacts]]);

    // Both `artifact` and `path` requests must return `ask` (never `free`)
    expect(classify({
      what: { kind: "artifact", botId: "bot-sym", path: "Documents/tax.pdf" },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "ask", prefix: realpath(taxPdf) });

    expect(classify({
      what: { kind: "path", path: taxPdf },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "ask", prefix: realpath(taxPdf) });

    expect(classify({
      what: { kind: "path", path: join(linkedArtifacts, "Documents", "tax.pdf") },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "ask", prefix: realpath(taxPdf) });

    // Escaping the symlinked artifacts folder via `..` still returns `outside`
    const outsideSecret = join(root, "outside-secret.txt");
    writeFileSync(outsideSecret, "secret");
    expect(classify({
      what: { kind: "artifact", botId: "bot-sym", path: "../outside-secret.txt" },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "denied", reason: "outside" });

    // Case B: .bot itself is a symlink to an external disk -> artifacts get `ask`
    const externalBotDot = join(root, "external-disk", ".bot");
    mkdirSync(join(externalBotDot, "artifacts"), { recursive: true });
    const extReport = join(externalBotDot, "artifacts", "ext.html");
    writeFileSync(extReport, "ok");

    const botWithSymlinkDot = join(root, "bots", "bot-symlink-dot");
    mkdirSync(botWithSymlinkDot, { recursive: true });
    symlinkSync(externalBotDot, join(botWithSymlinkDot, ".bot"));
    const dotFolders = new Map<string, string>([["bot-dot", botWithSymlinkDot]]);

    expect(classify({
      what: { kind: "artifact", botId: "bot-dot", path: "ext.html" },
      botFolders: dotFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "ask", prefix: realpath(extReport) });

    // Case C: botFolder itself is a symlink (probe P10) -> artifacts inside it stay `free`
    const botAlias = join(root, "bots", "bot-a-alias");
    symlinkSync(botA, botAlias);
    const aliasFolders = new Map<string, string>([["bot-alias", botAlias]]);

    expect(classify({
      what: { kind: "artifact", botId: "bot-alias", path: "report.html" },
      botFolders: aliasFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "free", prefix: realpath(artifactsA) });

    expect(classify({
      what: { kind: "path", path: join(botAlias, ".bot", "artifacts", "report.html") },
      botFolders: aliasFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "free", prefix: realpath(artifactsA) });
  });

  it("R2. isDeniedPath fails closed (true) on resolution failures while classify returns outside for unresolvable paths", () => {
    const dangling = join(artifactsA, "dangling-for-deny");
    symlinkSync(join(root, "missing-target"), dangling);

    expect(isDeniedPath(dangling, dataDir)).toBe(true);
    expect(isDeniedPath("relative/path.txt", dataDir)).toBe(true);
    expect(isDeniedPath("", dataDir)).toBe(true);
    expect(isDeniedPath(join(artifactsA, "bad\0path"), dataDir)).toBe(true);
    // Construct without path.join collapsing `..` lexically
    expect(isDeniedPath(`${artifactsA}${sep}missing-sub${sep}..${sep}x`, dataDir)).toBe(true);

    // Unknown botId with an unresolvable absolute path must still return `outside`, not `deny-list`
    const botFolders = new Map<string, string>([["bot-a", botA]]);
    expect(classify({
      what: { kind: "artifact", botId: "bot-unknown", path: dangling },
      botFolders,
      referenced: () => false,
      dataDir,
    })).toEqual({ kind: "denied", reason: "outside" });
  });

  it("R3. walk-up fallback runs only for ENOENT; EACCES and ENOTDIR return null -> outside / isDeniedPath true", () => {
    const botFolders = new Map<string, string>([["bot-a", botA]]);
    const referenced = () => false;

    // ENOTDIR: treating a regular file as a directory must fail closed
    const regularFile = join(botA, "src", "main.ts");
    const throughFile = join(regularFile, "child.txt");
    expect(isDeniedPath(throughFile, dataDir)).toBe(true);
    expect(classify({
      what: { kind: "path", path: throughFile },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "denied", reason: "outside" });

    // EACCES: directory without search permission must NOT fall back to joining segments
    const lockedDir = join(root, "locked-dir");
    const lockedInner = join(lockedDir, "secret.txt");
    mkdirSync(lockedDir, { recursive: true });
    writeFileSync(lockedInner, "hidden");
    chmodSync(lockedDir, 0o000);
    try {
      // Skip only if running as root where chmod 000 still allows traversal
      let eaccesTriggered = false;
      try {
        realpath(lockedInner);
      } catch (err) {
        eaccesTriggered = (err as NodeJS.ErrnoException).code === "EACCES";
      }
      if (eaccesTriggered) {
        expect(isDeniedPath(lockedInner, dataDir)).toBe(true);
        expect(classify({
          what: { kind: "path", path: lockedInner },
          botFolders,
          referenced,
          dataDir,
        })).toEqual({ kind: "denied", reason: "outside" });
      }
    } finally {
      chmodSync(lockedDir, 0o755);
    }

    // ENOENT: missing path under an existing safe parent still resolves and classifies as ask
    const missingSafe = join(botA, "src", "not-created-yet.ts");
    expect(isDeniedPath(missingSafe, dataDir)).toBe(false);
    expect(classify({
      what: { kind: "path", path: missingSafe },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "ask", prefix: realpath(join(botA, "src")) + sep + "not-created-yet.ts" });
  });

  it("R4. throws when dataDir is not an absolute path", () => {
    const safeFile = join(botA, "src", "main.ts");
    const botFolders = new Map<string, string>([["bot-a", botA]]);

    expect(() => isDeniedPath(safeFile, "relative/data")).toThrow();
    expect(() => isDeniedPath(safeFile, "")).toThrow();
    expect(() => classify({
      what: { kind: "path", path: safeFile },
      botFolders,
      referenced: () => false,
      dataDir: "relative/data",
    })).toThrow();
    expect(() => classify({
      what: { kind: "blob", id: BLOB_ID, entry: ENTRY },
      botFolders,
      referenced: () => false,
      dataDir: "",
    })).toThrow();
  });

  it("R5. missing or dangling artifactsDir returns outside instead of throwing out of classify", () => {
    const botNoArtifacts = join(root, "bots", "bot-no-artifacts");
    mkdirSync(join(botNoArtifacts, "src"), { recursive: true });
    writeFileSync(join(botNoArtifacts, "src", "main.ts"), "export {};\n");

    const botDanglingArtifacts = join(root, "bots", "bot-dangling-artifacts");
    mkdirSync(join(botDanglingArtifacts, ".bot"), { recursive: true });
    symlinkSync(join(root, "missing-artifacts-target"), join(botDanglingArtifacts, ".bot", "artifacts"));

    const botFolders = new Map<string, string>([
      ["bot-none", botNoArtifacts],
      ["bot-dangling", botDanglingArtifacts],
    ]);
    const referenced = () => false;

    expect(classify({
      what: { kind: "artifact", botId: "bot-none", path: "report.html" },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "denied", reason: "outside" });

    expect(classify({
      what: { kind: "artifact", botId: "bot-none", path: "" },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "denied", reason: "outside" });

    expect(classify({
      what: { kind: "artifact", botId: "bot-dangling", path: "report.html" },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "denied", reason: "outside" });

    expect(classify({
      what: { kind: "artifact", botId: "bot-dangling", path: "" },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "denied", reason: "outside" });

    expect(classify({
      what: { kind: "path", path: join(botNoArtifacts, "src", "main.ts") },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "ask", prefix: realpath(join(botNoArtifacts, "src", "main.ts")) });
  });

  it("R6. denies newly added DENY patterns (.env*, id_ecdsa*, id_dsa*, .netrc, .docker, gcloud, Brave/Edge/Arc)", () => {
    const botFolders = new Map<string, string>([["bot-a", botA]]);
    const referenced = () => false;

    const newDeniedPaths = [
      join(artifactsA, ".env"),
      join(artifactsA, "case-env", ".ENV"),
      join(artifactsA, ".env.local"),
      join(artifactsA, ".env.production"),
      join(artifactsA, ".ENV.staging"),
      join(artifactsA, "id_ecdsa"),
      join(artifactsA, "id_ecdsa_work"),
      join(artifactsA, "ID_ECDSA.pub"),
      join(artifactsA, "id_dsa"),
      join(artifactsA, "id_dsa_legacy"),
      join(root, "u", ".netrc"),
      join(artifactsA, "case-netrc", ".NETRC"),
      join(root, "u", ".docker", "config.json"),
      join(root, "u", ".config", "gcloud", "credentials.db"),
      join(root, "u", "Library", "Application Support", "BraveSoftware", "Brave-Browser", "Default", "Cookies"),
      join(root, "u", ".config", "BraveSoftware", "Brave-Browser", "Default", "Login Data"),
      join(root, "u", "Library", "Application Support", "Microsoft Edge", "Default", "Cookies"),
      join(root, "u", ".config", "microsoft-edge", "Default", "Login Data"),
      join(root, "u", "Library", "Application Support", "Arc", "User Data", "Default", "Cookies"),
    ];

    for (const p of newDeniedPaths) {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, "x");
      expect(isDeniedPath(p, dataDir)).toBe(true);
      expect(classify({
        what: { kind: "path", path: p },
        botFolders,
        referenced,
        dataDir,
      })).toEqual({ kind: "denied", reason: "deny-list" });
    }

    // Siblings that must NOT false-positive
    for (const name of [".envrc", "env.ts", "gcloud-notes.md", "brave-docs.md"]) {
      const safe = join(artifactsA, name);
      writeFileSync(safe, "ok");
      expect(isDeniedPath(safe, dataDir)).toBe(false);
      expect(classify({
        what: { kind: "artifact", botId: "bot-a", path: name },
        botFolders,
        referenced,
        dataDir,
      }).kind).toBe("free");
    }
  });

  it("R7. FetchWhat matches protocol/fetch.ts FetchWhat", () => {
    expectTypeOf<FetchWhat>().toEqualTypeOf<ProtocolFetchWhat>();
  });

  it("F1. .bot/artifacts symlink to botFolder, .bot, or another subfolder asks instead of free", () => {
    const referenced = () => false;

    // .bot/artifacts -> ../ (the bot folder itself)
    const botSelf = join(root, "bots", "bot-self");
    mkdirSync(join(botSelf, ".bot"), { recursive: true });
    mkdirSync(join(botSelf, "src"), { recursive: true });
    const secretSrc = join(botSelf, "src", "secret.ts");
    writeFileSync(secretSrc, "export const secret = 1;\n");
    symlinkSync("..", join(botSelf, ".bot", "artifacts"));

    // .bot/artifacts -> . (the .bot directory itself)
    const botDotSelf = join(root, "bots", "bot-dot-self");
    mkdirSync(join(botDotSelf, ".bot"), { recursive: true });
    const memoryMd = join(botDotSelf, ".bot", "memory.md");
    writeFileSync(memoryMd, "# private memory\n");
    symlinkSync(".", join(botDotSelf, ".bot", "artifacts"));

    // .bot/artifacts -> ../shared (another subfolder inside botFolder)
    const botSub = join(root, "bots", "bot-sub");
    mkdirSync(join(botSub, ".bot"), { recursive: true });
    mkdirSync(join(botSub, "shared"), { recursive: true });
    const sharedTxt = join(botSub, "shared", "file.txt");
    writeFileSync(sharedTxt, "shared\n");
    symlinkSync(join("..", "shared"), join(botSub, ".bot", "artifacts"));

    const botFolders = new Map<string, string>([
      ["bot-self", botSelf],
      ["bot-dot-self", botDotSelf],
      ["bot-sub", botSub],
    ]);

    expect(classify({
      what: { kind: "artifact", botId: "bot-self", path: "src/secret.ts" },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "ask", prefix: realpath(secretSrc) });

    expect(classify({
      what: { kind: "artifact", botId: "bot-self", path: "" },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "ask", prefix: realpath(botSelf) });

    expect(classify({
      what: { kind: "path", path: secretSrc },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "ask", prefix: realpath(secretSrc) });

    expect(classify({
      what: { kind: "git", path: botSelf },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "ask", prefix: realpath(botSelf) });

    expect(classify({
      what: { kind: "artifact", botId: "bot-dot-self", path: "memory.md" },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "ask", prefix: realpath(memoryMd) });

    expect(classify({
      what: { kind: "path", path: memoryMd },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "ask", prefix: realpath(memoryMd) });

    expect(classify({
      what: { kind: "artifact", botId: "bot-sub", path: "file.txt" },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "ask", prefix: realpath(sharedTxt) });
  });

  it("F2. missing or dangling dataDir fails closed as deny-list / isDeniedPath true", () => {
    const botFolders = new Map<string, string>([["bot-a", botA]]);
    const referenced = () => false;
    const safeFile = join(botA, "src", "main.ts");
    const missingDataDir = join(root, "missing-data-dir");
    const danglingDataDir = join(root, "dangling-data-dir");
    symlinkSync(join(root, "does-not-exist"), danglingDataDir);

    expect(isDeniedPath(safeFile, missingDataDir)).toBe(true);
    expect(isDeniedPath(safeFile, danglingDataDir)).toBe(true);

    expect(classify({
      what: { kind: "path", path: safeFile },
      botFolders,
      referenced,
      dataDir: missingDataDir,
    })).toEqual({ kind: "denied", reason: "deny-list" });

    expect(classify({
      what: { kind: "artifact", botId: "bot-a", path: "report.html" },
      botFolders,
      referenced,
      dataDir: missingDataDir,
    })).toEqual({ kind: "denied", reason: "deny-list" });
  });

  it("F3. dataDir is required in isDeniedPath", () => {
    expectTypeOf<Parameters<typeof isDeniedPath>>().toEqualTypeOf<[targetPath: string, dataDir: string]>();
  });

  it("F4. denies additional browser profiles and credential files without false positives", () => {
    const botFolders = new Map<string, string>([["bot-a", botA]]);
    const referenced = () => false;

    const extraDeniedPaths = [
      join(root, "u", "Library", "Application Support", "Google", "Chrome Canary", "Default", "Cookies"),
      join(root, "u", "Library", "Application Support", "Google", "Chrome Beta", "Default", "Cookies"),
      join(root, "u", ".config", "google-chrome-beta", "Default", "Login Data"),
      join(root, "u", ".config", "google-chrome-unstable", "Default", "Login Data"),
      join(root, "u", "Library", "Application Support", "Chromium", "Default", "Cookies"),
      join(root, "u", "Library", "Application Support", "Microsoft Edge Beta", "Default", "Cookies"),
      join(root, "u", ".config", "microsoft-edge-beta", "Default", "Login Data"),
      join(root, "u", "Library", "Application Support", "BraveSoftware", "Brave-Browser-Beta", "Default", "Cookies"),
      join(root, "u", ".config", "BraveSoftware", "Brave-Browser-Beta", "Default", "Login Data"),
      join(root, "u", "Library", "Application Support", "Vivaldi", "Default", "Cookies"),
      join(root, "u", ".config", "vivaldi", "Default", "Login Data"),
      join(artifactsA, ".git-credentials"),
      join(artifactsA, "case-cred", ".GIT-CREDENTIALS"),
      join(artifactsA, ".npmrc"),
      join(artifactsA, "case-npmrc", ".NPMRC"),
      join(artifactsA, ".pypirc"),
      join(root, "u", ".config", "gh", "hosts.yml"),
    ];

    for (const p of extraDeniedPaths) {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, "x");
      expect(isDeniedPath(p, dataDir)).toBe(true);
      expect(classify({
        what: { kind: "path", path: p },
        botFolders,
        referenced,
        dataDir,
      })).toEqual({ kind: "denied", reason: "deny-list" });
    }

    // Sibling names and non-profile folders that must NOT false-positive
    for (const name of ["chrome-canary.md", "vivaldi-notes.md", "npmrc.example", "git-credentials.example", "gh-cli.md"]) {
      const safe = join(artifactsA, name);
      writeFileSync(safe, "ok");
      expect(isDeniedPath(safe, dataDir)).toBe(false);
      expect(classify({
        what: { kind: "artifact", botId: "bot-a", path: name },
        botFolders,
        referenced,
        dataDir,
      }).kind).toBe("free");
    }

    const nonProfileVivaldi = join(root, "projects", "Vivaldi", "notes.md");
    mkdirSync(join(nonProfileVivaldi, ".."), { recursive: true });
    writeFileSync(nonProfileVivaldi, "ok");
    expect(isDeniedPath(nonProfileVivaldi, dataDir)).toBe(false);
  });

  it("F5. artifact branch resolves targetPath once via realpath (missing target returns outside)", () => {
    const botFolders = new Map<string, string>([["bot-a", botA]]);
    const referenced = () => false;

    // Before F5, resolveCanonicalPath walked up ENOENT and matched DENY -> "deny-list";
    // resolving once with realpath(targetPath) fails directly to "outside".
    expect(classify({
      what: { kind: "artifact", botId: "bot-a", path: ".env" },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "denied", reason: "outside" });

    expect(classify({
      what: { kind: "artifact", botId: "bot-a", path: ".ssh/id_rsa" },
      botFolders,
      referenced,
      dataDir,
    })).toEqual({ kind: "denied", reason: "outside" });
  });
});
