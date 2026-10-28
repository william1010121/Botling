# Botling mobile client

Google sign-in candidate: see [OAuth deployment contract](../src/mobile-bridge/OAUTH-CONTRACT.md). The browser now uses
App-owned Google OAuth sessions; the bearer setup below applies only to automation. This candidate
requires the private Google credentials opt-in before deployment; Cloudflare Access is not used.

Phone-browser client, isolated from Electron and the desktop composer. Provides chat/project
navigation, text chat with refreshing replies, per-chat drafts, reply-to, engine selection,
question choices/free-text answers, task status, and an Add-to-Home-Screen manifest.
Rich cards, local files and attachments remain desktop-only. No service worker stores private
conversations or credentials. Drafts are retained per tab and verified principal, including across a page reload when storage is available.

## Build and checks

From the repository root, after `desktop/scripts/link-deps.sh`:

```
node desktop/mobile/build.mjs
node desktop/node_modules/typescript/bin/tsc --noEmit -p desktop/mobile/tsconfig.json
cd desktop
node node_modules/vitest/vitest.mjs run --config mobile/vitest.config.ts --maxWorkers=1
```

The standalone bundle is `desktop/mobile/dist/`. Serve it under `/mobile/` on the same private
HTTPS origin as the authenticated command endpoint. It has no dependency on Electron preload.
The application is not deployed, and this directory does not start any production server.

## Desktop distribution assets

The desktop `npm run dist:dir`, `dist:mac`, `dist:win` and `dist:linux` routes run
`mobile/build.mjs` after the desktop build and stop if either build fails. electron-builder
copies only `index.html`, `mobile.js`, `mobile.css`, `manifest.webmanifest` and `icon.svg`
from `mobile/dist/` into `mobile/` under the packaged resources directory, outside `app.asar`.
No frontend source, fixtures or source maps are included by this resource rule.

For a separately authorized bridge setup, the existing config's absolute `assets` path is:

- macOS: `<absolute app path>/Contents/Resources/mobile`
- Windows/Linux unpacked distribution: `<absolute application directory>/resources/mobile`

These are the `mobile` directory under Electron's `process.resourcesPath`. For a mounted
AppImage, use its actual mounted resources path; do not assume a stable installation path.
If the app moves or a versioned installation path changes, an existing explicit `assets`
path must be updated during separately authorized setup. Source development can still use
`desktop/mobile/dist/`. See [bridge setup](../src/mobile-bridge/README.md).
Packaging does not set `BOTLING_MOBILE_CONFIG`, create credentials, or start a listener.

## Browser authentication

The login button navigates only to `/api/mobile/login`; Google authentication belongs to
the app server. Session bootstrap and command requests use same-origin cookies without
following API redirects. No bearer/token field is rendered. Automation still has its separate
`/api/mobile/command` endpoint and its existing bearer/bot policy.

Session/CSRF/identity checks and deployment inputs are in the
[OAuth contract](../src/mobile-bridge/OAUTH-CONTRACT.md). Bot grants remain explicit and Main-only.
Draft text survives reload/login in tab-scoped sessionStorage for the same verified principal;
credentials and chat snapshots never go into storage. Explicit sign-out clears drafts.
Storage-disabled browsers can retain drafts only in memory.

## Isolated responsive acceptance

After the coordinator allocates validation, build only the mobile fixture bundle and run
`node desktop/mobile/fixture-server.mjs`. It binds an ephemeral loopback port, uses synthetic
conversations and sessions, and never contacts Google, Cloudflare or a real Core. The fixture
also supports POST `/fixture/control` with `authenticated` and `denied` booleans to simulate expiry
and bot denial; these routes are absent from production. The fixture is not JWT validation proof.

Exercise 320×568 and 390×844: login, return/reload, draft restoration, logout, expiry/reconnect,
bot denial, composer/keyboard-visible layout, and slow refresh with visibility/online events.
Only read-only snapshots are allowed against the live bridge; mutation/fault cases stay isolated.
Viewport interaction does not establish physical-phone or Add-to-Home-Screen acceptance.
