// "Files changed" in a worker's log: which route each file takes, and that nothing is opened that the worker did not change
// (all with fake I/O: no app is launched, no window opens).
import { describe, expect, it, vi } from "vitest";
import type { StepView } from "../../src/contract";
import { openWorkerFile, workerFileRoute, type WorkerFileIO } from "../../src/main/worker-file";

const step = (tool: string, detail: string): StepView => ({ id: detail, kind: "tool", tool, title: tool, detail, output: null, failed: false, done: true });
const steps = ["/w/a.png", "/w/doc.PDF", "/w/notes.txt", "/w/run.sh", "/w/gone.md", "src/rel.png", "docs/../docs/n.txt", "../out/esc.txt", "link/secret.txt", "/etc/hosts"].map((file) => step("Write", file));
const CWD = "/work/tree";
const io = (exists = true, real: (path: string) => string = (path) => path) => ({ exists: vi.fn(() => exists), realpath: vi.fn(real), preview: vi.fn(async () => {}), open: vi.fn(async () => {}), reveal: vi.fn() }) satisfies WorkerFileIO;

describe("workerFileRoute", () => {
  it("sends pictures and PDFs to Preview, scripts and apps to Finder, the rest to the default app", () => {
    for (const name of ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp", "f.svg", "g.pdf"]) expect(workerFileRoute(`/w/${name}`)).toBe("preview");
    for (const name of ["a.sh", "b.command", "c.app", "d.pkg", "e.dmg"]) expect(workerFileRoute(`/w/${name}`)).toBe("reveal");
    for (const name of ["a.ts", "b.md", "c.xlsx", "noext"]) expect(workerFileRoute(`/w/${name}`)).toBe("open");
  });
});

describe("openWorkerFile, paths relative to the worker's folder", () => {
  it("resolves a listed relative path against the worker's folder", async () => {
    const fake = io();
    expect(await openWorkerFile(steps, CWD, "src/rel.png", fake)).toEqual({ route: "preview" });
    expect(fake.preview.mock.calls).toEqual([["/work/tree/src/rel.png"]]);
    await openWorkerFile(steps, CWD, "docs/../docs/n.txt", fake);
    expect(fake.open.mock.calls).toEqual([["/work/tree/docs/n.txt"]]);
  });
  it("refuses a relative path with no folder, or one that is not listed", async () => {
    const fake = io();
    await expect(openWorkerFile(steps, null, "src/rel.png", fake)).rejects.toThrow("no folder");
    await expect(openWorkerFile(steps, CWD, "src/other.png", fake)).rejects.toThrow("not one this worker changed");
    expect(fake.preview).not.toHaveBeenCalled();
  });
  it("refuses a listed relative path that climbs out with ..", async () => {
    const fake = io();
    await expect(openWorkerFile(steps, CWD, "../out/esc.txt", fake)).rejects.toThrow("outside the worker's folder");
    expect(fake.open).not.toHaveBeenCalled();
  });
  it("refuses a symlink that leaves the folder, but not one that stays inside", async () => {
    const out = io(true, (path) => path === "/work/tree/link/secret.txt" ? "/private/secret.txt" : path);
    await expect(openWorkerFile(steps, CWD, "link/secret.txt", out)).rejects.toThrow("outside the worker's folder");
    expect(out.open).not.toHaveBeenCalled();
    const inside = io(true, (path) => path === "/work/tree/link/secret.txt" ? "/work/tree/real/secret.txt" : path);
    await openWorkerFile(steps, CWD, "link/secret.txt", inside);
    expect(inside.open.mock.calls).toEqual([["/work/tree/real/secret.txt"]]);
  });
  it("an absolute path that was listed opens wherever it is", async () => {
    const fake = io(true, (path) => path);
    await openWorkerFile(steps, CWD, "/etc/hosts", fake);
    expect(fake.open.mock.calls).toEqual([["/etc/hosts"]]);
  });
});

describe("openWorkerFile", () => {
  it("image / PDF -> preview; others -> default app; runnable -> Finder", async () => {
    const fake = io();
    expect(await openWorkerFile(steps, CWD, "/w/a.png", fake)).toEqual({ route: "preview" });
    expect(await openWorkerFile(steps, CWD, "/w/doc.PDF", fake)).toEqual({ route: "preview" });
    expect(await openWorkerFile(steps, CWD, "/w/notes.txt", fake)).toEqual({ route: "open" });
    expect(await openWorkerFile(steps, CWD, "/w/run.sh", fake)).toEqual({ route: "reveal" });
    expect(fake.preview.mock.calls).toEqual([["/w/a.png"], ["/w/doc.PDF"]]);
    expect(fake.open.mock.calls).toEqual([["/w/notes.txt"]]);
    expect(fake.reveal.mock.calls).toEqual([["/w/run.sh"]]);
  });

  it("a missing file is refused with a short message and nothing opens", async () => {
    const fake = io(false);
    await expect(openWorkerFile(steps, CWD, "/w/gone.md", fake)).rejects.toThrow("That file is not there any more.");
    expect(fake.open).not.toHaveBeenCalled(); expect(fake.preview).not.toHaveBeenCalled(); expect(fake.reveal).not.toHaveBeenCalled();
  });

  it("a path the worker did not change (or a relative one) is refused before the disk is touched", async () => {
    const fake = io();
    await expect(openWorkerFile(steps, CWD, "/etc/passwd", fake)).rejects.toThrow("not one this worker changed");
    await expect(openWorkerFile(steps, CWD, "a.png", fake)).rejects.toThrow("not one this worker changed");
    expect(fake.exists).not.toHaveBeenCalled();
  });
});
