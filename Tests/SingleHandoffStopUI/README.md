# Single handoff stop native check

After `swift test --jobs 2 --no-parallel --filter SingleHandoffStop`, compile and run from the repository root:

```sh
swiftc -parse-as-library -I .build/arm64-apple-macosx/debug/Modules Tests/SingleHandoffStopUI/Probe.swift .build/arm64-apple-macosx/debug/ClaudeCodeBotCore.build/*.o -o /private/tmp/handoff-stop-native-probe
/private/tmp/handoff-stop-native-probe "$PWD" /private/tmp/handoff-stop-evidence
```

Uses a synthetic transport with the real Bot, Conductor, ChatPayload and committed chat bundle in offscreen WKWebView at 360px and 900px. The probe bridge validates the same bot/handoff UUIDs as ChatSurface and invokes Bot.stopHandoff; it does not instantiate ChatSurface.Coordinator. It clicks selected stop with two assignments present, checks only one recipient interrupt, confirms the second remains active and completes its handback, checks overflow, and saves before/after screenshots plus native-webkit.json. No installed app, account, provider, animation or emoji acceptance run is involved.
