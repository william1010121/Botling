// Real entry points and two physical copies of identical dependencies. Compare raw output,
// then exercise the unchanged restart comparator with actual main/preload/IPC edits.
import { it, expect } from "vitest";
import * as fs from "node:fs";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { bundlePrints, planInstall } from "../../src/main/hot-install";
import { STORAGE_RESTART_REASON, type StorageContract } from "../../src/storage-contract";
const { buildMain } = await import(resolve("build.mjs"));
const { buildPreloads } = await import(resolve("build-preloads.mjs"));
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

it("stabilizes cache paths while preserving restart detection for real code changes", async () => {
  const temp = fs.mkdtempSync(resolve(".bundle-reproducibility-"));
  const root = join(temp, "desktop"), out = join(root, "out");
  const names = ["main/main.cjs", "preload/preload.cjs", "preload/editor-host.cjs"];
  const put = (path: string, value: string) => { fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, value); };
  try {
    fs.mkdirSync(root);
    fs.cpSync(resolve("src"), join(root, "src"), { recursive: true });
    for (const path of ["tsconfig.json", "renderer-config.mjs", "scripts/release-manifest.mjs"]) {
      fs.mkdirSync(dirname(join(root, path)), { recursive: true });
      fs.copyFileSync(resolve(path), join(root, path));
    }
    put(join(temp, "Web/src/contract.json"), fs.readFileSync(resolve("../Web/src/contract.json"), "utf8"));
    // Zod is the bundled dependency in all three entries. Real copies ensure the previous
    // realpath behavior would see different identities, unlike aliases of a single cache.
    for (const identity of ["cache-a", "cache-b"]) {
      const modules = join(temp, identity, "node_modules");
      fs.mkdirSync(modules, { recursive: true });
      fs.cpSync(fs.realpathSync(resolve("node_modules/zod")), join(modules, "zod"), { recursive: true });
    }
    const key = JSON.parse(fs.readFileSync(resolve("release-config.json"), "utf8")).publicKey ?? null;
    const main = () => buildMain({ root, outfile: join(out, names[0]), updatePublicKey: key });
    const preloads = () => buildPreloads({ root, outdir: join(out, "preload") });
    const build = async () => { await main(); await preloads(); };
    const bytes = () => Object.fromEntries(names.flatMap(name => [name, `${name}.map`]).map(name => [name, fs.readFileSync(join(out, name))]));
    const link = (identity: string) => {
      if (fs.existsSync(join(root, "node_modules"))) fs.unlinkSync(join(root, "node_modules"));
      fs.symlinkSync(join(temp, identity, "node_modules"), join(root, "node_modules"), "dir");
    };
    // Match the release's approved package/core storage declaration without weakening the gate.
    const storageContract: StorageContract = JSON.parse(fs.readFileSync(resolve("package.json"), "utf8")).botlingStorageContract;
    const prints = async (label: string, coreStorage: StorageContract | null = storageContract) => {
      const app = join(temp, label);
      put(join(app, "Contents/Info.plist"), '<plist><dict><key>CFBundleIdentifier</key><string>test.bundle</string></dict></plist>');
      fs.cpSync(out, join(app, "Contents/Resources/app/out"), { recursive: true });
      put(join(app, "Contents/Resources/app/package.json"), JSON.stringify({ botlingStorageContract: storageContract }));
      if (coreStorage) put(join(app, "Contents/Resources/app/out/core/storage-contract.json"), JSON.stringify(coreStorage));
      return bundlePrints(app, fs);
    };
    link("cache-a"); await build(); const a = bytes(); const baseline = await prints("baseline");
    link("cache-b"); await build(); const b = bytes();
    for (const name of Object.keys(a)) expect(b[name].equals(a[name]), name).toBe(true);
    expect(baseline.storageContract).toEqual(storageContract);
    expect(planInstall(baseline, await prints("other-cache"))).toEqual({ mode: "hot", parts: [] });
    const storageRefusals = [];
    for (const [label, coreStorage] of [
      ["unknown-storage", null],
      ["mismatched-storage", { ...storageContract, epoch: storageContract.epoch + 1 }],
    ] as const) {
      const candidate = await prints(label, coreStorage);
      expect(candidate.storageContract).toBeNull();
      const plan = planInstall(baseline, candidate);
      expect(plan).toEqual({ mode: "restart", reasons: [STORAGE_RESTART_REASON] });
      storageRefusals.push({ label, plan });
    }
    for (const name of names) {
      expect(a[name].toString()).toContain("node_modules/zod/");
      expect(a[name].toString()).not.toMatch(/cache-[ab]/);
    }
    const changes: Record<string, Record<string, string>> = {};
    const modify = (path: string, change: (source: string) => string) => {
      const file = join(root, path), original = fs.readFileSync(file, "utf8");
      const changed = change(original); expect(changed).not.toBe(original); fs.writeFileSync(file, changed);
      return () => fs.writeFileSync(file, original);
    };
    let restore = modify("src/main/main.ts", source => source + '\nconsole.log("repro-main-behavior-change");\n');
    await main();
    expect(planInstall(baseline, await prints("changed-main"))).toEqual({ mode: "restart", reasons: ["kernel changed: main process"] });
    changes.main = { [names[0]]: hash(bytes()[names[0]]) }; restore(); await main();
    restore = modify("src/preload/preload.ts", source => source.replace("protocol: 2", "protocol: 3"));
    await preloads();
    expect(planInstall(baseline, await prints("changed-preload"))).toEqual({ mode: "restart", reasons: ["kernel changed: preloads"] });
    changes.preload = { [names[1]]: hash(bytes()[names[1]]) }; restore();
    restore = modify("src/editor-host-wire.ts", source => source.replace("botling:editor:up", "botling:editor:up-v2"));
    await build();
    expect(planInstall(baseline, await prints("changed-ipc"))).toEqual({ mode: "restart", reasons: ["kernel changed: main process, preloads"] });
    const ipc = bytes();
    for (const name of names) expect(ipc[name].equals(a[name]), name).toBe(false);
    changes.ipc = Object.fromEntries(names.map(name => [name, hash(ipc[name])])); restore();
    console.log(JSON.stringify({ storageContract, storageRefusals, cachePaths: ["cache-a", "cache-b"], identical: Object.keys(a), sha256: Object.fromEntries(names.map(name => [name, hash(a[name])])), changedHashes: changes }));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}, 30_000);
