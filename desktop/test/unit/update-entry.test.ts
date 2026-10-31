// The sidebar's update entry (renderer/update-entry.ts): none → available → downloading → ready, and error with a retry.
import { describe, expect, it } from "vitest";
import { updateEntry, updateLabel, type UpdateEntry } from "../../src/renderer/update-entry";
import type { UpdateView } from "../../src/contract";

const release = (version: string) => ({ version, name: `Botling ${version}`, url: `https://github.com/william1010121/Botling/releases/tag/v${version}`, publishedAt: null, asset: "x.zip" });
const view = (over: Partial<UpdateView> = {}): UpdateView => ({ current: "2.1.0", enabled: true, newer: release("2.1.1"), checkedAt: 1, error: null, installError: null, readyVersion: null, downloadPercent: null, ...over });
const idle = { downloading: false, error: null, failedStep: null } as const;

describe("updateEntry", () => {
  it("none: before the first answer, with the check off, nothing newer, or where this install cannot update itself", () => {
    expect(updateEntry(null, idle)).toEqual({ kind: "none" });
    expect(updateEntry(view({ enabled: false }), idle)).toEqual({ kind: "none" });
    expect(updateEntry(view({ newer: null }), idle)).toEqual({ kind: "none" });
    expect(updateEntry(view({ installError: "this is a development run, which does not update itself." }), idle)).toEqual({ kind: "none" });
  });
  it("walks none → available → downloading → ready", () => {
    const steps: UpdateEntry[] = [
      updateEntry(view({ newer: null }), idle),
      updateEntry(view(), idle),
      updateEntry(view(), { ...idle, downloading: true }),
      updateEntry(view({ downloadPercent: 40 }), { ...idle, downloading: true }),
      updateEntry(view({ readyVersion: "2.1.1" }), idle),
    ];
    expect(steps).toEqual([
      { kind: "none" },
      { kind: "available", version: "2.1.1" },
      { kind: "downloading", version: "2.1.1", percent: null },
      { kind: "downloading", version: "2.1.1", percent: 40 },
      { kind: "ready", version: "2.1.1" },
    ]);
  });
  it("an error keeps the entry and says which step to retry; ready wins over a stale download", () => {
    expect(updateEntry(view(), { downloading: false, error: "offline", failedStep: "download" })).toEqual({ kind: "error", version: "2.1.1", message: "offline", retry: "download" });
    expect(updateEntry(view({ readyVersion: "2.1.1" }), { downloading: false, error: "busy", failedStep: "restart" })).toEqual({ kind: "error", version: "2.1.1", message: "busy", retry: "restart" });
    expect(updateEntry(view({ readyVersion: "2.1.1" }), { ...idle, downloading: true })).toEqual({ kind: "ready", version: "2.1.1" });
    // A version downloaded earlier than the one now offered is not ready.
    expect(updateEntry(view({ readyVersion: "2.1.0" }), idle)).toEqual({ kind: "available", version: "2.1.1" });
  });
});

describe("updateLabel", () => {
  it("English and Traditional Chinese", () => {
    expect(updateLabel("en-US", { kind: "available", version: "2.1.1" })).toBe("Update to 2.1.1");
    expect(updateLabel("en", { kind: "downloading", version: "2.1.1", percent: 40 })).toBe("Downloading… 40%");
    expect(updateLabel("en", { kind: "downloading", version: "2.1.1", percent: null })).toBe("Downloading…");
    expect(updateLabel("en", { kind: "ready", version: "2.1.1" })).toBe("Restart to update");
    expect(updateLabel("zh-TW", { kind: "available", version: "2.1.1" })).toBe("更新至 2.1.1");
    expect(updateLabel("zh-Hant-TW", { kind: "downloading", version: "2.1.1", percent: 40 })).toBe("下載中… 40%");
    expect(updateLabel("zh-TW", { kind: "ready", version: "2.1.1" })).toBe("重新啟動以更新");
    expect(updateLabel("zh-TW", { kind: "error", version: "2.1.1", message: "x", retry: "download" })).toBe("更新失敗，點擊重試");
    expect(updateLabel("en", { kind: "error", version: "2.1.1", message: "x", retry: "restart" })).toBe("Update failed, click to retry");
    expect(updateLabel("fr", { kind: "available", version: "2.1.1" })).toBe("Update to 2.1.1");
  });
});
