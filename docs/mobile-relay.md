# Botling mobile through a relay, end-to-end encrypted

Phase 1 of Botling mobile (user decision 2026-11-08: 「先做中繼站＋端到端加密（像 Alma、Happy）」). A phone reaches
the Botling on your computer from anywhere, with no port forwarding, no tunnel on the Mac and no account. A small
relay server in the middle only passes along data it cannot read.

The existing HTTPS bridge (`desktop/src/mobile-bridge/`, Cloudflare Tunnel + token or QR) keeps working unchanged. The
relay is a second, independent way in; both are listed in Settings › Phone, and a phone may be paired either way.

## Architecture

```
 phone (browser / PWA)                 relay (relay/, k8s)                    desktop (Botling core)
 ─────────────────────                 ───────────────────                    ──────────────────────
 /mobile/ web app  ── wss /ws ──▶  rooms by id, token allow list  ◀── wss /ws ──  RelayConnector (outbound)
 RelayClient                        forwards opaque `d` strings                   core.mobileCommand + ledger
 e2e.ts (WebCrypto)                 stores nothing, logs no ids                   e2e.ts (WebCrypto)
        └──────────────── X25519 + AES-256-GCM channel, end to end ────────────────────┘
```

- **Desktop connects out.** When Settings › Phone › Relay has an address, the core's `RelayConnector`
  (`desktop/src/mobile-relay/connector.ts`) keeps one WebSocket to the relay, reconnecting with backoff (1 s → 30 s).
  It opens its *room* with a room key; the room id is the key's SHA-256, so only the key's holder can be that room's
  desktop. It then sends the relay an allow list: SHA-256 hashes of the access tokens of its paired phones and of
  pending pairing codes (with their expiry).
- **Phone connects to the relay**, joins the room with its token, and from then on the relay moves `d` strings
  between that phone and the desktop. It never parses them.
