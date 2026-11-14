// The 2.x contribution list on the plugin kernel (kernel step 1 step 6; Web/src/plugin-kernel). Each enabled plugin is a
// kernel instance and each entry of its contribution list (contributions.ts, as readManifest reads it) a registration it
// owns, contributed into a slot the core owns: `:core` (a name no plugin can have) holds every 2.x slot: one per view
// place (`view/mainTab`, …), menu (`menu/chat/link`, …), hook, status place, and one per other kind (`command`, `setting`,
// …). The 2.x names stay the only names (aliases come in M7).
//
// A thin adapter, not a rewrite: the registry still decides what is enabled and reads each manifest as before (a plugin's
// components folder can change without its fingerprint, so the list is read on every call), and `reconcile` makes the
// kernel hold exactly that: a plugin turned off, removed or failed is unloaded (its contributions undone newest first),
// a plugin whose list changed is unloaded and loaded again, a new one is loaded. The list it returns is read back from the
// kernel's registrations, in the registry's plugin order and each plugin's own order: the same entries, in the same
// order, as the list before the kernel (the step-1 goldens hold it byte for byte).
import { Kernel, type KernelEvent, type UndoFailure } from "../../../../Web/src/plugin-kernel";
import { HOOKS, MENU_SLOTS, STATUS_SLOTS, VIEW_SLOTS, type Contribution, type ContributionKind } from "./contributions";

/** The core's instance in the kernel: owns every 2.x slot. Not a valid plugin name, so no plugin can take it. */
export const CORE_PLUGIN = ":core";

/**
 * Every contribution kind, as a record the compiler checks against `ContributionKind`: a kind added to the union and not
 * here (or named here and not in the union) does not compile, so no kind's slot can be silently left out of the core.
 */
export const CONTRIBUTION_KINDS = {
  command: true, keybinding: true, slash: true, view: true, tile: true, card: true, statusItem: true, setting: true, menu: true,
  hook: true, routine: true, replyTag: true, promptSection: true, agentCommand: true, agent: true,
} as const satisfies Record<ContributionKind, true>;

const KINDS = Object.keys(CONTRIBUTION_KINDS) as ContributionKind[];

/** The slot a contribution goes into. */
export function slotOf(contribution: Contribution): string {
  switch (contribution.kind) {
    case "view": return `view/${contribution.where}`;
    case "menu": return `menu/${contribution.menu}`;
    case "hook": return `hook/${contribution.hook}`;
    case "statusItem": return `statusItem/${contribution.where}`;
    default: return contribution.kind;
  }
}

/** Every slot the core owns. */
export const CORE_SLOTS: readonly string[] = [
  ...KINDS.filter((kind) => !["view", "menu", "hook", "statusItem"].includes(kind)),
  ...VIEW_SLOTS.map((where) => `view/${where}`),
  ...MENU_SLOTS.map((menu) => `menu/${menu}`),
  ...HOOKS.map((hook) => `hook/${hook}`),
  ...STATUS_SLOTS.map((where) => `statusItem/${where}`),
];

export interface ContributionKernelOptions {
  /** The kernel's event log (tests and the acceptance harness). */
  log?: boolean | ((event: KernelEvent) => void);
  onUndoFailure?: (failure: UndoFailure) => void;
}

export class ContributionKernel {
  readonly kernel: Kernel;
  /** Who watches the kernel's steps (`watch`); none in the app, so no log is kept there. */
  private readonly watchers = new Set<(event: KernelEvent) => void>();
  /** Each loaded plugin's list as it was registered (its JSON), to see when it changed. */
  private readonly registered = new Map<string, string>();
  /** The list each loader registers next. */
  private readonly next = new Map<string, Contribution[]>();

  constructor(options: ContributionKernelOptions = {}) {
    const log = options.log;
    this.kernel = new Kernel({
      log: log === true ? true : (event) => { if (typeof log === "function") log(event); for (const watcher of this.watchers) watcher(event); },
      ...(options.onUndoFailure ? { onUndoFailure: options.onUndoFailure } : {}),
    });
    this.kernel.install({ name: CORE_PLUGIN, provides: { slots: CORE_SLOTS } });
    void this.kernel.load(CORE_PLUGIN, (plugin) => { for (const slot of CORE_SLOTS) this.kernel.provideSlot(plugin, slot); });
  }

  /**
   * Makes the kernel hold exactly the contributions of `plugins` (the enabled, loaded ones, in the registry's order) and
   * returns them as one list, read back from the kernel. Every undo here is synchronous, so each unload is done on return.
   */
  reconcile(plugins: { name: string; contributions: Contribution[]; /** Its code's fingerprint: a new one is a new instance. */ version?: string }[]): Contribution[] {
    const versions = new Map(plugins.map((plugin) => [plugin.name, plugin.version ?? ""]));
    const wanted = new Map(plugins.map((plugin) => [plugin.name, plugin.contributions]));
    for (const name of this.kernel.plugins()) {
      if (name !== CORE_PLUGIN && !wanted.has(name)) this.unload(name);
    }
    for (const [name, list] of wanted) {
      const text = `${versions.get(name)}\u0000${JSON.stringify(list)}`;
      if (this.kernel.state(name) === "active" && this.registered.get(name) === text) continue;
      // Changed: the old list goes first (newest first), then the new one comes in.
      if (this.kernel.state(name) !== "absent") this.unload(name);
      this.kernel.install({ name, contributes: { slots: [...new Set(list.map(slotOf))] } });
      this.next.set(name, list);
      void this.kernel.load(name, (plugin) => {
        for (const contribution of this.next.get(plugin) ?? []) this.kernel.contribute(plugin, slotOf(contribution), contribution);
      });
      this.next.delete(name);
      this.registered.set(name, text);
    }
    const byPlugin = new Map<string, Contribution[]>();
    for (const { plugin, entry } of this.kernel.allContributions<Contribution>()) {
      if (plugin === CORE_PLUGIN) continue;
      const list = byPlugin.get(plugin) ?? [];
      list.push(entry);
      byPlugin.set(plugin, list);
    }
    return plugins.flatMap((plugin) => byPlugin.get(plugin.name) ?? []);
  }

  /** Unloads one plugin's instance: its contributions are undone newest first. */
  unload(name: string): void {
    void this.kernel.requestUnload(name);
    this.registered.delete(name);
  }

  /** Calls `watcher` with each kernel step until the returned function is called. */
  watch(watcher: (event: KernelEvent) => void): () => void {
    this.watchers.add(watcher);
    return () => { this.watchers.delete(watcher); };
  }

  /** The plugins (not the core) whose contributions the kernel holds. */
  loaded(): string[] {
    return this.kernel.plugins().filter((name) => name !== CORE_PLUGIN);
  }
}
