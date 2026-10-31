# Desktop + phone web candidate validation — 2026-10-28

Base: `91d47b3e87ddcbd6eb4427b95ce60ddd1d8dbf0e` (integrated .9).
Branch: `bot/desktop-web-20261028`. Only browser client, tests and docs changed.

## Executed checks

- Mobile TypeScript `tsc --noEmit -p desktop/mobile/tsconfig.json`: passed.
- Existing mobile Vitest config: 3 files, 30 tests passed. Includes new responsive drawer,
  resize, inert conversation and Ctrl/Command+Enter/IME regressions, plus existing draft,
  offline, expired-session, logout, CSRF and transport behavior.
- Only standalone browser fixture assets were compiled with `mobile/build.mjs`; no desktop
  build, package, integration, installation, restart or deployment was performed.
- Dependencies reused the reviewed integration worktree's dependency target; both checkouts
  have the same package-lock hash. No dependency install or lockfile modification.

## Actual browser observations

Ego-browser TaskSpace 37, synthetic loopback fixture only; task closed after verification.
The fixture includes Research and Staged files solely for navigation testing, not production grants.

- 1440x900: persistent navigation after chat selection, per-chat draft retention, Enter newline,
  Command+Enter sends once and shows refreshed response.
- 390x844 and 1440x900: reload retains draft; simulated session expiry followed by fixture login
  restores it; explicit logout clears storage; fresh login starts with an empty composer.
- 390x844: mobile drawer makes conversation inert; selecting Research closes drawer;
  CDP-emulated touch on Send posts the draft and receives a response.
- Widths 320, 390, 899 and 900: no document horizontal overflow. At 900px the persistent sidebar
  appears after the media-query state update. 320x568 and 390x430 send button bottoms were
  556 and 418 respectively, within the viewport; drafts survived all resizes.
- Synthetic history with 107 messages: expansion from 100 retains the previous first message
  at y=192.15625 versus y=193 before expansion (less than 1px movement).
- Screenshots captured from final source and visually inspected:
  `/Users/guoshengwei/tool/MacOSApp/ClaudeCodeBot/.bot/artifacts/desktop-web-wide-1440.png`
  `/Users/guoshengwei/tool/MacOSApp/ClaudeCodeBot/.bot/artifacts/desktop-web-phone-390.png`
  `/Users/guoshengwei/tool/MacOSApp/ClaudeCodeBot/.bot/artifacts/desktop-web-phone-320.png`

## Limits and next integration seam

No physical phone, iOS/Safari, actual software keyboard, installed PWA, hosted
asset rollout verified. Short viewport and touch emulation are browser acceptance only.
The existing hosted entry is `https://botling-bridge.driseam.com/mobile/`; it will not serve this
candidate until separately authorized integration/deployment. The callback, allowed account,
Main-only policy and backend are unchanged. Attachments and rich reports require the desktop app.

Task/report design and prompts are untouched. Later approved design can use the existing
`.conversation`, `.messages`, `.message`, `.composer`, `.answer` layout hooks. Tasks remain in
the existing details block; rich content remains an explicit desktop-app placeholder.
