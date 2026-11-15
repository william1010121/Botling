// A plugin frame's calls into the page's own services (M7-04b): `ccb.composer.insertQuote` is the kernel service `composer.insertQuote`
// (renderer-kernel.ts INSERT_QUOTE). The binding comes from the plugin's declaration in the kernel (its manifest's `uses`, installed by
// the plugin feed), not from the plugin's name: a shipped plugin that declares kernel fields reaches only the services it declares, and
// only while its instance is active; a plugin with no declaration (a 2.x plugin) is bound as it always was. A service nobody provides
// finds nothing (`absent`), whichever the reason, and the frame's caller answers as when no input box exists.
import { INSERT_QUOTE, rendererKernel } from "../renderer-kernel";
import { pluginFeed } from "./plugin-feed";

/** The frame API calls that are kernel services, by the frame API's name. */
export const FRAME_SERVICES = { "composer.insertQuote": INSERT_QUOTE } as const;
export type FrameApi = keyof typeof FRAME_SERVICES;

/** Whether `plugin`'s frame may call `service` now: a declared plugin only if it is active and lists it in `uses`; otherwise as in 2.x. */
export function frameMayUse(plugin: string, service: string): boolean {
  if (!pluginFeed.declares(plugin)) return true;
  return rendererKernel.state(plugin) === "active" && rendererKernel.declaration(plugin)?.uses?.services?.includes(service) === true;
}

/** Calls the page's service for `plugin`'s frame; `absent` (and no call) when the plugin may not use it or nobody provides it. */
export function callFrameService<R = unknown>(plugin: string, api: FrameApi, ...args: unknown[]): { absent: true } | { absent: false; value: R } {
  const service = FRAME_SERVICES[api];
  if (!frameMayUse(plugin, service)) return { absent: true };
  return rendererKernel.call<R>(plugin, service, ...args);
}
