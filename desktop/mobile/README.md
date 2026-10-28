# Botling web client — desktop and phone

Google sign-in candidate: see [OAuth deployment contract](../src/mobile-bridge/OAUTH-CONTRACT.md). The browser now uses
App-owned Google OAuth sessions; the bearer setup below applies only to automation. This candidate
requires the private Google credentials opt-in before deployment; Cloudflare Access is not used.

Botling Web runs the desktop app's own renderer (`src/renderer`: left column, the Web/src chat page,
composer, right panel, `styles.css`/`chat.css`) unchanged. `web-bridge.ts` stands in for the Electron
preload: it carries the renderer's envelopes over `/api/mobile/browser/command`, and `WebApp.tsx`
adds Google sign-in, Sign out and polling (the bridge has no event stream). The chat page runs in a
sandboxed, opaque-origin frame (`allow-scripts` only) served with the desktop's chat CSP.
At 700px and below the left column is a drawer over the chat (`web.css`); the right panel already
hides below 860px as on the desktop.

What the web cannot do (the bridge has no command for it): add/remove bots, groups or projects,
settings, plugins, routines, the whiteboard, attachments, stopping a turn, component cards' own
saves/actions and subagent views. Those controls are hidden or answer "Not available in Botling Web".
Layout toggles (rail/right panel folded, pinned bots, message width) are kept in this browser only.
No service worker stores private conversations or credentials.

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
copies only the built pages, scripts and styles (`index.html`, `web.js`, `chat.html`, `chat.js`, the CSS files,
KaTeX CSS/fonts), `manifest.webmanifest` and `icon.svg`
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
[OAuth contract](../src/mobile-bridge/OAUTH-CONTRACT.md). The owner's Google session sees every bot the desktop lists (still only snapshot/send/choose/answer);
bearer clients keep their explicit bot lists.
Credentials and chat snapshots never go into storage; only the layout toggles above use localStorage.

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

## Desktop and phone behavior

The same `/mobile/` entry serves desktop and phone browsers; no second login or web-only
route is needed. The configured hosted entry is `https://botling-bridge.driseam.com/mobile/`.
The desktop layout candidate must be integrated and deployed before that URL serves these changes.
OAuth callback and Main-only grants are unchanged.

At 900 CSS pixels and wider, Chats stays visible while selecting a conversation. Below 900px,
Chats opens a full-width drawer; selection or Escape closes it. The conversation is inert while
the drawer is open. Resizing resets the drawer without clearing drafts. Desktop messages and
composer share a bounded reading width. Phone controls retain 44px minimum touch targets.

Enter inserts a newline. Ctrl+Enter or Command+Enter submits through the same guarded send
path as the Send button; IME composition does not submit. Loading earlier messages retains
the current reading position. History is limited to messages returned by the existing snapshot;
this does not introduce server-side history pagination.

Drafts, reconnect, refresh, sign-in and sign-out use the existing session flow on both sizes.
The synthetic fixture includes extra bots only to exercise navigation; production browser
sessions remain Main-only. Task status rendering and rich-report placeholders are unchanged;
future approved design work can target `.conversation`, `.messages`, `.message`, `.composer`
and `.answer` without changing the session/transport contract.
