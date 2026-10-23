# Botling naming and compatibility

The product is **Botling**. Its Swift package and executable slug are `botling`;
`scripts/make-app.sh` produces `dist/Botling.app` and `dist/botling-<version>-macOS.zip`.
Use `swift run botling` for development. The checkout can keep any folder name.

Existing data is reused in place. No directory or chat migration is performed. The specific own-project bot label migration below changes metadata only:

| Retained identifier | Reason |
| --- | --- |
| `io.github.william1010121.ClaudeCodeBot` | macOS application identity, preferences and developer-mode update validation |
| `~/.claudecodebot` and every child directory | Settings, chats, archive, memories, bots, routines, plugins, Codex threads and update state stay available |
| Project `.bot/` directories | Existing notes, artifacts and worktrees remain at their recorded paths |
| Keychain service `ClaudeCodeBot plugin <name>` and its item labels | Existing plugin secrets remain discoverable |
| `claudecodebot` Codex client name and legacy protocol error text | Kept within the concurrent agent/protocol owner’s scope; no session protocol changes here |
| `CCBGitCommit`, `CCBGitDirty`, `CCB_*` environment variables | Existing build metadata, snapshot and debugging callers |
| `ccb`, `engines.ccb`, `ccb-*`, plugin RPC/global names | Installed plugins and their manifests keep working |
| `ClaudeCodeBotCore`, `ClaudeCodeBot`, their source directories and test modules | Existing Swift imports, tools, source-path checks and parallel branches remain compatible; these are internal target names, not the product name |
| `ClaudeCodeBot.focusComposer`, `ClaudeCodeBot/page-shots` and other existing cache/support paths | Notification and on-disk compatibility |
| `william1010121/ClaudeCodeBot` and existing GitHub links | The remote repository has not been renamed; release, security and sharing links must still work |

New SwiftPM resources are named `botling_ClaudeCodeBot.bundle` and
`botling_ClaudeCodeBotCore.bundle`. Both resource resolvers also accept their former
`ClaudeCodeBot_…` names. Packaged resources are checked before evaluating `Bundle.module`,
whose generated lookup can trap after the build tree disappears. The startup fix from
`05a7a51c53cfd736d0f4efc3d31b8a756989f040` is included in this branch.

BuildInfo uses `CFBundleExecutable`, so both old and new executable names remain readable.
The installer replaces the running app at its existing path, which may still be
`ClaudeCodeBot.app`; rollback state records actual paths and continues to work. A manual
installation should replace the previous copy rather than leave two applications with the
same bundle ID. Older published releases retain their original archive names.

## Integration boundaries

Delegation prompts, agent protocol/client identity, and routing behavior are owned by a
separate concurrent worker. Those files retain legacy wording in this branch (apart from
translated user-facing keys in `Bot.swift` and `Workspace.swift`). Apply any branding-only
wording updates there after integrating that worker's final rules. No delegation or model
selection behavior is changed here. Documentation screenshots are existing captures; a
new capture pass should use the integrated app so it includes the final sidebar/model UI.

## Checks

- `python3 scripts/check-app-packaging.py`: executes the packaging script with compiler and
  signing fixtures, checks the real zip, bundle metadata, executable and both resource bundles.
- `swift test --jobs 2 --filter 'CoreResourcesTests|BrandingCompatibilityTests|DeveloperModeTests|WebCaptureTests'`:
  resource relocation, old/new build metadata and affected core behavior.
- `npm run typecheck`, `npm test -- --maxWorkers=2`, `npm run build` in `Web/`.
- After sequential integration, run a real release build with `SINGLE_ARCH=1 scripts/make-app.sh`
  (already capped at two Swift jobs), relocate it and remove its original build tree, then run
  `python3 scripts/check-relocated-app.py <app> <evidence-folder>`. This last step needs a
  WindowServer and must precede distribution. The packaging fixture does not verify signing,
  launch or the full app's compilation.

## The current project bot is named `botling` (lowercase)

The original branding commit `09539aa` changed the product to **Botling** and snapshot
example project names to **Botling**. It did **not** change existing entries in
`projects.json`; project managers used their saved name, and new projects defaulted
to their folder name. Consequently the user's current project bot remained ClaudeCodeBot.

The follow-up separates these names:

| Surface | Value / behavior |
| --- | --- |
| App, window, distribution | Botling / Botling.app |
| Current own-project bot | `botling` (exact lowercase) |
| Stored identity and folder | Existing UUID and folder URL unchanged |
| Chat/archive/memory | Existing UUID-based store and `.bot/` locations unchanged; historical message text is not rewritten |

At the next workspace load in the integrated version, `loadProjects()` uses the saved
`developerProjectID` to identify the own-project manager. It changes only a legacy
`ClaudeCodeBot` name (case-insensitive) to `botling`, and only when the source folder
has this app's Package.swift target and app entry source markers. Standalone/plugin
bots, other project IDs, arbitrary same-named folders and custom project names are
excluded. The metadata write is atomic, preserves unrelated JSON fields and happens
before manager profiles are created. It does not require developer mode to be active
if that project's ID remains configured. A failed write is retried on a later load.

For a new own-source project added from a folder named ClaudeCodeBot or botling
(case-insensitive), the default is `botling`. Custom checkout folder names keep their
folder-based default. Existing installations with no configured developer project are
not guessed or renamed; the current user's installation was verified read-only to
have the correct developer project ID. No live metadata was changed by this task.

The sidebar and native chat header read `Bot.name`, derived from the manager profile's
`Project.name`; web chat payloads use the same name. They therefore pick up the migrated
label together on that next load. Folder paths, historical messages, and any external
host/coordinator UI that caches a name are separate: this code does not mutate an
external host's session metadata or force an immediate UI refresh in the running app.

Regression: `ProjectBotNamingTests` first failed against the former no-migration,
folder-default behavior, then passed with the targeted migration and naming policy.
