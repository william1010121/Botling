// The 2.x contribution list on the plugin kernel (core/plugins/kernel-list.ts, kernel step 1 step 6): each enabled plugin
// is a kernel instance owning its contributions, in slots the core owns; disabling, enabling and reloading go through the
// kernel. The list itself is unchanged (the step-1 goldens and every plugin test guard that).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { KernelEvent } from "../../../Web/src/plugin-kernel";
import { CONTRIBUTION_KINDS, CORE_PLUGIN, CORE_SLOTS, ContributionKernel, slotOf } from "../../src/core/plugins/kernel-list";
import { PluginRegistry } from "../../src/core/plugins/registry";
import { MemorySecretStore } from "../../src/core/plugins/secrets";
import { HOOKS, MENU_SLOTS, STATUS_SLOTS, VIEW_SLOTS, type Contribution, type ContributionKind } from "../../src/core/plugins/contributions";
import { writeFixturePlugins } from "../kernel-goldens";
import { desktop } from "../helpers";

const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function registryWithFixtures(builtIns: string | null = join(desktop, "builtin-plugins")) {
  const data = mkdtempSync(join(tmpdir(), "kernel-list-"));
  temps.push(data);
  writeFixturePlugins(join(data, "plugins"));
  const registry = new PluginRegistry(join(data, "plugins"), join(data, "plugins.json"), new MemorySecretStore(), builtIns);
  return { registry, library: join(data, "plugins") };
}

const label = (contribution: Contribution) => `${contribution.kind}:${JSON.stringify(contribution)}`;

describe("the contribution list on the kernel", () => {
  it("disabling a plugin removes exactly its contributions, newest first, and nothing of another plugin", () => {
    const { registry } = registryWithFixtures();
    const before = registry.contributions();
    const zed = before.filter((entry) => entry.plugin === "zed.tools");
    expect(zed.length).toBeGreaterThan(10);
    const kernel = registry.contributionKernel.kernel;
    const zedRegistrations = kernel.registrations("zed.tools", "contribution").map((reg) => `contribution:${reg.key}#${reg.id}`);
    expect(zedRegistrations).toHaveLength(zed.length);
    const steps: KernelEvent[] = [];
    const stop = registry.contributionKernel.watch((event) => steps.push(event));
    registry.setEnabled("zed.tools", false);
    stop();
    const undone = steps.filter((event) => event.action === "RunUndo");
    expect(undone.every((event) => event.plugin === "zed.tools")).toBe(true);
    expect(undone.map((event) => event.registration)).toEqual([...zedRegistrations].reverse());
    expect(steps.map((event) => `${event.action} ${event.plugin}`).filter((line) => !line.startsWith("RunUndo"))).toEqual(["RequestUnload zed.tools", "BeginUnload zed.tools", "FinishUnload zed.tools"]);
    expect(kernel.holdsNothingOf("zed.tools")).toBe(true);
    // Everyone else's list is untouched, in the same order.
    expect(registry.contributions().map(label)).toEqual(before.filter((entry) => entry.plugin !== "zed.tools").map(label));
    // Turned on again: the same list as before, from a new instance.
    registry.setEnabled("zed.tools", true);
    expect(registry.contributions().map(label)).toEqual(before.map(label));
    expect(kernel.generation("zed.tools")).toBe(2);
  });

  it("each contribution sits in a slot the core owns; a plugin whose files change is a new instance, one whose files stay is kept", () => {
    const { registry, library } = registryWithFixtures(null);
    const kernel = registry.contributionKernel.kernel;
    registry.contributions();
    expect(kernel.state(CORE_PLUGIN)).toBe("active");
    for (const entry of kernel.allContributions<Contribution>()) {
      expect(CORE_SLOTS).toContain(entry.slot);
      expect(kernel.slotOwner(entry.slot)).toBe(CORE_PLUGIN);
      expect(entry.slot).toBe(slotOf(entry.entry));
    }
    const generations = () => [kernel.generation("acme-board"), kernel.generation("zed.tools")];
    expect(generations()).toEqual([1, 1]);
    registry.contributions();
    registry.rescan();
    expect(generations()).toEqual([1, 1]);
    // acme-board's manifest changes (a new command): only it reloads, and its new entry is in the list.
    const file = join(library, "acme-board", "package.json");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    manifest.ccb.contributes.commands.push({ id: "acme-board.more", title: "More" });
    writeFileSync(file, JSON.stringify(manifest, null, 2));
    expect(registry.rescan()).toBe(true);
    expect(generations()).toEqual([2, 1]);
    expect(registry.contributions().some((entry) => entry.kind === "command" && entry.id === "acme-board.more")).toBe(true);
  });

  it("a removed plugin's contributions go with it; the list handed out is a copy", () => {
    const { registry, library } = registryWithFixtures(null);
    const list = registry.contributions();
    (list[0] as { plugin: string }).plugin = "changed";
    expect(registry.contributions()[0]!.plugin).toBe("acme-board");
    rmSync(join(library, "acme-board"), { recursive: true, force: true });
    registry.rescan();
    expect(registry.contributionKernel.loaded()).toEqual(["zed.tools"]);
    expect(registry.contributionKernel.kernel.holdsNothingOf("acme-board")).toBe(true);
    expect(registry.contributions().every((entry) => entry.plugin === "zed.tools")).toBe(true);
  });

  it("every contribution kind has its slots in the core: the kinds are a record the compiler checks against ContributionKind", () => {
    // A record that leaves a kind out (or names one that is not) does not compile, so a new kind cannot be dropped.
    const kinds: Record<ContributionKind, true> = CONTRIBUTION_KINDS;
    // @ts-expect-error: a kind left out
    const missing: Record<ContributionKind, true> = { command: true };
    expect(missing).toBeTruthy();
    const placed: Record<string, readonly string[]> = { view: VIEW_SLOTS, menu: MENU_SLOTS, hook: HOOKS, statusItem: STATUS_SLOTS };
    const expected = (Object.keys(kinds) as ContributionKind[]).flatMap((kind) => (placed[kind] ? placed[kind]!.map((where) => `${kind}/${where}`) : [kind]));
    expect([...CORE_SLOTS].sort()).toEqual(expected.sort());
  });

  it("reconcile returns what it holds in the order asked, and unloads what is no longer asked for", () => {
    const list = new ContributionKernel({ log: true });
    const a: Contribution[] = [{ kind: "command", plugin: "a", id: "a.x", title: "X" }, { kind: "hook", plugin: "a", hook: "beforeSend" }];
    const b: Contribution[] = [{ kind: "menu", plugin: "b", menu: "chat/link", command: "b.go" }];
    expect(list.reconcile([{ name: "b", contributions: b }, { name: "a", contributions: a }])).toEqual([...b, ...a]);
    expect(list.reconcile([{ name: "a", contributions: a }, { name: "b", contributions: b }])).toEqual([...a, ...b]);
    expect(list.reconcile([{ name: "a", contributions: a }])).toEqual(a);
    expect(list.loaded()).toEqual(["a"]);
    list.kernel.events.splice(0);
    expect(list.reconcile([])).toEqual([]);
    expect(list.kernel.events.map((event) => `${event.action} ${event.registration ?? ""}`.trim())).toEqual([
      "RequestUnload", "BeginUnload", "RunUndo contribution:hook/beforeSend#" + list.kernel.events[2]!.registration!.split("#")[1], expect.stringMatching(/^RunUndo contribution:command#/), "FinishUnload",
    ]);
  });
});
