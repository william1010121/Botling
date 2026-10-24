WKWebView preview checks use synthetic Claude/Codex replies and the branch's actual bundled chat renderer. The fixture includes successful and waiting verdicts beside task counts, reactions and original production head portraits. No installed app is controlled.

From the worktree root, after `npm --prefix Web run build`:

```sh
swiftc -module-cache-path /private/tmp/collapsible-module-cache -parse-as-library Tests/CompletionVerificationPreview/probe.swift -o /private/tmp/collapsible-verification-probe
mkdir -p /private/tmp/collapsible-preview
/private/tmp/collapsible-verification-probe "$PWD" /private/tmp/collapsible-preview
```

The probe checks thumbs-only success in the action row, default collapsed geometry and actual click expansion below the row for both heads at 900, 360 and 320px, no horizontal overflow, and preservation of open state and keyboard focus during a live interrupted verdict/model update. It also checks checking, unavailable, unfinished, interrupted and unknown statuses remain distinct and never show a thumb. It saves eight full-view PNGs plus three collapsed reply-row closeups and `webkit-results.json`. Real Enter/Space/Tab activation was separately verified through Ego Lite; jsdom does not emulate keyboard default actions.
