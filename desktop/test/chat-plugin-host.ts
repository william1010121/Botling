// A host that runs only `botling.chat` (M7-07b): the plugin provides `composer.insertQuote` now (the `:chat` stand-in is gone), so a test that
// registers a quoter (composer-quote.ts `setComposerQuoter`) and expects a frame's quote to land needs the plugin up. The build ships more
// plugins; this one runs the chat plugin alone, under the hash the FE build wrote for its folder.
import { feBuildManifestFile } from "../fe-build-manifest.mjs";
import { CHAT_PLUGIN } from "../src/renderer/chat-names";
import { InPageHost } from "../src/renderer/shell/inpage-host";
import { parseFeManifest } from "../src/renderer/shell/inpage-loader";
import { desktop } from "./helpers";

/** The FE-build manifest entry of the chat plugin, as a manifest. */
export const chatOnlyManifest = () => ({ plugins: parseFeManifest(JSON.parse(feBuildManifestFile(desktop).toString("utf8"))).plugins.filter((entry) => entry.name === CHAT_PLUGIN) });

/** Starts the chat plugin in the renderer's kernel; `stop()` unloads it and waits until the kernel holds nothing of it. */
export async function startChatPlugin(): Promise<{ host: InPageHost; stop: () => Promise<void> }> {
  const host = new InPageHost({ manifest: chatOnlyManifest(), log: () => undefined });
  await host.start();
  return { host, stop: () => host.stop() };
}
