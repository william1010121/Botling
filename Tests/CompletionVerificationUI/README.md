Run from the isolated checkout after `swift test --jobs 2 --no-parallel` and `npm --prefix Web run build`:

```sh
swiftc -parse-as-library -I .build/arm64-apple-macosx/debug/Modules Tests/CompletionVerificationUI/Probe.swift Sources/ClaudeCodeBot/CompletionVerificationSection.swift .build/arm64-apple-macosx/debug/ClaudeCodeBotCore.build/*.o -o .build/completion-verification-ui
.build/completion-verification-ui "$PWD" "$PWD/.build/completion-verification-evidence"
```

Uses real Bot, ChatPayload, shipped chat bundle in offscreen WKWebView, and the actual native settings component. Judge replies and settings catalogue are fixtures; this is not an installed app or authenticated inference test. Screenshots cover checking/result/failure at 360/900 px and settings selection at 360/680 px. JSON assertions verify status transitions, exact model labels, no failure-as-success fallback and no horizontal overflow. Settings mutations use the same workspace method tested with real subprocess argv by CompletionVerificationTests; this probe does not click the native picker.
