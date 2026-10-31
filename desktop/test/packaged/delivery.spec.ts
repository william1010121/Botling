// Delivery acceptance: inspect the actual distributable containers without installing an app.
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { desktop, tempDir } from "../helpers";

test.skip(process.platform !== "darwin", "macOS delivery containers only");

test("ZIP and read-only DMG contain the intact signed app; the DMG is signed and has an Applications shortcut", () => {
  const app = process.env.BOTLING_PACKAGED_APP ?? join(desktop, "dist/mac-arm64/Botling 2.app");
  const dist = dirname(dirname(app));
  const version = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")).version;
  const stem = join(dist, `Botling-2-${version}-mac-arm64`);
  const base = tempDir("pkg-delivery"), unzipped = join(base, "unzipped");
  const run = (command: string, args: string[]) => execFileSync(command, args, { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
  const digest = (bundle: string) => createHash("sha256").update(readFileSync(join(bundle, "Contents/Resources/app.asar"))).digest("hex");
  const expected = digest(app);
  let mount: string | null = null;
  try {
    const verify = run("/usr/bin/hdiutil", ["verify", `${stem}.dmg`]);
    run("/usr/bin/codesign", ["--verify", "--strict", `${stem}.dmg`]);
    // DiskImages refuses mount points on an existing external volume. Its temporary /Volumes
    // entry is a read-only virtual mount; image bytes and all extracted output stay in .cache.
    const attached = run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-plist", `${stem}.dmg`]);
    const plist = join(base, "mount.plist");
    writeFileSync(plist, attached);
    const info = JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist]));
    mount = info["system-entities"].find((entry: Record<string, string>) => entry["mount-point"])?.["mount-point"] ?? null;
    if (!mount) throw new Error("The image has no mounted filesystem");
    expect(readlinkSync(join(mount, "Applications"))).toBe("/Applications");
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", join(mount, "Botling 2.app")]);
    expect(digest(join(mount, "Botling 2.app"))).toBe(expected);
    run("/usr/bin/ditto", ["-x", "-k", `${stem}.zip`, unzipped]);
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", join(unzipped, "Botling 2.app")]);
    expect(digest(join(unzipped, "Botling 2.app"))).toBe(expected);
    const evidence = join(desktop, ".cache", "evidence", "review-d");
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, "delivery-validation.json"), JSON.stringify({ zip: `${stem}.zip`, dmg: `${stem}.dmg`, app, asarSha256: expected, imageVerification: verify.trim(), mountedReadOnly: true, applicationsShortcut: "/Applications", appSignaturesValid: true, containerSignatureValid: true }, null, 2) + "\n");
  } finally {
    // Detach before removing any temporary path, including when an assertion fails.
    if (mount) run("/usr/bin/hdiutil", ["detach", mount]);
    rmSync(base, { recursive: true, force: true });
  }
});
