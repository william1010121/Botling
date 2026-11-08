// "Files changed" in a worker's log: which route each file takes, and that nothing is opened that the worker did not change
// (all with fake I/O: no app is launched, no window opens).
import { describe, expect, it, vi } from "vitest";
import type { StepView } from "../../src/contract";
import { openWorkerFile, workerFileRoute, type WorkerFileIO } from "../../src/main/worker-file";

const step = (tool: string, detail: string): StepView => ({ id: detail, kind: "tool", tool, title: tool, detail, output: null, failed: false, done: true });
const steps = ["/w/a.png", "/w/doc.PDF", "/w/notes.txt", "/w/run.sh", "/w/gone.md"].map((file) => step("Write", file));
const io = (exists = true) => ({ exists: vi.fn(() => exists), preview: vi.fn(async () => {}), open: vi.fn(async () => {}), reveal: vi.fn() }) satisfies WorkerFileIO;

describe("workerFileRoute", () => {
  it("sends pictures and PDFs to Preview, scripts and apps to Finder, the rest to the default app", () => {
    for (const name of ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp", "f.svg", "g.pdf"]) expect(workerFileRoute(`/w/${name}`)).toBe("preview");
    for (const name of ["a.sh", "b.command", "c.app", "d.pkg", "e.dmg"]) expect(workerFileRoute(`/w/${name}`)).toBe("reveal");
    for (const name of ["a.ts", "b.md", "c.xlsx", "noext"]) expect(workerFileRoute(`/w/${name}`)).toBe("open");
  });
});

describe("openWorkerFile", () => {
  it("image / PDF -> preview; others -> default app; runnable -> Finder", async () => {
    const fake = io();
    expect(await openWorkerFile(steps, "/w/a.png", fake)).toEqual({ route: "preview" });
    expect(await openWorkerFile(steps, "/w/doc.PDF", fake)).toEqual({ route: "preview" });
    expect(await openWorkerFile(steps, "/w/notes.txt", fake)).toEqual({ route: "open" });
    expect(await openWorkerFile(steps, "/w/run.sh", fake)).toEqual({ route: "reveal" });
    expect(fake.preview.mock.calls).toEqual([["/w/a.png"], ["/w/doc.PDF"]]);
    expect(fake.open.mock.calls).toEqual([["/w/notes.txt"]]);
    expect(fake.reveal.mock.calls).toEqual([["/w/run.sh"]]);
  });

  it("a missing file is refused with a short message and nothing opens", async () => {
    const fake = io(false);
    await expect(openWorkerFile(steps, "/w/gone.md", fake)).rejects.toThrow("That file is not there any more.");
    expect(fake.open).not.toHaveBeenCalled(); expect(fake.preview).not.toHaveBeenCalled(); expect(fake.reveal).not.toHaveBeenCalled();
  });

  it("a path the worker did not change (or a relative one) is refused before the disk is touched", async () => {
    const fake = io();
    await expect(openWorkerFile(steps, "/etc/passwd", fake)).rejects.toThrow("not one this worker changed");
    await expect(openWorkerFile(steps, "a.png", fake)).rejects.toThrow("not one this worker changed");
    expect(fake.exists).not.toHaveBeenCalled();
  });
});
