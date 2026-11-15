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
docker build -f relay/Dockerfile -t botling-relay:0.1.0 .                     # relay + Botling 3 phone page (target full)
docker build -f relay/Dockerfile --target relay -t botling-relay:0.1.0-bare .   # relay only
docker build -f relay/Dockerfile --target full-2x -t botling-relay:0.1.0-2x .   # rollback: relay + 2.x page under /mobile/
```

## Configuration (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP/WebSocket port (plain; TLS ends at the ingress) |
| `HOST` | `0.0.0.0` | bind address |
| `ALLOWED_ORIGINS` | empty | browser origins allowed to open `/ws`; empty = the relay's own origin only. Clients without `Origin` (the desktop) are always allowed |
| `PUBLIC_ORIGIN` | `https://<Host>` | public origin used in the chat page CSP |
| `STATIC_V3_DIR` | `/app/public-v3` in the full image | folder with the Botling 3 page (`desktop/web-v3/dist`), served under `/v3/`. When set it is the phone page: `/` and every `/mobile` address redirect (302) to `/v3/`, and `STATIC_DIR` is not served |
| `STATIC_DIR` | `/app/public` in the full-2x image | folder with the 2.x phone web app, served under `/mobile/` (only while `STATIC_V3_DIR` is unset) |
| `TRUST_PROXY` | off | `1` behind an ingress: rate limits use the first `X-Forwarded-For` address |
| `MAX_FRAME_BYTES` | 4194304 | largest WebSocket frame |
| `MAX_CONNECTIONS` / `MAX_ROOMS` / `MAX_PEERS_PER_ROOM` | 5000 / 5000 / 16 | capacity limits |
| `CONNECTS_PER_MINUTE` | 60 | new connections per client address |
| `FAILED_JOINS_PER_MINUTE` | 10 | refused joins per client address before joins are refused outright |
| `MESSAGES_PER_SECOND` / `MESSAGE_BURST` | 50 / 200 | per connection |
| `HELLO_TIMEOUT_SECONDS` | 10 | time to identify after connecting |

Endpoints: `GET /healthz` (and `/readyz`) → `{"ok":true}`; `GET /` → `/v3/`, the Botling 3 phone page (the 2.x
image: `/` → `/mobile/`); `GET /ws` WebSocket. The WebSocket protocol is the same for 2.x and Botling 3 desktops.
State is in memory only, so any replica count works only with **one replica** (a desktop and its phones must reach
the same process); scale vertically, or add sticky routing by room later.

## Wire protocol

JSON text frames, see the header of [src/relay.ts](src/relay.ts). The relay never parses `d`.
