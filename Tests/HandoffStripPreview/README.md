This presentation regression loads the committed production `chat.html`, `chat.js`, and `chat.css` in native WKWebView, with synthetic state only. It does not operate the installed app.

```sh
npm --prefix Web run build
swiftc -parse-as-library -module-cache-path /private/tmp/handoff-strip-module-cache Tests/HandoffStripPreview/probe.swift -o /private/tmp/handoff-strip-probe
mkdir -p /private/tmp/handoff-strip-results
/private/tmp/handoff-strip-probe "$PWD" /private/tmp/handoff-strip-results
```

The matrix covers 900/654/480/360/320 CSS px × 0/1/12 long pins × none/legacy rounds/task/waiting/multiple handoffs × idle/working (150 layouts). It measures the entire row, progress, Stop and add visibility, and document/chat overflow. It additionally checks no pin capability, native Enter/Space dispatch for Stop/stopRounds, native Tab navigation with Full Keyboard Access enabled, focus through unrelated pin updates, scrolling to the last pin, its sheet and the add picker. PNGs and JSON evidence are saved in the output directory.

Before the fix, this probe fails 56/150 layouts on baseline `1f6648c`; with 12 pins plus a task handoff at 654px the row is 78px high and `oneRow` is false. After the fix it is 38px including the existing 6px top padding; controls remain 32px high. The native probe requires macOS WebKit subprocess access; a sandbox that blocks WebKit loading is not a layout result.
