# Botling naming and compatibility

The product is **Botling**. Its Swift package and executable slug are `botling`;
`scripts/make-app.sh` produces `dist/Botling.app` and `dist/botling-<version>-macOS.zip`.
Use `swift run botling` for development. The checkout can keep any folder name.

Existing data is reused in place. No automatic rename or migration is performed:

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
