// A small, synthetic Botling 1.x data folder (`~/.claudecodebot` as the Swift app writes it), for
// the importer and the end-to-end tests. Nothing here comes from a real user's folder.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const IDS = {
  manager: "11111111-1111-4111-8111-111111111111",
  standalone: "22222222-2222-4222-8222-222222222222",
  broken: "33333333-3333-4333-8333-333333333333",
  maintainer: "DEC0DE00-0000-4000-8000-00000000DEC0",
};

/** Swift's JSONEncoder date: seconds since 2001-01-01. */
const at = (iso: string) => (Date.parse(iso) - Date.UTC(2001, 0, 1)) / 1000;

export interface Fixture { source: string; projectFolder: string }

/** Writes the fixture under `root`: `root/claudecodebot` (the 1.x folder) and `root/work/blog` (a project). */
export function writeSwiftFixture(root: string): Fixture {
  const source = join(root, "claudecodebot");
  const projectFolder = join(root, "work", "blog");
  const write = (path: string, value: unknown) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  };
  mkdirSync(join(projectFolder, ".bot"), { recursive: true });
  writeFileSync(join(projectFolder, ".bot", "memory.md"), "# Blog\nThe project's own notes (stay in the project).\n");

  // The main bot: a chat with an answered tool question, a reply with steps, keys 2.0 does not
  // know (kept as they are), and one line 1.x itself would not decode (a date as text).
  write(join(source, "main", "chat.json"), [
    { id: "A0000000-0000-4000-8000-000000000001", role: "user", text: "How is the blog going?", date: at("2026-10-20T08:00:00Z") },
    {
      id: "A0000000-0000-4000-8000-000000000002", role: "bot", text: "Wants to use `Bash`:\n\n~~~\nls\n~~~", date: at("2026-10-20T08:00:05Z"),
      choices: [{ label: "Allow once", recommended: true, action: "allowOnce" }, { label: "Don't allow", recommended: false, action: "deny" }],
      chosen: 0, permissionTool: "Bash",
    },
    {
      id: "A0000000-0000-4000-8000-000000000003", role: "bot", text: "**Blog**: 40 posts, 3 drafts.", date: at("2026-10-20T08:00:20Z"),
      steps: [{ id: "toolu_1", kind: "tool", tool: "Bash", title: "Run ls", detail: "ls", output: "posts", failed: false, done: true }],
      engine: "claude", session: "5E551011-0000-4000-8000-000000000001", seenBy: ["claude"], reactions: [], futureKey: { kept: true },
    },
    { id: "A0000000-0000-4000-8000-000000000004", role: "user", text: "broken line", date: "yesterday" },
  ]);
  write(join(source, "main", "bot.json"), { model: "sonnet", alwaysAllowed: ["WebFetch"], unread: 2, routineRuns: { daily: at("2026-10-20T08:15:00Z") } });
  write(join(source, "main", "tasks.json"), [{ id: "B0000000-0000-4000-8000-000000000001", name: "Blog status", state: "done", createdAt: at("2026-10-20T08:00:00Z"), updatedAt: at("2026-10-20T08:00:20Z"), messageIDs: [] }]);
  write(join(source, "main", "subagents.json"), []);
  write(join(source, "main", "memory.md"), "# Main bot\nThe user likes short answers.\n");
  write(join(source, "main", "routines.cron"), "15 8 * * * Daily summary\n");
  write(join(source, "main", "attachments", "photo.png"), "not really a png");

  // A project's manager and a bot of its own (its folder under bots/), plus a broken chat.
  write(join(source, "projects.json"), [
    { id: IDS.manager, name: "blog", folder: pathToFileURL(projectFolder + "/").toString(), avatar: "square" },
    { id: IDS.standalone, name: "News", folder: pathToFileURL(join(source, "bots", IDS.standalone) + "/").toString(), avatar: "star", job: "Morning news, in three lines." },
    { id: IDS.broken, name: "Broken", folder: pathToFileURL(projectFolder + "/").toString(), avatar: "heart" },
    { not: "a project" },
  ]);
  write(join(source, "projects", IDS.manager, "chat.json"), [
    { id: "C0000000-0000-4000-8000-000000000001", role: "user", text: "Add a cover image to every post.", date: at("2026-10-21T09:00:00Z") },
    { id: "C0000000-0000-4000-8000-000000000002", role: "bot", text: "Done: 40 covers added.", date: at("2026-10-21T09:10:00Z"), interrupted: false },
  ]);
  write(join(source, "projects", IDS.manager, "bot.json"), { model: "opus", effort: "high", heads: { engines: ["claude"] } });
  write(join(source, "projects", IDS.standalone, "chat.json"), [
    { id: "D0000000-0000-4000-8000-000000000001", role: "bot", text: "Today: rain later.", date: at("2026-10-22T07:00:00Z") },
  ]);
  write(join(source, "bots", IDS.standalone, ".bot", "memory.md"), "# News\nSources: three papers.\n");
  write(join(source, "bots", IDS.standalone, ".bot", "routines.cron"), "0 7 * * * Morning news\n");
  write(join(source, "projects", IDS.broken, "chat.json"), "{ not json");
  write(join(source, "projects", IDS.maintainer, "chat.json"), [{ id: "E0000000-0000-4000-8000-000000000001", role: "user", text: "Fix a plugin", date: at("2026-10-19T10:00:00Z") }]);
  write(join(source, "settings.json"), { language: "en", resultPublishing: "localOnly", unknownSetting: 1 });
  write(join(source, "web", "gemini", "conversations.json"), []);
  // The plugin library: the components plugin (a component with a script beside it, and a picture
  // that is not text), another plugin's component, and a plugin's own code (not imported).
  write(join(source, "plugins", "ccb-components", "components", "status", "template.html"), "<div>status</div>");
  write(join(source, "plugins", "ccb-components", "components", "status", "about.md"), "Status card: whether it is OK.\nCommand: ./scan.sh");
  write(join(source, "plugins", "ccb-components", "components", "status", "scan.sh"), "#!/bin/sh\necho '{}'\n");
  write(join(source, "plugins", "ccb-components", "components", "status", "icon.png"), "binary");
  write(join(source, "plugins", "ccb-components", ".git", "HEAD"), "ref: refs/heads/main\n");
  write(join(source, "plugins", "weather", "components", "forecast", "template.html"), "<div>sunny</div>");
  write(join(source, "plugins", "weather", "plugin.json"), { name: "weather" });
  return { source, projectFolder };
}
