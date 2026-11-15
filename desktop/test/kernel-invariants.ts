// The kernel's rules as invariants on its event log (kernel acceptance, brief §5 check 3; M7-11a moved it here from
// plugin-kernel-acceptance.test.ts so the renderer-kernel run uses the same code). Test tool: no window, nothing that takes focus.
import type { Kernel, KernelEvent, PluginDeclaration } from "../../Web/src/plugin-kernel";

/**
 * The kernel rules as invariants on the event log: P4/K1/D64 (a provider or slot owner begins undoing only once everything
 * depending on it is absent), P3/K2/D65 (a load starts only with its providers and slot owners active), K2 at each
 * accepted contribution, and P2 as the model states it (NoOrphan) after every step. Problems found are pushed to `problems`.
 *
 * `declarations` is a fixed list, or a function that gives the declarations installed now (a feed installs and forgets plugins
 * while the run goes on: pass `() => kernel.installed().map((name) => kernel.declaration(name)!)`).
 */
export function ruleWatcher(declarations: PluginDeclaration[] | (() => PluginDeclaration[]), kernel: () => Kernel | undefined, problems: string[]) {
  const staticByName = typeof declarations === "function" ? null : new Map(declarations.map((declaration) => [declaration.name, declaration]));
  return (event: KernelEvent) => {
    const k = kernel();
    if (!k) return;
    const all = typeof declarations === "function" ? declarations() : declarations;
    const declared = staticByName ? staticByName.get(event.plugin) : all.find((declaration) => declaration.name === event.plugin);
    if (event.action === "BeginUnload") {
      const provided = declared?.provides?.services ?? [];
      const owned = declared?.provides?.slots ?? [];
      const contributing = new Set(k.allContributions().filter((c) => owned.includes(c.slot)).map((c) => c.plugin));
      for (const other of all) {
        if (other.name === event.plugin) continue;
        const depends = (other.requires?.services ?? []).some((service) => provided.includes(service)) || (other.contributes?.slots ?? []).some((slot) => owned.includes(slot)) || contributing.has(other.name);
        if (depends && k.state(other.name) !== "absent") problems.push(`${event.plugin} began undoing while ${other.name} (depending on it) was ${k.state(other.name)}`);
      }
    } else if (event.action === "StartLoad") {
      for (const service of declared?.requires?.services ?? []) {
        const provider = all.find((d) => d.provides?.services?.includes(service))?.name;
        if (!provider || k.state(provider) !== "active") problems.push(`${event.plugin} started loading while ${service}'s provider was ${provider ? k.state(provider) : "missing"}`);
      }
      for (const slot of declared?.contributes?.slots ?? []) {
        const owner = all.find((d) => d.provides?.slots?.includes(slot))?.name;
        if (owner && owner !== event.plugin && k.state(owner) !== "active") problems.push(`${event.plugin} started loading while ${slot}'s owner was ${k.state(owner)}`);
      }
    } else if (event.action === "Register" && !event.note && event.registration?.startsWith("contribution:")) {
      const slot = event.registration.slice("contribution:".length, event.registration.lastIndexOf("#"));
      const owner = k.slotOwner(slot);
      if (!owner || (owner !== event.plugin && k.state(owner) !== "active")) problems.push(`${event.plugin}'s contribution to ${slot} was accepted while its owner was ${owner ? k.state(owner) : "missing"}`);
    }
    // P2 as the model states it (NoOrphan), at every step: a held contribution's slot has an owner that is not absent.
    for (const contribution of k.allContributions()) {
      const owner = k.slotOwner(contribution.slot);
      if (!owner || k.state(owner) === "absent") problems.push(`after ${event.action} ${event.plugin}: ${contribution.plugin}'s contribution to ${contribution.slot} outlived its owner`);
    }
  };
}
