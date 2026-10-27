// Startup milestones (src/startup-marks.ts): one JSON line per milestone and launch in <logs>/startup.log,
// ms since the process began; marks before the log folder is known are written once it is; a repeated
// milestone (a core restart's "core.ready") is not written again; the log is kept small.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STARTUP_LOG_MAX_BYTES, StartupMarks } from "../../src/startup-marks";
import { tempDir } from "../helpers";

const lines = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));

describe("StartupMarks", () => {
  it("writes each milestone once, with ms since the process began, including those before the file was known", async () => {
    let now = 1_000_000;
    const file = join(tempDir("startup-marks"), "logs", "startup.log");
    const marks = new StartupMarks({ file: null, origin: 999_000, now: () => now, pid: 42 });
    expect(marks.mark("process.entry")).toBe(1_000);
    now += 500;
    marks.setFile(file);
    now += 250;
    marks.mark("app.ready");
    now += 100;
    expect(marks.mark("core.ready", { ok: true })).toBe(1_850);
    expect(marks.mark("core.ready")).toBeNull();
    await marks.flush();
    const written = lines(file);
    expect(written.map((line) => [line.mark, line.ms])).toEqual([["process.entry", 1_000], ["app.ready", 1_750], ["core.ready", 1_850]]);
    expect(written[2]).toMatchObject({ pid: 42, detail: { ok: true }, launch: marks.launch });
    expect(marks.marks()).toEqual({ "process.entry": 1_000, "app.ready": 1_750, "core.ready": 1_850 });
  });

  it("keeps no file when there is none, and cuts a large log to its newer half", async () => {
    const memoryOnly = new StartupMarks({ file: null });
    expect(memoryOnly.mark("process.entry")).toEqual(expect.any(Number));
    const folder = tempDir("startup-marks-trim");
    const file = join(folder, "startup.log");
    mkdirSync(folder, { recursive: true });
    const old = Array.from({ length: 4_000 }, (_, i) => JSON.stringify({ launch: "old", mark: `m${i}`, ms: i })).join("\n") + "\n";
    expect(old.length).toBeGreaterThan(STARTUP_LOG_MAX_BYTES);
    writeFileSync(file, old);
    const marks = new StartupMarks({ file });
    marks.mark("process.entry");
    await marks.flush();
    const text = readFileSync(file, "utf8");
    expect(text.length).toBeLessThanOrEqual(STARTUP_LOG_MAX_BYTES / 2 + 400);
    const kept = lines(file);
    expect(kept.at(-1).mark).toBe("process.entry");
    expect(kept[0].launch).toBe("old");
    expect(existsSync(file)).toBe(true);
  });
});
