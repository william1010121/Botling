// /share, in developer mode (1.x's CommunityShare.swift and Workspace+Share.swift): your features are
// the local branches ahead of upstream, each is checked (up to date, no keys or personal paths in
// what it adds), and shared as a pull request with the community-feature label, where others vote on
// it with 👍 and the owner picks what goes into the next release. The texts are 1.x's.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** Where shared features go. */
export const UPSTREAM = "william1010121/Botling";
export const LABEL = "community-feature";
/** The branch of `UPSTREAM` pull requests go to, and features are compared with. */
export const UPSTREAM_BRANCH = "main";
/** The most features the list card offers (it is a card of buttons, not a list to scroll). */
export const LISTED_FEATURES = 8;

/** One feature: a local branch with commits upstream does not have. */
export interface Feature {
  branch: string;
  /** Its first commit's subject: the pull request's title. */
  title: string;
  commits: number;
  /** Files it changes, sorted. */
  files: string[];
  /** Every commit's subject, oldest first. */
  subjects: string[];
}

/** One line of the checklist; a failed one keeps the feature from being shared. */
export interface Check { state: "ok" | "warning" | "failed"; text: string }

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** For its line on the list: "bot/x · 2 commits · 3 files". */
export const featureSummary = (feature: Feature) => `${feature.branch} · ${plural(feature.commits, "commit")} · ${plural(feature.files.length, "file")}`;

const checkLine = (check: Check) => `${check.state === "ok" ? "✓" : check.state === "warning" ? "!" : "✗"} ${check.text}`;

/** Runs git in `repo` to read it; its output, or null when it fails. */
export function git(repo: string, args: string[]): string | null {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout : null;
}

/** `GitDiff.defaultBranch`: origin's HEAD, else init.defaultBranch, main or master, whichever exists. */
function defaultBranch(repo: string): string | null {
  const exists = (branch: string) => git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) !== null;
  const head = git(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])?.trim();
  if (head?.includes("/")) {
    const name = head.slice(head.indexOf("/") + 1);
    if (name && exists(name)) return name;
  }
  const configured = git(repo, ["config", "--get", "init.defaultBranch"])?.trim();
  return [configured, "main", "master"].find((name): name is string => !!name && exists(name)) ?? null;
}

/** What features are compared with: upstream's main when that remote is there, else your fork's, else your own default branch. */
export function shareBase(repo: string): string {
  const local = defaultBranch(repo) ?? UPSTREAM_BRANCH;
  for (const ref of [`upstream/${UPSTREAM_BRANCH}`, `origin/${UPSTREAM_BRANCH}`, local]) {
    if (git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) !== null) return ref;
  }
  return local;
}

/** `branch` as a feature; null when it has nothing `base` lacks (or is not a branch). */
export function feature(repo: string, branch: string, base: string): Feature | null {
  if (branch.startsWith("-")) return null;
  const log = git(repo, ["log", "--reverse", "--format=%s", `${base}..${branch}`, "--"]);
  if (log === null) return null;
  const subjects = log.split("\n").filter(Boolean);
  if (!subjects.length) return null;
  const files = (git(repo, ["diff", "--name-only", `${base}...${branch}`, "--"]) ?? "").split("\n").filter(Boolean).sort();
  return { branch, title: subjects[0]!, commits: subjects.length, files, subjects };
}

/** The local branches ahead of `base` (the default branch and upstream's own aside), by name. */
export function features(repo: string, base = shareBase(repo)): Feature[] {
  const branches = (git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]) ?? "").split("\n").filter(Boolean);
  const mainline = new Set([UPSTREAM_BRANCH, defaultBranch(repo)].filter((name): name is string => !!name));
  return branches.filter((branch) => !mainline.has(branch)).sort().flatMap((branch) => feature(repo, branch, base) ?? []);
}

/** The owner in a GitHub remote URL (https, ssh or scp-like); null for anything else. */
export function ownerOfRemote(url: string): string | null {
  const match = /github\.com[:/]([A-Za-z0-9_.-]+)\//.exec(url.trim());
  return match?.[1] || null;
}

/** Your fork's owner on GitHub, from origin's URL; null when origin is not on GitHub. */
export const owner = (repo: string) => ownerOfRemote(git(repo, ["remote", "get-url", "origin"]) ?? "");

const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{16,}/, "an Anthropic API key"],
  [/\bsk-(proj-)?[A-Za-z0-9]{20,}/, "an OpenAI API key"],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/, "a GitHub token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
];

/** Keys, tokens and your home folder's path in the lines `diff` adds, one per file and kind: "file: what". */
export function privacyFindings(diff: string, home: string): string[] {
  let file = "";
  const found: string[] = [];
  const root = home.endsWith("/") ? home.slice(0, -1) : home;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      file = path.startsWith("b/") ? path.slice(2) : path;
      continue;
    }
    if (!line.startsWith("+")) continue;
    const added = line.slice(1);
    const kinds = SECRET_PATTERNS.filter(([pattern]) => pattern.test(added)).map(([, what]) => what);
    if (root && root !== "/" && (added.includes(`${root}/`) || added.endsWith(root))) kinds.push("your home folder's path");
    for (const kind of kinds) if (!found.includes(`${file}: ${kind}`)) found.push(`${file}: ${kind}`);
  }
  return found;
}

