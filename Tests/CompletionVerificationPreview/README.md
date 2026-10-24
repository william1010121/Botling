Native preview checks use synthetic Claude/Codex replies and the branch's actual bundled chat renderer. Avatars are intentionally omitted. No installed app is controlled.

From the worktree root, after `npm --prefix Web run build`:

```sh
swiftc -module-cache-path /private/tmp/collapsible-module-cache -parse-as-library Tests/CompletionVerificationPreview/probe.swift -o /private/tmp/collapsible-verification-probe
mkdir -p /private/tmp/collapsible-preview
/private/tmp/collapsible-verification-probe "$PWD" /private/tmp/collapsible-preview
```

The probe checks default single-line disclosure geometry and actual click expansion for both heads at 900, 360 and 320px, no horizontal overflow, and preservation of open state and keyboard focus during a live interrupted verdict/model update. It saves six PNGs and `webkit-results.json`. Real Enter/Space/Tab activation was separately verified through Ego Lite; jsdom does not emulate keyboard default actions.
