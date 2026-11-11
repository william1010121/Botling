# Workers on other machines

A Claude worker can run on another computer while the bot that started it stays in Botling. The coordinator passes
`machine` to `app_handoff`; everything else about the worker is the same: its stream, its approval cards, its report,
`app_send_message` and `app_cancel_task`.

The protocol is `spec/models/remoteworker/RemoteWorker.tla`. The app's side is `desktop/src/remote/`; the machine's
side is `botling-agent` (`desktop/src/remote/agent/`, bundled to `out/agent/botling-agent.cjs`, plain Node 18+).

## Adding a machine

Machines are listed in Settings › Machines (`<data>/remote/machines.json`).

- **ssh:** pick a host from `~/.ssh/config`. Botling reads its host key and shows the fingerprint (and whether
  `~/.ssh/known_hosts` already has it). Once you approve it, Botling writes the key to its own file
  (`<data>/remote/known_hosts`, under the alias `botling-<id>`) and checks the key strictly on every connection.
  Botling runs ssh with `BatchMode=yes`, so `ssh <host>` must work without a password prompt (keys or an agent).
  Hosts behind ProxyJump are not supported on this path yet; use the relay.
- **relay:** for a machine Botling cannot reach (no public address, no VPN). See [Over the relay](#over-the-relay).

Revoking a machine ends every connection to it straight away and stops Botling from connecting again until you
approve it again.

## Over the relay

The machine's agent dials out to the same relay the phone uses (Settings › Phone › Relay, or
`BOTLING_MACHINE_RELAY`); Botling is the desk of its own machines room there (`<data>/remote/relay.json`: that room's
key and Botling's key for it). Everything between Botling and the agent is end-to-end encrypted
(`desktop/src/mobile-relay/e2e.ts`); the relay moves ciphertext and checks token hashes, nothing else. Botling only
holds a relay connection while a relay machine is approved or a pairing is open.

Pairing (device code):

1. Settings › Machines › Add over the relay gives a one-line command, good for 10 minutes and one machine:
   `curl -fsSL …/botling-agent-install.sh | sh -s -- 'botling-machine1.…'`. The script installs botling-agent (from
   the GitHub release of Botling's version, checked against its checksum and signature) and runs
   `botling-agent pair`.
2. The machine prints its name, its fingerprint and a code such as `53RV-XFK8`. Botling lists the request with the
   same name and fingerprint.
3. Type the code in Botling. A wrong code three times declines the request. On a match, Botling sends the machine its
   own token (kept in `~/.botling-agent/relay.json`, 0600) and approves it.
4. `botling-agent relay` (the script starts it) keeps the machine connected. It reconnects by itself with backoff.

The install script takes `--name NAME` (the name Botling shows), `--no-start` and `--no-pair`. It keeps the agent
running as a systemd user service on Linux (`loginctl enable-linger` keeps it up after you log out), a LaunchAgent on
macOS, or in the background elsewhere (`~/.botling-agent/relay.log`).

### Versions over the relay

The agent and Botling run the same version, as over ssh. When Botling meets an older agent, it asks it to update: the
agent downloads `botling-agent-<version>.cjs` from the GitHub release of Botling's version, installs it only if its
SHA-256 is the one Botling sent over the encrypted channel (the agent bundle inside Botling is that same file), then
restarts and reconnects. The install line carries the same SHA-256 (`--sha`), so the install script never runs a
download that is not Botling's own agent. A Botling built locally ships an agent no release has; it cannot update a
relay machine (install that machine's agent by hand, or over ssh).

The release assets are built by `npm run dist:agent` (`scripts/agent-release.mjs`): the agent, its install script and
`SHA256SUMS-agent.txt`. The release workflow builds them in the macOS job from the bundle that goes into the app, and
publishes them with the release.

Revoking a relay machine takes its token off the relay's allow list, so the relay closes its connection at once, and
the agent cannot join again; pair it again with a new line.

## What the machine needs

- Node 18 or newer and git, found on the PATH or the login shell's PATH (nvm works).
- `claude`, signed in, on the same PATH. If it lives somewhere else, write `~/.botling-agent/config.json`:
  `{"claude": "/path/to/claude"}`.
- Nothing else is installed by hand: over ssh, Botling uploads its own agent to `~/.botling-agent` the first time
  and again whenever Botling's version changes (the app and the agent always run the same version). Over the relay,
  the agent fetches the release of Botling's version itself and checks it before it replaces itself.

`~/.botling-agent` on the machine holds:

| Path | What |
| --- | --- |
| `bin/botling-agent`, `lib/botling-agent.cjs` | the launcher and the agent |
| `sessions/<worker>/` | each worker's event log, tool requests and session lock |
| `repos/<project>.git` | a bare repository per project (the bases Botling sent) |
| `work/<worker>/` | each worker's worktree, on its branch |
| `relay.json`, `relay.pid` | relay only: this machine's key, the relay, its token; the daemon running |

## Project files

When a worker starts, Botling sends the project's current commit (`HEAD` of the repository the worker would have run
in) as a git bundle. Uncommitted changes on your computer are not sent. The worker works on a branch
`bot/remote-<name>-<id>` in its own worktree on the machine. When each run ends, Botling takes the branch back and
replays its commits onto the commit it started from, so the branch appears in your repository with the worker's
commits (anything the worker left uncommitted is committed for it). The report says which branch. Merging is up to you.

The commit Botling sends is a snapshot (the same files, no history), so the machine never gets the repository's
history and later sends carry only what changed.

## Connections and approvals

Each connection is numbered. If it drops (network, sleep, the laptop lid), claude on the machine is stopped and the
worker shows as interrupted. Botling reconnects with backoff, fetches the events it missed, and resumes the worker on
the same Claude session (`--resume`), telling it the connection was lost.

Approval cards for remote workers are always answered by you. An answer that cannot reach the claude that asked
(the connection is down, or it changed while the answer was on its way) is refused: nothing runs, and the card opens
again saying so. When the resumed claude asks the same thing again, the same card is live again.

## Checking it

- `cd desktop && npx vitest run test/unit/remote-worker-ssh.test.ts test/unit/remote-agent-lock.test.ts` runs the
  ssh path end to end with a fake ssh and the fake claude, and the session lock across agent processes.
- `npx vitest run test/unit/remote-worker-relay.test.ts` pairs a machine over the relay's own room logic, runs a
  worker there, drops the channel, revokes it, and pairs over a real relay server with the agent's own WebSocket
  client (Node 18 has none).
- `npx vitest run test/unit/remote-agent-release.test.ts` builds the release assets and runs the install script and
  the agent's own upgrade against a local server standing in for the release.
- `npm run test:spec` holds the app to the model (`spec/tests/remote-worker.spec.test.ts`).
