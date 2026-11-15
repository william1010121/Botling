import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { FileBotStore } from "../../src/core/store/bot-store";
import { MAIN_BOT_ID, MAINTAINER_ID, toSwiftDate, type ChatRecord, type ProjectRecord, type StepRecord } from "../../src/core/store/records";
import { encodeLine, INDEX_FORMAT, subagentFileName } from "../../src/core/store/subagent-store";
import { Layout } from "../../src/core/store/workspace";

export interface Fixture2xSpec {
  projectCount?: number;
  standaloneCount?: number;
  extraMainMessages?: ChatRecord[];
  brokenFiles?: string[];
  settings?: Record<string, unknown>;
  folders?: string[];
  pluginSecretPlaintext?: string;
}

export interface Fixture2xResult {
  dir: string;
  mainId: string;
  maintainerId: string;
  projectIds: string[];
  projectDirs: string[];
  standaloneIds: string[];
  standaloneDirs: string[];
  pluginName: string;
  secretKey: string;
  secretPlaintext: string;
  sealKey: string;
  mainMessages: ChatRecord[];
  mainPins: unknown[];
  mainSpecs: unknown[];
  mainTasks: unknown[];
  subagentId: string;
}

const FIXED_PROJECT_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];

const FIXED_STANDALONE_IDS = [
  "33333333-3333-4333-8333-333333333333",
];

