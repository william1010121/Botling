// What a plugin that runs in a frame tells the renderer's kernel about itself (M7-04b; plugin-kernel design §5.2, section 7 item 3):
// the manifest's `kernel` fields, read for a plugin that ships with Botling. Today only `uses.services` matters here: the services
// of the page's own surfaces (the chat's `composer.insertQuote`) a frame may call. The plugin feed (plugin-feed.ts) installs them as
// the plugin's declaration, and frame-services.ts binds a frame's call from them, so a frame is not bound to a service by its name.
//
// The plugin list the page receives (`PluginsView`) does not carry the kernel fields, so the shipped manifests are bundled with the
// page: a named import of `name` and `ccb` keeps esbuild from carrying the long description. Adding a built-in frame plugin that uses
// a page service adds one import and one entry below; a plugin without an entry declares nothing (it is a 2.x plugin, as before).
// The declaration is taken only for a plugin the core lists as shipped (`builtIn`), never for a library copy of the same name.
import { ccb as noteCcb, name as noteName } from "../../../builtin-plugins/botling.note/package.json";

/** What the page reads of a manifest's kernel fields. */
export interface FrameDeclaration { uses: string[] }

const KERNEL_FIELDS_VERSION = 1;
// The pattern of the core's reader (core/plugins/manifest.ts `readKernelFields`): the page cannot import that module (it uses node:fs).
const KERNEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The declaration in a package.json's value: null when it has no `kernel` field or one this page does not read; wrong entries are left out. Never throws. */
export function parseFrameDeclaration(manifest: unknown): FrameDeclaration | null {
  if (!isObject(manifest)) return null;
  const field = manifest.botling != null ? manifest.botling : manifest.ccb;
  if (!isObject(field) || field.kernel !== KERNEL_FIELDS_VERSION) return null;
  const uses = isObject(field.uses) && Array.isArray(field.uses.services) ? field.uses.services : [];
  return { uses: [...new Set(uses.filter((service): service is string => typeof service === "string" && KERNEL_NAME.test(service)))] };
}

/** The shipped manifests by plugin name (a Map: a name from outside is never a property lookup). Tests add and remove entries. */
export const FRAME_MANIFESTS = new Map<string, unknown>([[noteName, { name: noteName, ccb: noteCcb }]]);

/** What the shipped plugin `name` declares (null: it has no manifest here, or declares no kernel fields). */
export function frameDeclaration(name: string): FrameDeclaration | null {
  return parseFrameDeclaration(FRAME_MANIFESTS.get(name));
}
