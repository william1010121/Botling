// 2.x -> 3.x full import runner (protocol v1 §14.4, §17; M6-01d).
//
// Orders the steps:
//   reader -> id map -> media (M6-05: plan + copy, before the chats remap their attachments) -> chats (+ lists) ->
//   approvals -> settings -> plugins -> tiers -> report
//
// Strictly read-only on the 2.x source folder: source files are opened only for reading and never modified,
// locked, or renamed. Holds botlingd's data-folder lock for the whole non-dry-run import, refuses when
// botlingd is running or when the same source was already imported into this folder, and writes the final
// `import:<sha256(realSourcePath)>` meta marker only after all steps succeed so a partial run can resume
// without doubling any line.
import { existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { writeFileAtomic } from "../../core/durable/atomic";
import { PluginRegistry } from "../../core/plugins/registry";
import { MemorySecretStore } from "../../core/plugins/secrets";
import { readSettings, writeSettings, type RawSettings } from "../../core/settings";
import { CORE_EXIT_DATA_DIR_IN_USE, DataDirLock } from "../../core/store/data-dir-lock";
import { MAIN_BOT_ID, MAINTAINER_ID } from "../../core/store/records";
import { Layout, loadProjects } from "../../core/store/workspace";
import { canonicalJson } from "../../protocol";
import { RowKey } from "../../protocol/table-rows";
import { DbBotStores } from "../botstore";
import { BOTLINGD_VERSION } from "../botlingd";
import { ContentService } from "../content";
import { bindServerIdentity, loadOrCreateServerIdentity } from "../identity/keys";
import { installedFromRegistry, reconcilePluginRows } from "../replica/plugin-rows";
import { ownTableStream } from "../replica/tables";
import { PrefsStore } from "../roster/prefs";
import { refuse2xData } from "../session/paths";
import { openServerStore } from "../store";
import { openReaderDb } from "../store/connection";
import { importApprovals, type BotApprovalRef } from "./approvals";
import { importBotChat, type ImportChatsOptions } from "./chats";
import { liveBotIds, mapIds, readIdMap, saveIdMap, type IdMapRow } from "./id-map";
import {
  defaultBuiltInsDir,
  guardTargetTop,
  holderPid,
  makeWriteGuard,
  parseImportedAt,
  realPath,
  realPathOrNearest,
  sameNode,
  sameOrNested,
  secretsNode,
  sha256Text,
} from "./fs-safe";
export { guardTargetTop, holderPid, makeWriteGuard, realPath, realPathOrNearest, sameOrNested, sha256Text, type WriteGuard } from "./fs-safe";
import { copyMedia, mediaDryRunReport, mediaReport, planMedia } from "./media";
import { importPlugins } from "./plugins";
import { planRelayImport } from "./relay";
import { RELAY_SETTING_FILE, writeRelaySetting } from "../net/relay-setting";
import { looksLike2x, read2x } from "./reader-2x";
import {
  formatImportReport,
  readPluginReportEntries,
  type ImportBotReportEntry,
  type PluginReportDryRunEntry,
  type PluginReportEntry,
} from "./report";
import {
  dryRunApprovalSummary,
  mappedBots,
  prepareDryRunBot,
  readExistingBotCounts,
  reconstructIdMap,
  writeImportedWorkspaceFiles,
} from "./prepare";
import { mapSettings } from "./settings-map";

export class ImportError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "ImportError";
  }
}

export interface RunImportOptions {
  sourceDir: string;
  targetDir: string;
  dryRun?: boolean;
  designated?: boolean;
  mainId?: string;
  maintainerId?: string;
  builtInsDir?: string | null;
  now?: () => number;
  log?: (line: string) => void;
  onBatch?: ImportChatsOptions["onBatch"];
  onBotDone?: (info: { oldId: string; newId: string; index: number; total: number }) => void;
}

export interface RunImportResult {
  dryRun: boolean;
  sourceRealPath: string;
  sourceHash: string;
  reportPath: string;
  reportText: string;
  bots: ImportBotReportEntry[];
  totalLines: number;
  totalSkipped: number;
  totalPins: number;
  problems: string[];
}

export function importSourceMetaKey(sourceHash: string): string {
  return `import:${sourceHash}`;
}

