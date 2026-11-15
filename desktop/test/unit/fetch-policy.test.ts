import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, DENY, isDeniedPath, Limits, realInside, type FetchWhat } from "../../src/server/fetch";
import type { EntryRef } from "../../src/protocol";

const ENTRY: EntryRef = { stream: "bot:bot-a", seq: 1 };
const BLOB_ID = "sha256:" + "a".repeat(64);

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
});
