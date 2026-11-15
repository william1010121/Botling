# Botling web client — desktop and phone

Botling Web runs the desktop app's own renderer (`src/renderer`: left column, the Web/src chat page,
composer, right panel, `styles.css`/`chat.css`) unchanged. `web-bridge.ts` stands in for the Electron
preload: it carries the renderer's envelopes over `/api/mobile/command`, and `WebApp.tsx`
adds access-token sign-in, Sign out and polling (the bridge has no event stream). The chat page runs in a
sandboxed, opaque-origin frame (`allow-scripts` only) served with the desktop's chat CSP.
At 700px and below the left column is a drawer over the chat (`web.css`); the right panel already
hides below 860px as on the desktop.

What the web cannot do (the bridge has no command for it): add/remove bots, groups or projects,
settings, plugins, routines, the whiteboard, attachments, component cards' own
saves/actions and subagent views. Those controls are hidden or answer "Not available in Botling Web".
Layout toggles (rail/right panel folded, pinned bots, message width) are kept in this browser only.
No service worker stores private conversations or credentials.

## Through the relay (end-to-end encrypted)

The same page also works through the phone relay ([docs/mobile-relay.md](../../docs/mobile-relay.md)): a relay
pairing link (`/mobile/#relay=…&k=…&s=…`) pairs over an end-to-end encrypted channel (`relay-client.ts`), the
pairing is kept in IndexedDB (`relay-session.ts`), and the page reconnects with it on the next visit. Sign out
forgets it. The phone's private key is stored only wrapped under a non-extractable AES-GCM key and unwrapped as a
non-extractable key: WebKit stores a record holding an X25519 CryptoKey without an error and reads it back as null.
A save is read back; a browser that does not keep it (a private tab) is told so on the page.

The home-screen app keeps its own storage apart from Safari (and the Camera app would open a scanned link in Safari),
so the sign-in page pairs on its own: **Scan QR code** opens the back camera in the page (`QrScanner.tsx`: asked
from the tap, `playsInline`, decoded with jsQR, stopped as soon as a code is read), or the pairing link is pasted
(Settings › Phone › Copy link on the desktop; Universal Clipboard carries it). A pasted link is the same one-time,
expiring secret the QR carries (`pair-input.ts`); a link for another address is opened there. No short code: one the
relay could exchange for the link would let the relay pair.

At phone width (`layout.ts`) the left column is a drawer with the open column (names and faces), never the
desktop's folded strip, whatever `railCollapsed` says; its fold button closes the drawer. The page keeps clear of the
status bar and home indicator (`env(safe-area-inset-*)`).

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
KaTeX CSS/fonts), `manifest.webmanifest`, `version.json`, `icon.svg` and the PNG icons
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

The sign-in page asks for the access token the owner issued (the same bearer token the bridge's
client file holds a hash of), or redeems a scanned pairing code for one. It is sent as
`Authorization: Bearer` on `/api/mobile/command`; there are no cookies, no session endpoints and
no Google or OAuth flow. After a successful sign-in the token is kept so the page opened again (a new tab,
the home-screen app, a tab the system discarded) signs in without a new code: only encrypted, in IndexedDB,
under a non-extractable AES-GCM key (`relay-session.ts`), for this origin. A 401 or Sign out forgets it;
revoking the phone on the desktop ends it. Each token keeps its explicit bot list. Chat snapshots never go into
storage; the layout toggles above use localStorage. The page is installable (manifest, PNG and Apple touch icons).

## Home-screen icon and updates

The icons are made from the desktop app's own icon (`Assets/AppIcon.png`): `icon-180.png` (apple-touch-icon) and
`icon-maskable-512.png` are opaque full squares (iOS paints transparency black and rounds the corners itself; Android
masks the maskable one, and the face sits inside its safe circle), `icon-192.png`/`icon-512.png` are the desktop icon as
it is (manifest `any`, the favicon and the sign-in picture), and `icon.svg` embeds the same picture.

Nothing caches the page (no service worker; the relay and the bridge send `Cache-Control: no-store`), so a cold start of
the home-screen app loads the deployed build. iOS often only resumes a suspended home-screen app, with its old code: the
build stamps its id in `index.html` (`<meta name="botling-build">`) and in `version.json`, and the sign-in page, shown
again, reloads when the server has another build (`build-check.ts`). A signed-in page picks it up the next time it opens.

## Isolated responsive acceptance

After the coordinator allocates validation, build only the mobile fixture bundle and run
`node desktop/mobile/fixture-server.mjs`. It binds an ephemeral loopback port, uses synthetic
conversations and a synthetic token, and never contacts Cloudflare or a real Core. The fixture
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


At 900 CSS pixels and wider, Chats stays visible while selecting a conversation. Below 900px,
Chats opens a full-width drawer; selection or Escape closes it. The conversation is inert while
the drawer is open. Resizing resets the drawer without clearing drafts. Desktop messages and
composer share a bounded reading width. Phone controls retain 44px minimum touch targets.

Return in the chat box (`Web/src/enter-mode.ts`): on a phone's on-screen keyboard (a touch-only device: no hover, a
coarse pointer, no fine pointer) Return is a new line and only the Send button sends; with a physical keyboard (a
desktop, a tablet with a trackpad, or once a key only a physical keyboard sends is seen, such as an iPad keyboard's
letters) Return sends and Shift+Return is a new line. An input method's Return (choosing a Zhuyin or Pinyin candidate)
never sends. Loading earlier messages retains
the current reading position. History is limited to messages returned by the existing snapshot;
this does not introduce server-side history pagination.

Drafts, reconnect, refresh, sign-in and sign-out use the existing session flow on both sizes.
The synthetic fixture includes extra bots only to exercise navigation; production browser
tokens keep their explicit bot lists. Task status rendering and rich-report placeholders are unchanged;
future approved design work can target `.conversation`, `.messages`, `.message`, `.composer`
and `.answer` without changing the session/transport contract.
