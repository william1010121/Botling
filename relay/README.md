# Botling relay

Forwards end-to-end encrypted frames between a Botling desktop and its paired phones. Holds no keys, stores nothing,
logs no room ids, tokens or addresses. Design and threat model: [docs/mobile-relay.md](../docs/mobile-relay.md).

## Run and test

```sh
desktop/scripts/link-deps.sh        # once per worktree: links relay/node_modules (ws) to the desktop install
cd relay
npm test                            # node --test, real loopback WebSockets
../desktop/node_modules/.bin/tsc --noEmit -p tsconfig.json
PORT=8080 node src/main.ts          # Node 24 runs the TypeScript sources directly
```

## Image

Build from the repository root:

```sh
docker build -f relay/Dockerfile -t botling-relay:0.1.0 .                  # relay + phone web app under /mobile/
docker build -f relay/Dockerfile --target relay -t botling-relay:0.1.0-bare .  # relay only
```

## Configuration (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP/WebSocket port (plain; TLS ends at the ingress) |
| `HOST` | `0.0.0.0` | bind address |
| `ALLOWED_ORIGINS` | empty | browser origins allowed to open `/ws`; empty = the relay's own origin only. Clients without `Origin` (the desktop) are always allowed |
| `PUBLIC_ORIGIN` | `https://<Host>` | public origin used in the chat page CSP |
| `STATIC_DIR` | `/app/public` in the full image | folder with the phone web app, served under `/mobile/` |
| `TRUST_PROXY` | off | `1` behind an ingress: rate limits use the first `X-Forwarded-For` address |
| `MAX_FRAME_BYTES` | 4194304 | largest WebSocket frame |
| `MAX_CONNECTIONS` / `MAX_ROOMS` / `MAX_PEERS_PER_ROOM` | 5000 / 5000 / 16 | capacity limits |
| `CONNECTS_PER_MINUTE` | 60 | new connections per client address |
| `FAILED_JOINS_PER_MINUTE` | 10 | refused joins per client address before joins are refused outright |
| `MESSAGES_PER_SECOND` / `MESSAGE_BURST` | 50 / 200 | per connection |
| `HELLO_TIMEOUT_SECONDS` | 10 | time to identify after connecting |

Endpoints: `GET /healthz` (and `/readyz`) → `{"ok":true}`; `GET /mobile/…` the phone app; `GET /ws` WebSocket.
State is in memory only, so any replica count works only with **one replica** (a desktop and its phones must reach
the same process); scale vertically, or add sticky routing by room later.

## Wire protocol

JSON text frames, see the header of [src/relay.ts](src/relay.ts). The relay never parses `d`.
