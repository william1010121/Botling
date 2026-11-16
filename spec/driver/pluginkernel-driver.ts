// The only door spec/tests/pluginkernel.spec.test.ts uses into the plugin kernel (Web/src/plugin-kernel/): one method
// per thing a plugin manager, a plugin or a bot's code write does to the kernel in spec/models/pluginkernel, the steps
// the kernel took (its own event log, in spec/reference/pluginkernel.ts's names), and an observation in the
// reference's `View` vocabulary. The kernel's own steps (StartLoad, Activate, CascadeUnload, BeginUnload, RunUndo,
// FinishUnload, the reloads) happen inside the calls, as they do in the app.
import type { Plugin, Reg, Slot, View } from "../reference/pluginkernel";

export interface KernelWorld {
  /** The model's topology: what each plugin provides, requires, owns and contributes to. */
  provides: Record<Plugin, string[]>;
  requires: Record<Plugin, string[]>;
  owns: Record<Plugin, Slot[]>;
  contributes: Record<Plugin, Slot[]>;
  /** Plugins whose loader is async: their load stays "loading" until `finishLoad`. The others load synchronously. */
  asyncLoad: Plugin[];
}

/**
 * One step of the kernel, from its event log. `reg` is the model's registration, or null for the owner's own slot
 * (the kernel registers a slot it owns; the model has the owner present instead). `refused`: a registration the kernel
 * did not take (its undo ran at once); `late`: that at-once undo; `failed`: the undo threw; `cause`: why an unload.
 */
export interface KernelStep {
  action: string;
  plugin: Plugin;
  reg?: Reg | null;
  refused?: boolean;
  late?: boolean;
  failed?: boolean;
  cause?: "request" | "dependency" | "swap";
}

export interface KernelSession {
  /** The plugin manager wants `p` loaded, with the plugins it depends on that are absent and not wanted yet. */
  load(p: Plugin): Promise<void>;
  /** `p`'s async loader settles (its current instance). */
  finishLoad(p: Plugin): Promise<void>;
  /** Someone asks for `p`'s unload. */
  unload(p: Plugin): Promise<void>;
  /** `p`'s code is replaced (a hot swap). */
  swap(p: Plugin): Promise<void>;
  /** `p` registers `reg` (a contribution or a listener) now; its undo throws when `failUndo`. */
  register(p: Plugin, reg: Reg, failUndo: boolean): Promise<void>;
  /** `p` starts an async registration of a listener. */
  registerAsync(p: Plugin, failUndo: boolean): Promise<void>;
  /** `p`'s oldest pending async registration settles with its undo. */
  settle(p: Plugin): Promise<void>;
  /** What the kernel did since the last call, in order. */
  steps(): KernelStep[];
  observe(): View;
  close(): Promise<void>;
}

export interface KernelDriver {
  open(world: KernelWorld): Promise<KernelSession>;
}
