// M4-17 headless Chromium acceptance check: the page connects directly when it can, falls back to the local relay
// when direct `/v3/ws` is blocked, moves back to direct on re-probe when `/v3/ws` returns (0 lost, 0 doubled), and
// `?via=relay` never dials `/v3/ws`.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type Server as HttpServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { until } from "../../helpers";
import { LocalRelay, RelayMeter } from "../../support/local-relay";
import { chatOf, freePort, PairCli, phone, say, Server } from "./page-harness";

const TMP = process.env.V3_PAGE_TMP || (existsSync("/Volumes/My-SSD/botling-work/tmp") ? "/Volumes/My-SSD/botling-work/tmp" : tmpdir());
const dist = join(__dirname, "../../../web-v3/dist/web.js");

class WsGate {
  blockWs = false;
  blockedWs = 0;
  private server: HttpServer | null = null;
  port = 0;

  constructor(private readonly upstream: number) {}
  get origin(): string { return `http://127.0.0.1:${this.port}`; }
  get page(): string { return `${this.origin}/v3/`; }

  async start(port: number): Promise<this> {
    this.server = createServer((req, res) => {
      const path = req.url ?? "/";
      const upstream = httpRequest(
        { host: "127.0.0.1", port: this.upstream, method: req.method, path, headers: { ...req.headers, host: `127.0.0.1:${this.upstream}` } },
        (answer) => { res.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(res); },
      );
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
    });
    this.server.on("upgrade", (req, socket, head) => {
      if (this.blockWs) {
        this.blockedWs += 1;
        socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        return;
      }
      const upstream = connect(this.upstream, "127.0.0.1", () => {
        const headers = { ...req.headers, host: `127.0.0.1:${this.upstream}`, origin: `http://127.0.0.1:${this.upstream}` };
        const raw = Object.entries(headers)
          .flatMap(([k, v]) => (Array.isArray(v) ? v.map((val) => `${k}: ${val}`) : v !== undefined ? [`${k}: ${v}`] : []))
          .join("\r\n");
        upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${raw}\r\n\r\n`);
        if (head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      const closeBoth = () => { socket.destroy(); upstream.destroy(); };
      upstream.on("error", closeBoth);
      socket.on("error", closeBoth);
    });
    await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", () => resolve()));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}

describe.skipIf(!existsSync(dist))("M4-17: page relay fallback and re-probe (headless Chromium)", () => {
  it("falls back to relay when direct /v3/ws fails, returns to direct on re-probe, and ?via=relay never dials /v3/ws", async () => {
    const root = mkdtempSync(join(TMP, "relay-fallback-"));
    const relayPort = await freePort();
    const gatePort = await freePort();
    const gateOrigin = `http://127.0.0.1:${gatePort}`;
    const relay = await new LocalRelay({ ALLOWED_ORIGINS: gateOrigin }, relayPort).ready();
    const meter = await new RelayMeter(() => relay.url).start();
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const server = new Server(dataDir, await freePort(), { BOTLING_SERVER_RELAY_URL: meter.url, BOTLING_SERVER_RELAY_BACKOFF_MS: "100,1000" });
    await server.ready();
    await until(() => server.daemon.log.includes("relay: room open"), { timeout: 20_000, what: "botlingd's room on the relay" });
    const gate = await new WsGate(server.port).start(gatePort);
    let browser: Awaited<ReturnType<typeof phone>> | null = null;
    try {
      browser = await phone(chromium, join(root, "profile"));
      const { page } = browser;
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(String(err)));
      const sockets: string[] = [];
      page.on("websocket", (ws) => sockets.push(ws.url()));
      // Shorten the 60 s re-probe interval in this headless browser test so direct-back runs within seconds.
      await page.addInitScript(() => {
        (globalThis as { botling3ReprobeMs?: number }).botling3ReprobeMs = 1_500;
        const seen: string[] = [];
        (globalThis as { __seenBanners?: string[] }).__seenBanners = seen;
        const obs = new MutationObserver(() => {
          const el = document.querySelector("[data-testid=conn-banner]");
          const t = el?.textContent?.trim();
          if (t && seen[seen.length - 1] !== t) seen.push(t);
        });
        window.addEventListener("DOMContentLoaded", () => obs.observe(document.body, { childList: true, subtree: true, characterData: true }));
      });

      // 1. Pair with direct blocked (using ?via=relay to pair, then open /v3/ with no ?via=).
      gate.blockWs = true;
      const cli = new PairCli(dataDir);
      const link = await cli.link();
      await page.goto(`${gate.page}?via=relay`);
      await page.getByLabel("Pairing link").fill(link);
      await page.getByRole("button", { name: "Pair" }).click();
      await page.getByTestId("pair-code").waitFor({ timeout: 30_000 });
      cli.type("y");
      await cli.line((l) => l.startsWith("Paired: "), "paired");
      await chatOf(page).locator(".composer").waitFor({ timeout: 30_000 });
      // ?via=relay never dialed /v3/ws even once.
      expect(sockets.filter((u) => u.includes("/v3/ws"))).toEqual([]);

      // 2. Load /v3/ without ?via= while direct /v3/ws is still blocked -> falls back to relay within 3 s.
      sockets.length = 0;
      const tLoad = Date.now();
      await page.goto(gate.page);
      await chatOf(page).locator(".composer").waitFor({ timeout: 30_000 });
      await expect.poll(async () => {
        return page.evaluate(() => {
          const d = (globalThis as { botling3Diagnostics?: { player: { path: string }; conn: string[] } }).botling3Diagnostics;
          return d && d.conn[d.conn.length - 1] === "live" ? d.player.path : null;
        });
      }, { timeout: 10_000 }).toBe("relay");
      expect(Date.now() - tLoad).toBeLessThan(10_000);
      expect(gate.blockedWs).toBeGreaterThan(0);
      const seenBanners = await page.evaluate(() => (globalThis as { __seenBanners?: string[] }).__seenBanners ?? []);
      expect(seenBanners.some((b) => b.includes("via relay"))).toBe(true);

      // Verify "This device" shows via relay.
      await page.getByRole("button", { name: "Bots" }).click();
      await page.getByRole("button", { name: "This device" }).click();
      await expect.poll(() => page.getByTestId("dial-path").textContent()).toBe("via relay");
      await page.getByRole("button", { name: "Done" }).click();
      await page.locator(".web-scrim").click({ position: { x: 350, y: 400 } });

      // Send over the fallback relay path.
      await say(page, "/say fallback one");
      await chatOf(page).locator("#messages .row").filter({ hasText: "fallback one" }).nth(1).waitFor({ timeout: 20_000 });

      // 3. Direct comes back -> within one re-probe, the page moves back to direct.
      const wsBefore = sockets.filter((u) => u.includes("/v3/ws")).length;
      gate.blockWs = false;
      await expect.poll(async () => {
        return page.evaluate(() => {
          const d = (globalThis as { botling3Diagnostics?: { player: { path: string }; conn: string[] } }).botling3Diagnostics;
          return d && d.conn[d.conn.length - 1] === "live" ? d.player.path : null;
        });
      }, { timeout: 15_000 }).toBe("local");
      expect(sockets.filter((u) => u.includes("/v3/ws")).length).toBeGreaterThan(wsBefore);

      await page.getByRole("button", { name: "Bots" }).click();
      await page.getByRole("button", { name: "This device" }).click();
      await expect.poll(() => page.getByTestId("dial-path").textContent()).toBe("on this computer");
      await page.getByRole("button", { name: "Done" }).click();
      await page.locator(".web-scrim").click({ position: { x: 350, y: 400 } });

      await say(page, "/say back on direct");
      await chatOf(page).locator("#messages .row").filter({ hasText: "back on direct" }).nth(1).waitFor({ timeout: 20_000 });

      const msgs = await server.messages();
      expect(msgs.filter((m) => m.role === "user" && m.text === "/say fallback one")).toHaveLength(1);
      expect(msgs.filter((m) => m.role === "user" && m.text === "/say back on direct")).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      await browser?.context.close().catch(() => undefined);
      await gate.stop().catch(() => undefined);
      await server.stop().catch(() => undefined);
      await meter.stop().catch(() => undefined);
      await relay.stop().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
