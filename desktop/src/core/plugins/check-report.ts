// The plugin check's report (1.x: the Botling binary's --check-plugin), shared by the small Node
// command (check-cli.ts, development) and the app itself (`Botling --check-plugin <folder>`, which is
// what a packaged build hands Maintainer: its RunAsNode fuse is off, so Electron cannot run a script).
import { resolve } from "node:path";
import { checkPlugin } from "./manifest";

/** Exit code 0: passes; 1: problems (each on a ✗ line); 2: usage. */
export function checkReport(folder: string | undefined): { code: number; stdout: string; stderr: string } {
  if (!folder) return { code: 2, stdout: "", stderr: "usage: check-plugin <plugin folder>\n" };
  const problems = checkPlugin(resolve(folder));
  if (problems.length) return { code: 1, stdout: problems.map((problem) => `✗ ${problem}\n`).join(""), stderr: "" };
  return { code: 0, stdout: `✓ ${resolve(folder)} passes the checks.\n`, stderr: "" };
}