export async function runImport(options: RunImportOptions): Promise<RunImportResult> {
  const dryRun = options.dryRun === true;
  const sourceResolved = resolve(options.sourceDir);
  const targetResolved = resolve(options.targetDir);

  refuse2xData(targetResolved);
  if (!looksLike2x(sourceResolved)) {
    throw new ImportError(`${sourceResolved} does not look like a Botling 2 data folder.`, 2);
  }

  // The OS spelling (case folded on a case-insensitive volume): it is also the source's identity (`sourceHash`).
  const sourceReal = realPath(sourceResolved);
  // Compare real paths and inodes: a symlinked or differently-cased spelling of either folder must not let the target
  // sit inside the 2.x folder.
  const targetReal = realPathOrNearest(targetResolved);
  if (sameOrNested(targetReal, sourceReal)) {
    throw new ImportError("The import's source and target must be separate folders.", 2);
  }
  const sourceHash = sha256Text(sourceReal);
  const metaKey = importSourceMetaKey(sourceHash);
  const reportPath = join(targetResolved, "import-report.md");

  if (holderPid(targetResolved) !== null) {
    throw new ImportError("botlingd is running; stop it first (botlingd stop).", CORE_EXIT_DATA_DIR_IN_USE);
  }

  const nowMs = options.now?.() ?? Date.now();
  const builtInsDir = options.builtInsDir !== undefined ? options.builtInsDir : defaultBuiltInsDir();

  if (dryRun) {
    let existingMainId: string | undefined;
    let existingMaintainerId: string | undefined;
    let existingLiveIds: Set<string> | undefined;
    let storedIdMap: ReturnType<typeof readIdMap> = [];

    const dbFile = join(targetResolved, "server.db");
    if (existsSync(dbFile)) {
      const reader = openReaderDb(dbFile);
      try {
        const prev = reader.prepare("SELECT value FROM meta WHERE key = ?").get(metaKey);
        if (prev && typeof prev.value === "string") {
          throw new ImportError(`This folder was imported on ${parseImportedAt(prev.value)}. Nothing was changed.`, 2);
        }
        const mRow = reader.prepare("SELECT value FROM meta WHERE key = 'ids.main'").get();
        if (mRow && typeof mRow.value === "string") existingMainId = mRow.value;
        const mgRow = reader.prepare("SELECT value FROM meta WHERE key = 'ids.maintainer'").get();
        if (mgRow && typeof mgRow.value === "string") existingMaintainerId = mgRow.value;
        existingLiveIds = liveBotIds(reader);
        storedIdMap = readIdMap(reader, sourceHash);
      } finally {
        reader.close();
      }
    }

    const read = read2x(sourceReal);
    const loadedProjects = loadProjects(sourceReal);
    const problems = [...read.problems, ...(loadedProjects.problem ? [loadedProjects.problem] : [])];

    const mainId = options.mainId ?? existingMainId ?? MAIN_BOT_ID;
    const maintainerId = options.maintainerId ?? existingMaintainerId ?? MAINTAINER_ID;
    const designated = options.designated ?? true;
    const idMap =
      storedIdMap.length > 0
        ? reconstructIdMap(read.bots, storedIdMap)
        : mapIds(read.bots, { mainId, maintainerId, designated, existingIds: existingLiveIds });
    const mapByOld = new Map(idMap.map((r) => [r.oldId, r]));
    const bots = mappedBots(read.bots, mapByOld, problems);

    const botReports: ImportBotReportEntry[] = [];
    for (const bot of bots) {
      const mapped = mapByOld.get(bot.id)!;
      const dryBot = prepareDryRunBot(bot, mapped.newId);
      problems.push(...dryBot.problems);
      botReports.push({
        oldId: bot.id,
        newId: mapped.newId,
        kind: mapped.kind,
        name: mapped.name,
        ...(mapped.clash ? { clash: true } : {}),
        lines: dryBot.lines,
        skipped: dryBot.skipped,
        pins: dryBot.lists.pins,
        missingPinLines: dryBot.lists.missingPinLines,
        specs: dryBot.lists.specs,
        tasks: dryBot.lists.tasks,
        subagents: dryBot.lists.subagents,
        subagentSteps: dryBot.lists.subagentSteps,
      });
    }

    // M6-05: the media plan only (reads, no copy).
    const mediaLines = mediaDryRunReport(planMedia(bots, idMap, sourceReal));

    const approvals = dryRunApprovalSummary(sourceReal, targetResolved, read, idMap, problems);
    const mappedSettings = mapSettings(read.settings, new Map(idMap.map((r) => [r.oldId, r.newId])));

    const registry = new PluginRegistry(
      join(sourceReal, "plugins"),
      join(sourceReal, "plugins.json"),
      new MemorySecretStore(),
      builtInsDir,
    );
    const inputs = installedFromRegistry(registry.plugins, {
      author: "import",
      dataRoot: join(sourceReal, "plugin-data"),
      log: options.log,
    });
    const pluginEntries: PluginReportDryRunEntry[] = inputs
      .filter((item) => item.name.length <= 64 && RowKey.safeParse(`plugin:${item.name}`).success)
      .map((item) => ({
        name: item.name,
        author: item.author,
        ask: item.manifest.tier,
        // A dry run reports what the live import writes: a built-in's fixed grant, no grant for anything else (B-20(a)).
        granted: (item.author === "builtin" ? "write" : null) as PluginReportDryRunEntry["granted"],
      }))
      .sort((a, b) => {
        const aBuiltIn = a.author === "builtin" ? 0 : 1;
        const bBuiltIn = b.author === "builtin" ? 0 : 1;
        if (aBuiltIn !== bBuiltIn) return aBuiltIn - bBuiltIn;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });

    const totalLines = botReports.reduce((sum, b) => sum + b.lines, 0);
    const totalSkipped = botReports.reduce((sum, b) => sum + b.skipped, 0);
    const totalPins = botReports.reduce((sum, b) => sum + b.pins, 0);
    const totalMissingPinLines = botReports.reduce((sum, b) => sum + b.missingPinLines, 0);

    const relayPlan = planRelayImport(sourceReal, targetResolved, true);
    if (relayPlan.problem) problems.push(relayPlan.problem);
    const reportText = formatImportReport({
      dryRun: true,
      reportPath,
      bots: botReports,
      totalLines,
      totalSkipped,
      totalPins,
      totalMissingPinLines,
      idMap,
      settings: {
        movedPrefs: mappedSettings.prefs.map((p) => p.key),
        machineKeys: Object.keys(mappedSettings.machine).sort(),
        layoutKeys: [...mappedSettings.layoutKeys].sort(),
        oversizedKeys: [...mappedSettings.oversizedKeys].sort(),
        relayLine: relayPlan.line,
      },
      approvals,
      plugins: pluginEntries,
      mediaLines,
      hasSecrets: read.hasSecrets,
      problems,
    });

    return {
      dryRun: true,
      sourceRealPath: sourceReal,
      sourceHash,
      reportPath,
      reportText,
      bots: botReports,
      totalLines,
      totalSkipped,
      totalPins,
      problems,
    };
  }

  // Non-dry-run: nothing may lead into the 2.x folder (a link in botlingd's folder included), then hold the lock.
  const guard = makeWriteGuard(sourceReal);
  guardTargetTop(targetResolved, guard);
  mkdirSync(targetResolved, { recursive: true, mode: 0o700 });
  const lock = new DataDirLock(targetResolved, { version: BOTLINGD_VERSION, app: "botlingd import" });
  const claim = lock.claim();
  if (!claim.ok) {
    throw new ImportError("botlingd is running; stop it first (botlingd stop).", CORE_EXIT_DATA_DIR_IN_USE);
  }

  try {
    const store = await openServerStore(targetResolved);
    try {
      const existingImport = store.meta(metaKey);
      if (existingImport !== undefined) {
        throw new ImportError(`This folder was imported on ${parseImportedAt(existingImport)}. Nothing was changed.`, 2);
      }

      const identity = await loadOrCreateServerIdentity(targetResolved, {
        create: store.meta("memberId") === undefined,
      });
      const { memberId, serverId } = await store.submit((tx) => bindServerIdentity(tx, identity));

      // 1. Reader
      const read = read2x(sourceReal);
      const loadedProjects = loadProjects(sourceReal);
      const problems = [...read.problems, ...(loadedProjects.problem ? [loadedProjects.problem] : [])];

      // 2. Id map (reused on resume if already saved for this source)
      const mainId = options.mainId ?? store.meta("ids.main") ?? MAIN_BOT_ID;
      const maintainerId = options.maintainerId ?? store.meta("ids.maintainer") ?? MAINTAINER_ID;
      const designated = options.designated ?? true;

      let storedIdMap: ReturnType<typeof readIdMap>;
      let existingIds: Set<string>;
      {
        const reader = store.openReader();
        try {
          storedIdMap = readIdMap(reader, sourceHash);
          existingIds = liveBotIds(reader);
        } finally {
          reader.close();
        }
      }

      let idMap: IdMapRow[];
      if (storedIdMap.length > 0) {
        idMap = reconstructIdMap(read.bots, storedIdMap);
      } else {
        idMap = mapIds(read.bots, { mainId, maintainerId, designated, existingIds });
        await store.submit((tx) => saveIdMap(tx, sourceHash, idMap));
      }
      const mapByOld = new Map(idMap.map((r) => [r.oldId, r]));
      const bots = mappedBots(read.bots, mapByOld, problems);

      // 9 (before the chats). Media (M6-05): plan the attachments, copy the ones inside the 2.x folder under
      // `<data>/imported/<sourceHash>/`, and hand the old -> new URL map to the chats so each line is written with (and its
      // files indexed from) the copy. The target was checked against the source above (`sameOrNested`, `guardTargetTop`);
      // `copyMedia` checks it again by real path before it writes anything.
      const mediaPlan = planMedia(bots, idMap, sourceReal);
      const mediaCopied = copyMedia(mediaPlan, targetResolved, sourceHash);
      const mediaLines = mediaReport(mediaPlan, mediaCopied);

      // 3 & 4. Chats + Lists per bot (via DbBotStores). The content service indexes each line's files in the line's own
      // transaction, as botlingd does (no media jobs and no `recover()`: botlingd does both at its next start).
      const botReports: ImportBotReportEntry[] = [];
      const stores = new DbBotStores(store);
      const content = new ContentService({
        store,
        dataDir: targetResolved,
        serverId,
        audit: (text) => options.log?.(`content: ${text}`),
      });
      try {
        for (let i = 0; i < bots.length; i++) {
          const bot = bots[i]!;
          const mapped = mapByOld.get(bot.id)!;
          const result = await importBotChat(store, stores, bot, mapped, {
            source: sourceHash,
            now: options.now,
            log: options.log,
            onBatch: options.onBatch,
            content,
            attachmentMap: mediaCopied.map,
          });
          await stores.durable();

          let lines = result.lines;
          let lists = result.lists;
          let skipped = result.skipped;
          if (result.alreadyDone) {
            const reader = store.openReader();
            try {
              const existing = readExistingBotCounts(reader, mapped.newId);
              lines = existing.lines;
              lists = existing.lists;
            } finally {
              reader.close();
            }
            // Done in an earlier run: recount (read only) what that run skipped, with the same rule the import used.
            const again = prepareDryRunBot(bot, mapped.newId);
            skipped = again.skipped;
            lists = { ...lists, missingPinLines: again.lists.missingPinLines };
          }

          problems.push(...result.problems, ...lists.problems);
          if (result.content.failed > 0) {
            problems.push(
              `bot ${mapped.newId}: ${result.content.failed} attachment(s) could not be indexed; botlingd retries them when it starts.`,
            );
          }
          botReports.push({
            oldId: bot.id,
            newId: mapped.newId,
            kind: mapped.kind,
            name: mapped.name,
            ...(mapped.clash ? { clash: true } : {}),
            lines,
            skipped,
            pins: lists.pins,
            missingPinLines: lists.missingPinLines,
            specs: lists.specs,
            tasks: lists.tasks,
            subagents: lists.subagents,
            subagentSteps: lists.subagentSteps,
          });

          options.onBotDone?.({
            oldId: bot.id,
            newId: mapped.newId,
            index: i,
            total: bots.length,
          });
        }
      } finally {
        await stores.durable().catch(() => undefined);
        await content.close().catch(() => undefined);
        await stores.close();
      }

      writeImportedWorkspaceFiles(
        sourceReal,
        targetResolved,
        loadedProjects.projects,
        idMap,
        mainId,
        maintainerId,
        problems,
        guard,
      );

      // 5. Approvals
      const botApprovalRefs: BotApprovalRef[] = bots.map((bot) => {
        const mapped = mapByOld.get(bot.id)!;
        return {
          oldId: bot.id,
          newId: mapped.newId,
          name: mapped.name,
          chatDir: bot.chatDir,
        };
      });
      guard(join(targetResolved, "folders.json"));
      guard(join(targetResolved, "approved-commands.json"));
      let approvalReport;
      {
        const reader = store.openReader();
        try {
          approvalReport = importApprovals({
            sourceDir: sourceReal,
            targetDir: targetResolved,
            idMap,
            db: reader,
            bots: botApprovalRefs,
          });
        } finally {
          reader.close();
        }
      }
      problems.push(...approvalReport.problems);

      // 6. Settings -> PrefsStore (cluster prefs) + settings.json (machine-local settings)
      const mappedSettings = mapSettings(read.settings, new Map(idMap.map((r) => [r.oldId, r.newId])));
      const prefsStore = await PrefsStore.open(store, { self: memberId, log: options.log });
      for (const pref of mappedSettings.prefs) {
        const current = prefsStore.get(pref.key);
        if (!current || canonicalJson(current.value) !== canonicalJson(pref.value)) {
          await prefsStore.set(pref.key, pref.value);
        }
      }
      const existingSettings: RawSettings = readSettings(Layout.settings(targetResolved));
      const mergedMachine: RawSettings = { ...mappedSettings.machine, ...existingSettings };
      guard(Layout.settings(targetResolved));
      writeSettings(Layout.settings(targetResolved), mergedMachine);
      // The 2.x phone relay's address (only the address) becomes botlingd's relay setting, unless one is already set.
      const relayPlan = planRelayImport(sourceReal, targetResolved, false);
      if (relayPlan.problem) problems.push(relayPlan.problem);
      if (relayPlan.write) {
        guard(join(targetResolved, RELAY_SETTING_FILE));
        writeRelaySetting(targetResolved, relayPlan.write);
      }

      // 7. Plugins + 8. Tiers
      guard(join(targetResolved, "plugins.json"));
      const secrets = secretsNode(sourceReal);
      const pluginResult = importPlugins(sourceReal, targetResolved, {
        builtInsDir,
        guardWrite: guard,
        skipSourceFile: (stat) => sameNode(stat, secrets),
      });
      problems.push(...pluginResult.problems);
      for (const mismatch of pluginResult.hashMismatches) {
        problems.push(`plugin ${mismatch.name}: folderHash mismatch (${mismatch.sourceHash} != ${mismatch.targetHash})`);
      }

      const registry = new PluginRegistry(
        join(targetResolved, "plugins"),
        join(targetResolved, "plugins.json"),
        new MemorySecretStore(),
        builtInsDir,
      );
      const pluginInputs = installedFromRegistry(registry.plugins, {
        author: "import",
        dataRoot: join(targetResolved, "plugin-data"),
        log: options.log,
      });
      await store.submit((tx) => reconcilePluginRows(tx, ownTableStream(tx), pluginInputs, nowMs, { log: options.log }));

      let pluginEntries: PluginReportEntry[];
      {
        const reader = store.openReader();
        try {
          pluginEntries = readPluginReportEntries(reader);
        } finally {
          reader.close();
        }
      }

      // 10. Secrets (M6-06 placeholder until merged) + Report + final meta mark (media ran before the chats, above)
      const totalLines = botReports.reduce((sum, b) => sum + b.lines, 0);
      const totalSkipped = botReports.reduce((sum, b) => sum + b.skipped, 0);
      const totalPins = botReports.reduce((sum, b) => sum + b.pins, 0);
      const totalMissingPinLines = botReports.reduce((sum, b) => sum + b.missingPinLines, 0);

      const reportText = formatImportReport({
        dryRun: false,
        reportPath,
        bots: botReports,
        totalLines,
        totalSkipped,
        totalPins,
        totalMissingPinLines,
        idMap,
        settings: {
          movedPrefs: mappedSettings.prefs.map((p) => p.key),
          machineKeys: Object.keys(mappedSettings.machine).sort(),
          layoutKeys: [...mappedSettings.layoutKeys].sort(),
          oversizedKeys: [...mappedSettings.oversizedKeys].sort(),
          relayLine: relayPlan.line,
        },
        approvals: {
          folders: approvalReport.folders.length,
          movedFolders: approvalReport.movedFolders.length,
          approvedCommandFolders: Object.keys(approvalReport.approvedCommands).length,
          movedCommandFolders: approvalReport.movedCommandFolders.length,
          alwaysAllowedCount: approvalReport.alwaysAllowedCount,
        },
        plugins: pluginEntries,
        mediaLines,
        hasSecrets: read.hasSecrets,
        problems,
      });

      const reportHash = sha256Text(reportText);
      const metaValue = JSON.stringify({
        at: new Date(nowMs).toISOString(),
        sourceName: basename(sourceReal),
        reportHash,
      });
      // The report file first: if it cannot be written the meta mark stays unset and a second run can redo it.
      guard(reportPath);
      writeFileAtomic(reportPath, reportText);
      await store.submit((tx) => {
        tx.prepare(
          "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        ).run(metaKey, metaValue);
      });

      return {
        dryRun: false,
        sourceRealPath: sourceReal,
        sourceHash,
        reportPath,
        reportText,
        bots: botReports,
        totalLines,
        totalSkipped,
        totalPins,
        problems,
      };
    } finally {
      await store.close();
    }
  } finally {
    lock.release();
  }
}
