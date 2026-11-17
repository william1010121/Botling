// The window's server client opts into the fast local reconnect (link-streams.ts `reconnectFastMs`): botlingd that is not
// there yet (a restart, an install) is dialed again at most 500 ms apart for the first minute, then at the normal backoff.
import { afterEach, describe, expect, it } from "vitest";
import { MemoryFeStorage, type Dial } from "../../src/fe-link";
import { ServerClient } from "../../src/main-v3/server-client";
import { FakeClock, flush } from "./fe-link-harness";

const clients: ServerClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.stop(); });

describe("ServerClient redials a botlingd that is not there", () => {
  it("at most 500 ms apart in the first minute of an outage, then backs off toward 5 s", async () => {
    const clock = new FakeClock();
    const dials: number[] = [];
    const dial: Dial = (handlers) => {
      dials.push(clock.now());
      handlers.close("refused"); // nothing listens on the socket: refused at once, so the next timer starts at this dial's time
      return { send() {}, close() {} };
    };
    const client = new ServerClient(
      { script: "/build/out/core/main.cjs", env: { BOTLING_APP_DATA_DIR: "/app-data" }, onEvent: () => {}, audit: () => {}, milestone: () => {} },
      { dial, storage: () => new MemoryFeStorage(), clock, readToken: () => "t".repeat(32), feVersion: "3.0.0" },
    );
    clients.push(client);
    client.start();
    await client.ready();
    const start = clock.now();
    for (let ms = 0; ms < 80_000; ms += 100) { clock.advance(100); await flush(3); }
    const at = (from: number, to: number) => dials.filter((t) => t - start > from && t - start <= to).length;
    const gaps = dials.filter((t) => t - start <= 60_000).slice(1).map((t, i) => t - dials[i]!);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(500);
    expect(at(0, 10_000)).toBeGreaterThanOrEqual(15);
    // After the window the gaps double again (500, 1000, 2000, 4000, 5000 ...): a handful of dials in 20 s, not 40.
    expect(at(60_000, 80_000)).toBeLessThanOrEqual(8);
  }, 60_000);
});
