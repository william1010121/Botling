# Botling 3 M3 two-server harness

Test-only support for every M3 step that needs a second server (`test/support/`):

| File | What |
|---|---|
| `two-servers.ts` | `startServers({ count, name, env })` → `TestCluster` with servers `A`, `B` (… `D`): each a built `botlingd` with its own temp data folder (under the external work volume when mounted), socket and loopback port, the fake engine, a clean environment (no inherited `BOTLING_*`). `TestServer`: `start`, `kill` (SIGKILL), `stop`, `restart`, `client()` (a scripted front end on its socket), `command`, `backup`, `restore`, `listeners`, `assertLoopbackOnly({ expectListener })`. `cluster.proxy(server, framing, seed)`; `cluster.cleanup()` stops everything and removes the root folder. |
| `fault-proxy.ts` | `FaultProxy.start({ target, framing, seed })` on `127.0.0.1`: per frame `drop`, `duplicate`, `delay` (order kept), `cut`, `halfOpen`, `partition`/`heal`, `replay(conn)` (a whole session on a new connection), `schedule({ drop, duplicate, delay })` from a seeded PRNG; every decision in `events`. |
| `framed.ts` | Framings (`length`, `websocket` = RFC 6455 messages, control frames never faulted), `framedServer` / `framedEcho` (far-side observers), `dialFramed`. |

The port is handed to botlingd as `BOTLING_SERVER_PORT` (`LISTEN_PORT_ENV`); botlingd's loopback listener (M2 step 6,
`server/net/http.ts`) binds it on 127.0.0.1, so peer tests pass `expectListener: true` and point the proxy at the
server's port (`websocket` framing for `/v3/ws`).

```sh
cd desktop
npm run build
npx vitest run test/unit/two-servers-harness.test.ts                                 # the self-test (seconds)
npx vitest run --config test/acceptance/two-servers/vitest.config.mts [file]         # long M3 runs
```
