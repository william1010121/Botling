// The plugin host (Web/host/src/host.ts, unchanged) in an Electron utility process. Main starts this
// file and sends one message carrying a MessagePort to the core; each protocol line goes over that
// port as a string instead of stdin/stdout. Plugins' console output goes to the core as `{stderr}`,
// as the Node host sends it to stderr. When the port closes (the core went away) the host ends.
type Port = {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  on(event: "close", listener: () => void): void;
  start(): void;
};
type ParentPort = { once(event: "message", listener: (event: { data: unknown; ports: Port[] }) => void): void };

const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort;
// host.ts runs its stdio `main()` when CCB_PLUGIN_HOST is "1": not here.
const wanted = process.env.CCB_PLUGIN_HOST;
process.env.CCB_PLUGIN_HOST = "utility";

parentPort.once("message", async (event) => {
  const port = event.ports[0];
  if (!port) process.exit(1);
  const { Host } = await import("../../../Web/host/src/host");
  process.env.CCB_PLUGIN_HOST = wanted ?? "1";
  const stderr = (...parts: unknown[]) => port.postMessage({ stderr: parts.map(String).join(" ") + "\n" });
  console.log = stderr;
  console.info = stderr;
  console.debug = stderr;
  console.warn = stderr;
  console.error = stderr;
  const host = new Host((message: unknown) => port.postMessage(JSON.stringify(message)));
  host.onShutdown = () => setTimeout(() => process.exit(0), 50);
  process.on("uncaughtException", (error) => host.report(null, error));
  process.on("unhandledRejection", (error) => host.report(null, error));
  port.on("message", (message) => {
    if (typeof message.data !== "string" || !message.data.trim()) return;
    let value: unknown;
    try { value = JSON.parse(message.data); } catch { return; }
    void host.receive(value as Parameters<typeof host.receive>[0]);
  });
  port.on("close", () => process.exit(0));
  port.start();
  host.notify("ready", { pid: process.pid });
});