function sealForFixture(plaintext: string, passphrase: string): string {
  const key = createHash("sha256").update(passphrase).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

function makeUuid(prefix: number, index: number): string {
  const tail = String(index).padStart(12, "0");
  const head = String(prefix).padStart(8, "0");
  return `${head}-0000-4000-8000-${tail}`;
}

export function make2xFolder(dir: string, spec: Fixture2xSpec = {}): Fixture2xResult {
  const projectCount = spec.projectCount ?? 2;
  const standaloneCount = spec.standaloneCount ?? 1;
  const sealKey = "fixture-seal-key";
  const secretPlaintext = spec.pluginSecretPlaintext ?? "fixture-secret-value";
  const pluginName = "sample-plugin";
  const secretKey = "apiToken";

  mkdirSync(dir, { recursive: true });
  const mainDir = Layout.mainBot(dir);
  mkdirSync(mainDir, { recursive: true });
  writeFileSync(join(mainDir, "memory.md"), "# Main memory\n");
  writeFileSync(join(mainDir, "note.txt"), "attachment body\n");

  const attachmentUrl = pathToFileURL(join(mainDir, "note.txt")).toString();
  const baseDate = toSwiftDate(Date.UTC(2026, 0, 1, 12, 0, 0));
  const mainMessages: ChatRecord[] = [
    { id: makeUuid(100, 1), role: "user", text: "Hello main", date: baseDate },
    { id: makeUuid(100, 2), role: "bot", text: "Hello back", date: baseDate + 5, state: "done" },
    {
      id: makeUuid(100, 3),
      role: "user",
      text: "Check the attachment",
      date: baseDate + 10,
      attachments: [{ url: attachmentUrl, kind: "file" }],
    },
    ...(spec.extraMainMessages ?? []),
  ];

  const mainPins = [
    { id: makeUuid(200, 1), messageId: mainMessages[1]!.id, name: "summary-card", data: "{\"ok\":true}", size: "2x1" },
  ];
  const mainSpecs = [
    { id: makeUuid(300, 1), messageID: mainMessages[1]!.id, name: "summary-card", status: "ready" },
  ];
  const mainTasks = [
    { id: makeUuid(400, 1), title: "Review notes", done: false },
  ];

  const mainStore = new FileBotStore(mainDir);
  mainStore.saveMessages(mainMessages);
  mainStore.saveSetting("model", "sonnet");
  mainStore.saveSetting("unread", 1);
  mainStore.saveSetting("alwaysAllowed", ["Read", "Bash(git status)"]);
  mainStore.saveList("pins.json", mainPins);
  mainStore.saveList("specs.json", mainSpecs);
  mainStore.saveList("tasks.json", mainTasks);
  mainStore.saveHead({ sessionId: "fixture-head-session", started: true });

  const subagentId = "subagent-1";
  const subagentIndex = {
    id: subagentId,
    name: "Researcher",
    status: "done",
    startedAt: Date.UTC(2026, 0, 1, 12, 1, 0),
    endedAt: Date.UTC(2026, 0, 1, 12, 2, 0),
    prompt: "Find files",
    result: "Found 2 files",
  };
  const subStep: StepRecord = {
    id: "step-1",
    kind: "tool",
    tool: "Read",
    title: "Read note.txt",
    failed: false,
    done: true,
    output: "attachment body",
  };
  mkdirSync(join(mainDir, "subagents"), { recursive: true });
  writeFileSync(join(mainDir, "subagents.json"), JSON.stringify({ format: INDEX_FORMAT, subagents: [subagentIndex] }));
  writeFileSync(
    join(mainDir, "subagents", subagentFileName(subagentId)),
    `${encodeLine({ k: "step", step: subStep })}\n`,
  );

  // Maintainer
  const maintainerChatDir = Layout.bot(dir, MAINTAINER_ID);
  mkdirSync(maintainerChatDir, { recursive: true });
  const maintainerStore = new FileBotStore(maintainerChatDir);
  maintainerStore.saveMessages([
    { id: makeUuid(500, 1), role: "user", text: "Check plugins", date: baseDate + 20 },
  ]);
  maintainerStore.saveSetting("model", "sonnet");

  // Project bots and standalone bots
  const projects: ProjectRecord[] = [];
  const projectIds: string[] = [];
  const projectDirs: string[] = [];
  for (let i = 0; i < projectCount; i++) {
    const id = FIXED_PROJECT_IDS[i] ?? makeUuid(600, i + 1);
    const workDir = join(dir, "_work", `project-${i + 1}`);
    const chatDir = Layout.bot(dir, id);
    mkdirSync(join(workDir, ".bot"), { recursive: true });
    mkdirSync(chatDir, { recursive: true });
    writeFileSync(join(workDir, ".bot", "memory.md"), `# Project ${i + 1}\n`);

    const store = new FileBotStore(chatDir);
    store.saveMessages([
      { id: makeUuid(700 + i, 1), role: "user", text: `Work on project ${i + 1}`, date: baseDate + 30 + i },
    ]);
    store.saveSetting("alwaysAllowed", ["Read"]);
    projects.push({
      id,
      name: `Project ${i + 1}`,
      folder: pathToFileURL(workDir + sep).toString(),
      avatar: "folder",
    });
    projectIds.push(id);
    projectDirs.push(workDir);
  }

  const standaloneIds: string[] = [];
  const standaloneDirs: string[] = [];
  for (let i = 0; i < standaloneCount; i++) {
    const id = FIXED_STANDALONE_IDS[i] ?? makeUuid(800, i + 1);
    const ownDir = Layout.standalone(dir, id);
    const chatDir = Layout.bot(dir, id);
    mkdirSync(join(ownDir, ".bot"), { recursive: true });
    mkdirSync(chatDir, { recursive: true });
    writeFileSync(join(ownDir, ".bot", "memory.md"), `# Standalone ${i + 1}\n`);

    const store = new FileBotStore(chatDir);
    store.saveMessages([
      { id: makeUuid(900 + i, 1), role: "bot", text: `Standalone ${i + 1} ready`, date: baseDate + 40 + i, state: "done" },
    ]);
    store.saveSetting("model", "haiku");
    projects.push({
      id,
      name: `Helper ${i + 1}`,
      folder: pathToFileURL(ownDir + sep).toString(),
      avatar: "star",
      job: "Summarize daily logs",
    });
    standaloneIds.push(id);
    standaloneDirs.push(ownDir);
  }

  writeFileSync(Layout.projectsFile(dir), JSON.stringify(projects, null, 2));

  // Settings
  const settings = {
    languageChoice: "en",
    appTheme: "dark",
    reportTheme: "system",
    pinnedBots: [MAIN_BOT_ID, ...(projectIds[0] ? [projectIds[0]] : [])],
    claudeBypassPermissions: false,
    claudeWorkerLimit: 4,
    railCollapsed: false,
    botLookChoice: "cute",
    ...(spec.settings ?? {}),
  };
  writeFileSync(Layout.settings(dir), JSON.stringify(settings, null, 2));

  // Plugins
  const pluginsDir = join(dir, "plugins");
  const samplePluginDir = join(pluginsDir, pluginName);
  mkdirSync(samplePluginDir, { recursive: true });
  writeFileSync(
    join(samplePluginDir, "package.json"),
    JSON.stringify({
      name: pluginName,
      displayName: "Sample Plugin",
      version: "1.0.0",
      engines: { ccb: "^2.0.0" },
      ccb: {
        permissions: ["messages"],
        web: "web.js",
        host: "host.js",
        contributes: {
          settings: {
            greeting: { type: "string", title: "Greeting", default: "hi" },
            [secretKey]: { type: "string", title: "API Token", secret: true, env: "SAMPLE_TOKEN" },
          },
        },
      },
    }, null, 2),
  );
  writeFileSync(join(samplePluginDir, "web.js"), "export function activate() {}\n");
  writeFileSync(join(samplePluginDir, "host.js"), "export function activate() {}\n");

  const pluginDataDir = join(dir, "plugin-data", pluginName);
  mkdirSync(pluginDataDir, { recursive: true });
  writeFileSync(join(pluginDataDir, "state.json"), JSON.stringify({ count: 1 }));

  writeFileSync(
    join(dir, "plugins.json"),
    JSON.stringify({
      disabled: [],
      settings: { [pluginName]: { greeting: "hello" } },
      failures: {},
      installed: { [pluginName]: "local" },
    }, null, 2),
  );

  writeFileSync(
    join(dir, "plugin-secrets.json"),
    JSON.stringify({
      [pluginName]: { [secretKey]: sealForFixture(secretPlaintext, sealKey) },
    }, null, 2),
  );

  // Approvals
  const folders = spec.folders ?? ["/tmp/shared-docs"];
  writeFileSync(join(dir, "folders.json"), JSON.stringify(folders));
  writeFileSync(
    join(dir, "approved-commands.json"),
    JSON.stringify({
      [mainDir]: ["git status"],
      ...(projectDirs[0] ? { [projectDirs[0]]: ["npm test"] } : {}),
    }, null, 2),
  );

  for (const rel of spec.brokenFiles ?? []) {
    writeFileSync(join(dir, rel), "{not valid json");
  }

  return {
    dir,
    mainId: MAIN_BOT_ID,
    maintainerId: MAINTAINER_ID,
    projectIds,
    projectDirs,
    standaloneIds,
    standaloneDirs,
    pluginName,
    secretKey,
    secretPlaintext,
    sealKey,
    mainMessages,
    mainPins,
    mainSpecs,
    mainTasks,
    subagentId,
  };
}
