# Web conversation pinning native preview

Synthetic data only: no credentials, live website, model, install, or app restart.
The harness compiles the actual native UI sources against the worktree's built core,
and renders `WebRailSection` at 280 and 200 points. Temporary snapshot source is
written under the evidence directory; production app snapshot flows are unchanged.

Run after the targeted Swift tests/build:

```sh
python3 Tests/WebChatPinningPreview/run.py /absolute/evidence/directory
```

The report itself must embed PNG bytes as `data:image/png;base64,...` and verify
browser image decoding. The native pictures exercise five pins (one beyond the
existing four-row collapse limit), account marks, selected older unpinned row retained alongside all pins, all four providers,
and unpinning without recreating the page.

Integration also checks provider reselect after unpin keeps the same Work account and selected row.
