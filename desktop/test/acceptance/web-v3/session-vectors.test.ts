// M2 step 3: the session layer's vectors (test/session-vectors.ts, the same cases the Node unit test runs) on one test
// page in headless Chromium (the headless shell) and headless WebKit, from the Playwright browsers already installed.
// Nothing is downloaded; no window is opened (headless only). The page is served by Playwright's request routing on
// http://localhost (a secure context, so WebCrypto is there), so no port is opened either.
//
//   PLAYWRIGHT_BROWSERS_PATH=<the Playwright cache> npx vitest run --config test/acceptance/vitest.config.mts test/acceptance/web-v3/session-vectors.test.ts
//
// An engine whose browser is not installed fails its test with "not installed" and the path it looked for.
import { build } from "esbuild";
import { chromium, webkit, type BrowserType } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { desktop } from "../../helpers";
import { writeReport } from "../m1-accept";
import type { VectorResult } from "../../session-vectors";

async function bundle(): Promise<string> {
  const result = await build({
    stdin: {
      contents: `import { runSessionVectors } from "./test/session-vectors"; (window as any).__runSessionVectors = runSessionVectors;`,
      resolveDir: desktop, loader: "ts", sourcefile: "session-vectors-page.ts",
    },
    bundle: true, write: false, platform: "browser", format: "iife", target: "es2022", logLevel: "silent",
  });
  return result.outputFiles[0]!.text;
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>session vectors</title></head><body><script src="/vectors.js"></script></body></html>`;

async function runIn(name: string, type: BrowserType) {
  const script = await bundle();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BOTLING_"))) as Record<string, string>;
  // Playwright launches an installed build and never downloads one; a missing build is reported as such.
  const browser = await type.launch({ headless: true, env }).catch((error: unknown) => {
    throw new Error(`${name} could not start (not installed in the Playwright cache?): ${String(error).split("\n")[0]}`);
  });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.route("http://localhost/**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/vectors.js") return route.fulfill({ status: 200, contentType: "text/javascript", body: script });
      if (url.pathname === "/session-vectors.html") return route.fulfill({ status: 200, contentType: "text/html", body: PAGE });
      return route.fulfill({ status: 404, body: "" });
    });
    await page.goto("http://localhost/session-vectors.html");
    const env = await page.evaluate(() => ({ secure: window.isSecureContext, subtle: !!globalThis.crypto?.subtle, userAgent: navigator.userAgent }));
    expect(errors, "page errors").toEqual([]);
    const results = await page.evaluate(() => (window as unknown as { __runSessionVectors(): Promise<VectorResult[]> }).__runSessionVectors()) as VectorResult[];
    return { engine: name, version: browser.version(), ...env, results };
  } finally {
    await browser.close();
  }
}

describe("session vectors in headless browsers", () => {
  for (const [name, type] of [["chromium", chromium], ["webkit", webkit]] as const) {
    it(`${name}: every vector passes`, async () => {
      const report = await runIn(name, type);
      const file = writeReport(`session-vectors-${name}`, report);
      const failed = report.results.filter((result) => !result.ok);
      console.log(`${name} ${report.version}: ${report.results.length - failed.length}/${report.results.length} passed (report ${file})`);
      for (const result of failed) console.log(`  FAILED ${result.name}: ${result.detail}`);
      expect(report.secure && report.subtle, "secure context with WebCrypto").toBe(true);
      expect(report.results.length).toBeGreaterThan(20);
      expect(failed).toEqual([]);
    }, 180_000);
  }
});
