Loads generated production chat resources in an isolated, nonpersistent WKWebView. Does not control the installed app or invoke a model.

Compile and run from the worktree root:

```sh
swiftc -module-cache-path /private/tmp/summary-fold-cache -parse-as-library Tests/SummaryFoldPreview/probe.swift -o /private/tmp/summary-fold-probe
/private/tmp/summary-fold-probe "$PWD" /absolute/evidence-directory /absolute/fixture.json
```

The fixture is a ChatState JSON with a `catchUp` range and timestamped messages. Keep private transcript fixtures outside git. Embed original image bytes as data URIs when external file access is unavailable; record original paths and hashes separately. Supply a valid avatar for each bot/notice and the composer. The probe forces lazy images eager only in the test surface and waits for every image's `complete` and positive `naturalWidth`.

Checks the selected range at 760/360pt in collapsed, expanded, and recollapsed states; records hidden-source counts, request visibility, image decoding, links, and document horizontal overflow. Saves six screenshots plus JSON. `--expect-bug` instead asserts that at least one source remains visible while collapsed; use baseline generated resources for this comparison.

This verifies the chat bundle's production WK renderer, not installed-live behavior or PagePreview report routes. Document overflow checks do not detect preexisting child clipping within an overflow-hidden ancestor. The private reported transcript remains only in local `.bot/artifacts/summary-fold-evidence`.
