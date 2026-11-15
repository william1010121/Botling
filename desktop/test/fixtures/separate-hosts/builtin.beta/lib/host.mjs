export function activate(ccb) {
  ccb.commands.register("builtin.beta.info", () => ({ name: "builtin.beta", pid: process.pid }));
}
