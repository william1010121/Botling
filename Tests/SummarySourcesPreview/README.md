Synthetic fixtures run in the generated production chat bundle; the recorder never dispatches native actions.

`probe.swift` verifies 760/360 widths, ready/loading/failed states, modal originals, message/row/frame identity, attributable exact citations, previous/next sources, static sandboxed generic cards, selected options/notes, long-card expansion, image preview/Escape, and Answer in chat. WebKit rejects even isolated-world evaluation in sandbox="" frames. The probe therefore requires nonempty image decode (complete and naturalWidth > 0) from each byte-identical snapshot srcdoc loaded in a secondary nonpersistent WKWebView; production frame sandbox, CSP and original live card stay unchanged. This is equivalent srcdoc decode evidence, not direct DOM inspection of the sandboxed frame. Opening/navigating/closing the source viewer must add zero bridge actions. Source files and installed app data are never changed by this probe.

`report.swift` links the production ClaudeCodeBotCore module and uses PagePreview.response/windowURL/previewURL for both report-window and sandbox-card routes. It checks each embedded PNG and captures both ends of the report.

An unloaded custom card is deliberately **not initialized** to obtain its source preview. Its saved data is shown with an explicit unavailable-preview label and, when applicable, Answer in chat. Loaded custom cards use a static snapshot of their existing frame; they cannot send native actions, execute scripts, submit forms, refresh commands, or navigate.

Pass `--interval` to verify manual interval summaries through the same Catch-up shell; add `--auto` for automatic interval summaries. Both use the existing synthetic card/citation fixture.
