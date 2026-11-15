export function activate(ccb) {
  ccb.commands.register("builtin.alpha.info", () => ({ name: "builtin.alpha", pid: process.pid }));
  ccb.hooks.beforeSend((m) => m.text.replaceAll("[alpha]", "ALPHA"));
}
