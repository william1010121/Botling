let calls = 0;

export function activate(ccb) {
  ccb.ui.expose("ping", () => ({
    name: "user.y",
    pid: process.pid,
    calls: ++calls,
  }));
  ccb.commands.register("user.y.info", () => ({
    name: "user.y",
    pid: process.pid,
    calls: ++calls,
    secretX: ccb.settings.get("secretX"),
    secretY: ccb.settings.get("secretY"),
  }));
  ccb.commands.register("user.y.calls", () => calls);
  ccb.hooks.beforeSend((m) => m.text.replaceAll("[y]", "Y"));
}
