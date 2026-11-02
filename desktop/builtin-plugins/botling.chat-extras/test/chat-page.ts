// The chat page with botling.chat-extras loaded, as Botling loads it: a PluginHost lending it the input box.
import { Composer } from "../../../../Web/src/composer";
import { PluginHost, type PluginSpec } from "../../../../Web/src/plugins";
import manifest from "../package.json";
import { activate } from "../src/web";

export const NAME = manifest.name;
const defaults = Object.fromEntries(Object.entries(manifest.ccb.contributes.settings).map(([key, setting]) => [key, setting.default]));

export const spec = (settings: Record<string, unknown> = {}): PluginSpec =>
  ({ name: NAME, version: manifest.version, source: "", styles: [], settings: { ...defaults, ...settings }, commands: [] });

/** A fresh page (the body emptied) with an input box and the plugin running; `close` unloads it. */
export async function chatPage(settings: Record<string, unknown> = {}) {
  document.body.innerHTML = "";
  const slot = document.createElement("div");
  document.body.append(slot);
  const composer = new Composer(slot);
  const host = new PluginHost({
    composer: {
      element: composer.root,
      view: composer.view,
      getText: () => composer.text,
      insert: (text) => composer.insert(text),
      addExtension: (extension) => composer.addExtension(extension),
      showPopover: (content) => composer.showPopover(content),
      chips: { add: (chip) => composer.addChip(chip), list: () => composer.chipsHere() },
    },
    redraw: () => {},
  });
  composer.onKey = (event) => host.handleKey(event);
  composer.onPaste = (event) => host.handlePaste(event);
  await host.sync([spec(settings)], async () => activate);
  return { composer, host, close: () => host.unload(NAME) };
}