/** Checks `feature` before it goes out. `home` is your home folder, whose path must not be in it. */
export function checklist(repo: string, feature: Feature, base: string, home = homedir()): Check[] {
  const checks: Check[] = [];
  const current = git(repo, ["merge-base", "--is-ancestor", base, feature.branch]) !== null;
  checks.push(current ? { state: "ok", text: `Up to date with ${base}` } : { state: "warning", text: `Behind ${base}: your Manager can rebase it first, or it goes as it is` });
  const findings = privacyFindings(git(repo, ["diff", "-U0", `${base}...${feature.branch}`, "--"]) ?? "", home);
  checks.push(findings.length ? { state: "failed", text: `Privacy check: ${findings.join("; ")}` } : { state: "ok", text: "Privacy check: no keys, tokens or personal paths in the diff" });
  const fork = owner(repo);
  checks.push(fork ? { state: "ok", text: `Your fork: ${fork}/Botling` } : { state: "failed", text: `No fork on GitHub: origin should be your fork of ${UPSTREAM} (your Manager can set it up)` });
  checks.push({ state: "ok", text: `Description drafted from its ${plural(feature.commits, "commit")}` });
  // Only known once the pull request opens (the label may be missing on upstream, or not yours to add).
  checks.push({ state: "warning", text: `Label: ${LABEL}, added when the pull request opens (made on ${UPSTREAM} if it is missing); if GitHub refuses it, you are told` });
  return checks;
}

export function body(feature: Feature): string {
  const lines = ["Shared from Botling's developer mode with /share.", "", "Commits:", ...feature.subjects.map((subject) => `- ${subject}`), "", "Files:",
    ...feature.files.slice(0, 30).map((file) => `- \`${file}\``)];
  if (feature.files.length > 30) lines.push(`- …and ${feature.files.length - 30} more`);
  lines.push("", `Vote with 👍 on this pull request; the owner picks which ${LABEL}s go into the next release.`);
  return lines.join("\n");
}

/** `gh pr create` for `feature`, from `owner`'s fork to Botling's main; `label: false` leaves the label out. */
export function pullRequest(feature: Feature, forkOwner: string, label: boolean): string[] {
  const command = ["gh", "pr", "create", "--repo", UPSTREAM, "--base", UPSTREAM_BRANCH, "--head", `${forkOwner}:${feature.branch}`, "--title", feature.title, "--body", body(feature)];
  if (label) command.push("--label", LABEL);
  return command;
}

/** `gh label create` for the community-feature label on Botling, for when it is missing there. */
export const labelCreation = () => ["gh", "label", "create", LABEL, "--repo", UPSTREAM, "--color", "0E8A16", "--description", "A feature shared from developer mode with /share"];

/** The list card's words and choices: one per feature offered, then "Not now". */
export function listCard(all: Feature[], base: string): { text: string; choices: { label: string; detail?: string; recommended?: boolean }[]; offered: Feature[] } {
  const text = `**Which feature do you want to share?**\n\nThese branches have commits ${base} does not. The one you pick is checked first (up to date, no keys or personal paths), then shared as a pull request to ${UPSTREAM}.`;
  const offered = all.slice(0, LISTED_FEATURES);
  return { text, choices: [...offered.map((item) => ({ label: item.title, detail: featureSummary(item) })), { label: "Not now" }], offered };
}

/** The checklist card's words; ready when nothing failed. */
export function checklistCard(feature: Feature, checks: Check[], forkOwner: string | null): { text: string; ready: boolean } {
  const ready = !checks.some((check) => check.state === "failed");
  const lines = [`**Share "${feature.title}"** (\`${featureSummary(feature)}\`)`, "", ...checks.map(checkLine), ""];
  lines.push(ready
    ? `Opens a pull request from ${forkOwner ?? "your"}/Botling to ${UPSTREAM} and pushes ${feature.branch} to your fork first. Others vote on it with 👍; the owner picks which go into the next release.`
    : "Not ready to share: fix what is marked ✗ (your Manager can), then /share again.");
  return { text: lines.join("\n"), ready };
}

/** `GitHubCLI.locate`: gh on the PATH or where Homebrew puts it. */
function locate(tool: string): string | null {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].filter(Boolean);
  for (const dir of dirs) if (existsSync(join(dir, tool))) return join(dir, tool);
  return null;
}

export type ShareRunner = (args: string[], folder: string) => Promise<{ ok: boolean; output: string }>;

/** Runs `git` or `gh` (the first argument) in `folder` for real: pushing and opening the pull request. Its output and errors together. */
export const runShare: ShareRunner = (args, folder) => new Promise((resolve) => {
  const [tool, ...rest] = args;
  if (!tool) return resolve({ ok: false, output: "Nothing to run." });
  const file = tool === "git" || tool === "gh" ? locate(tool) : null;
  if (!file) return resolve({ ok: false, output: tool === "gh" ? "The GitHub CLI (gh) is not installed: brew install gh, then gh auth login." : `${tool} not found.` });
  const child = spawn(file, rest, { cwd: folder, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.on("error", (error) => resolve({ ok: false, output: error.message }));
  child.on("close", (code) => resolve({ ok: code === 0, output: output.trim() }));
});
