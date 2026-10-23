# Relay head avatar replay

Synthetic data only. The fixture calls the actual `postGuestReply`, saves its own copy,
and serializes `ChatPayload` with the real supplied character art. The target Maintainer
text is the feedback's exact text. The preceding botling explanation is shortened, and
bot shape SVGs approximate the native bot icons. `before.json` reconstructs the legacy
missing-engine presentation; it is not an installed-app screenshot or a migration.

From this isolated worktree after the Swift tests and `Web/npm run build`:

```sh
swiftc -parse-as-library -I .build/arm64-apple-macosx/debug/Modules Tests/RelayHeadAvatarPreview/fixture.swift .build/arm64-apple-macosx/debug/ClaudeCodeBotCore.build/*.o -o /private/tmp/relay-head-fixture
/private/tmp/relay-head-fixture /absolute/path/to/evidence
swiftc -parse-as-library Tests/RelayHeadAvatarPreview/probe.swift -o /private/tmp/relay-head-probe
/private/tmp/relay-head-probe "$PWD" /absolute/path/to/evidence
```

The fixture owns and replaces only `evidence/synthetic-workspace`.
The probe loads the actual generated chat bundle in an offscreen WKWebView and explicitly
simulates document visibility. It checks decoded avatars, recorded source labels, source
engine characters, live typing, and overflow at 900/360 px; screenshots are saved locally.
No live model, installation, app restart, or real chat mutation is involved.
