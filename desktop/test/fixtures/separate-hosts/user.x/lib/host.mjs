import { readFileSync } from "node:fs";
import { join } from "node:path";

let calls = 0;

export function activate(ccb) {
  ccb.ui.expose("ping", () => ({
    name: "user.x",
    pid: process.pid,
    calls: ++calls,
  }));
  ccb.commands.register("user.x.info", () => ({
    name: "user.x",
    pid: process.pid,
    calls: ++calls,
    secretX: ccb.settings.get("secretX"),
    secretY: ccb.settings.get("secretY"),
    dir: ccb.plugin.dir,
    entryUrl: import.meta.url,
  }));
  ccb.commands.register("user.x.calls", () => calls);
  ccb.commands.register("user.x.lazy", async () => {
    const mod = await import(`./lazy.mjs?t=${Date.now()}`);
    const note = readFileSync(join(ccb.plugin.dir, "data", "note.txt"), "utf8");
    return { label: mod.label, note, pid: process.pid };
  });
  ccb.hooks.beforeSend((m) => m.text.replaceAll("[x]", "X"));
}