- **Inside the channel** the phone speaks the bridge's own commands — `chat.snapshot`, `chat.history`, `chat.send`,
  `chat.choose`, `chat.answer`, and now `turn.stop` — and the desktop runs them through the same checks and core call
  as the HTTPS bridge (`core.mobileCommand`, the phone's bot scope, mutation journal `<data>/mobile-mutations`). The
  desktop pushes `changed` notices (no content) when a chat the phone may read changes; the phone then reads a
  snapshot, as with the bridge's event stream.
- **The phone app** is the existing Botling Web build (`desktop/mobile/dist`), served by the relay under `/mobile/`.
  `mobile/relay-client.ts` replaces the HTTPS transport; everything above it (`web-bridge.ts`, the desktop renderer)
  is unchanged.

### Files

| Where | What |
| --- | --- |
| `relay/` | the relay server (Node 24, TypeScript run directly, one dependency `ws`), Dockerfile, tests |
| `desktop/src/mobile-relay/e2e.ts` | the E2E channel (shared by desktop and phone; WebCrypto only) |
| `desktop/src/mobile-relay/protocol.ts` | handshake and message shapes, pairing link format |
| `desktop/src/mobile-relay/store.ts` | desktop identity, room key, relay address, paired relay phones (`<data>/mobile/relay*.json`, 0600) |
| `desktop/src/mobile-relay/connector.ts` | desktop side: relay connection, pairing, per-phone channels, command dispatch, revocation |
| `desktop/src/mobile-relay/start.ts` | started by `core/main.ts`; idle until an address is set |
| `desktop/mobile/relay-client.ts` | phone side: pair, connect, requests, reconnect |
| `desktop/mobile/relay-session.ts` | phone's saved pairing in IndexedDB (non-extractable private key) |
| `desktop/src/renderer/PhoneSettings.tsx` | Settings › Phone: relay address on/off and state, pair via relay, phones list |

## Pairing (QR)

1. Settings › Phone › Relay: enter the relay's address (ours: `wss://relay.driseam.com/ws`), **Turn on**. The QR link
   uses the same host, so that host must serve the phone app under `/mobile/` (the default `full` image does). The first time, the desktop makes a
   32-byte room key and an X25519 identity key (`<data>/mobile/relay.json`, mode 0600, owner-only folder).
2. **Create pairing code** (once the relay is connected, the code points at it by default; the bridge's routes stay in
   the menu). There is no bot picker: a paired phone gets every bot, including bots added later (scope `*`, resolved
   by the core on each request; it still allows only the phone commands). The desktop makes a one-time 32-byte secret S (kept in memory only, 5 minutes,
   single use, at most 5 pending) and adds the pairing token `SHA-256("botling-relay/v1/pair-token" ‖ S)`'s hash to
   the relay's allow list with that expiry. The QR is
   `https://relay.driseam.com/mobile/#relay=<room id>&k=<desktop public key>&s=<S>&v=2` (`v=2`: the desktop takes the
   phone's acknowledgement, step 6).
   Everything secret is in the URL **fragment**, which browsers never send to a server.
3. The phone opens the page, reads and immediately clears the fragment, generates its own static X25519 key (non
   extractable) and an ephemeral one, joins the room with the pairing token, and sends
   `{h:'pair', offer: <id derived from S>, device: <phone static public key>, eph}`.
4. The desktop finds the unused offer whose token the relay admitted, generates its ephemeral key, derives the
   channel keys (below) with S mixed in, and answers `{h:'ack', eph}`.
5. The phone's first encrypted message `{t:'pair', name}` proves it holds S and its private key; the desktop records
   the phone (`relay-devices.json`: id = fingerprint of its public key, public key, hash of a new random relay
   token, bots (`["*"]`), 30-day expiry) and answers `{t:'paired', deviceId, token, coreId, botIds, expiresAt}`. The phone
   saves `{relay, room, desktop key, device id, token, private key}` in IndexedDB. The same connection carries on as
   its first session.
6. Pairing v2 (the link says `v=2` and the phone's `{t:'pair'}` says `v:2`): the phone answers `paired` with
   `{t:'ack'}` before anything else. Until it arrives the desktop keeps the new device in memory only and the code
   held for this connection; the ack stores the device and spends the code. If the connection ends first, or no ack
   comes within 15 s, the code is given back (it pairs again within its 5 minutes) and nothing is stored; a phone
   that got `paired` but whose ack was lost is refused when it connects again and says to scan the code again. When
   either side is older there is no `v` and no ack, and the pairing is final when `paired` is sent (a lost `paired`
   then spends the code). Model: `spec/models/relaypair/RelayPair.tla`.

Later connections: join with the device token, `{h:'hello', device, eph}`, ack, `{t:'hello'}` → `{t:'ready'}`.

When pairing fails, the page says why and asks for a new code; it never offers the bridge's access-token field (the
relay serves no token API). The page's first read is a snapshot without a bot: Main for an all-bots phone, else the
phone's first bot (the HTTPS bridge does the same, so a phone paired without Main is not refused).

## Cryptography

All from WebCrypto (`crypto.subtle`) on both sides — no homemade primitives, no new dependency. Node 24 / Electron and
iOS Safari 17+, Chrome 133+, Firefox 130+ provide X25519.

- Keys: X25519. Static keys for the desktop and each phone; a fresh ephemeral pair per connection on both sides.
- Agreement: `ee = DH(Ep, Ed)`, `es = DH(Ep, Sd)`, `se = DH(Sp, Ed)` (Noise KK-like: both sides authenticated by
  their static keys, forward secrecy from the ephemerals). All-zero / small-order results are refused.
- KDF: HKDF-SHA256, `ikm = ee‖es‖se`, `salt = SHA-256("botling-relay/v1/<mode>" ‖ S?)`, `info = SHA-256(transcript)`
  where the transcript binds version, mode, room, device id and all four public keys. 512 bits → one AES-256-GCM key
  per direction.
- Frames: `<counter>.<base64url(AES-256-GCM ciphertext)>`; nonce = direction tag ‖ 64-bit counter (never reused: one
  key per direction per connection); AAD = version, session id, direction, counter.
- Replay protection: each direction's counter must be exactly the next one. A repeated, skipped, reordered,
  reflected or altered frame fails and **ends the channel**; the phone reconnects with a fresh handshake.
- Key confirmation: nothing is trusted until the first encrypted message each way decrypts.

## Revocation, expiry, reconnect

- **Revoke** (Settings › Phone › Revoke, or expiry after 30 days): the desktop removes the phone's record, sends
  `{t:'revoked'}` on any open channel and closes it, then sends the relay a new allow list without that token — the
  relay closes that token's connections at once and refuses it from then on. Even a relay that ignored this could not
  help: the desktop checks the phone's record on every handshake and every request.
- **Reconnect/resume**: the phone retries with backoff (1 s, 3 s, 10 s, 30 s) and a new handshake. Requests asked
  while the channel is down wait (15 s) and are sent after it is back **with their original request id**; the
  desktop's mutation journal answers a resent `chat.send` with its first outcome (at-most-once, as the bridge).
- **Back on the page**: the page shown again, back online, or restored from the back-forward cache calls
  `RelayClient.resume`: a client waiting out its backoff connects at once, and after more than 10 s away (or a network
  change) the socket is replaced, since one that slept can look open and carry nothing. The chat on screen is then read
  again, which catches up what was missed. A page that could not connect with a kept pairing tries again on the same
  events and every 15 s.
- **Expiry**: a paired phone's 30 days start again when it connects (written at most once a day,
  `RelayStore.renew`, which never brings back a phone revoked meanwhile); the phone keeps the new expiry it is told.
- **Desktop restart / pod restart**: the relay keeps nothing; the desktop reconnects and re-sends its allow list,
  phones reconnect. A phone that joins in the moment between the desktop reopening its room and its allow list
  arriving is refused by the relay; the phone tries again and treats only three refusals in a row as a sign-out (the
  desktop's own `revoked` or handshake refusal counts at once). A second copy of the desktop (core hand-over) takes the room over; the older copy backs off 30 s.

## Threat model

Protected against a relay operator, the hosting provider, or anyone on the network:

- They cannot read or change chats, commands or answers, or forge a desktop or a phone (no private keys).
- They cannot pair a phone (the QR secret never reaches them; the desktop also requires the relay-admitted token to
  match the offer).
- They cannot replay a captured command (counters + per-connection keys).

What the relay **can** see (metadata only): room ids, token hashes, which peer ids are connected and when, frame sizes
and timing (so roughly when you use Botling and how much), client IP addresses. It does not log room ids, tokens or
addresses; it keeps nothing on disk.

What the relay **can** do: refuse service (drop or delay frames, refuse joins), and — the important limit of any
web-based E2E design — **serve modified phone app code** under `/mobile/`, which could read what the page shows.
Mitigations: serve the relay only from infrastructure you control (flux-k8s), pin the image by digest, `script-src
'self'` CSP and no third-party code; later phases add a native/PWA shell with a pinned bundle hash or the app-store
apps (phase 3). The desktop is never at risk from this: it accepts only the bridge's narrow command set per paired bot.

A stolen phone (unlocked) holds a usable session until revoked; revoke it in Settings › Phone. The private key cannot
be exported from the browser, so copying the browser's storage to another device does not carry the session (the
key is unusable outside that origin's key store — and a copied record without the key fails the handshake).

Out of scope for phase 1: hiding metadata from the relay, multi-desktop accounts, attachments from the phone.

## Push notifications (later phase)

Web Push through the relay with an encrypted payload: the phone registers a push subscription and gives it to the
desktop inside the channel; the desktop encrypts a short notice (`aes128gcm`, RFC 8291) to the subscription key and
asks the relay to deliver it (the relay holds the VAPID key and forwards opaque bytes to the push service). The push
service and relay see only that a notice was sent. iOS needs the PWA added to the home screen (16.4+).

## Phases

1. **This phase**: relay, E2E channel, QR pairing, commands incl. stop, change notices, revocation, Settings UI, tests.
2. Push notifications (above); attachments/images from the phone through the channel (chunked); per-device last-seen
   in Settings; relay metrics (counts only) for flux-k8s.
3. Installable app shell (PWA with pinned bundle, then native iOS/Android) so the app code no longer comes from the
   relay; background reconnect; QR from the phone camera inside the app.
4. Optional: several desktops per phone, metadata padding.
