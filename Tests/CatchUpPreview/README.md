This synthetic fixture loads the branch's generated production chat bundle in a nonpersistent WKWebView. It does not control the installed app or invoke a model.

From the worktree root:

```sh
npm --prefix Web run build
swiftc -module-cache-path /private/tmp/ccb-catch-up-module-cache -parse-as-library Tests/CatchUpPreview/probe.swift -o /private/tmp/ccb-catch-up-preview
mkdir -p /private/tmp/ccb-catch-up-preview-evidence
/private/tmp/ccb-catch-up-preview "$PWD" /private/tmp/ccb-catch-up-preview-evidence
```

Checks ready/loading/failed at 760/360/320pt, all five source links despite model omission, exact duplicate target with both labels, local report/media/attachment references, no horizontal overflow with the Both/Claude/Codex toolbar, manual/loading/empty/subagent trigger states, and actual bridge click dispatch. Saves nine screenshots and results.json. Media are references, not embedded resources: the synthetic `/tmp` targets are deliberately not opened or decoded. Link click dispatch does not prove destination files exist. This is direct chat WKWebView validation, not ccb-preview report display acceptance.
