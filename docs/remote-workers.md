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
- **relay:** see the relay section (milestone 2).

Revoking a machine ends every connection to it straight away and stops Botling from connecting again until you
approve it again.

## What the machine needs

- Node 18 or newer and git, found on the PATH or the login shell's PATH (nvm works).
- `claude`, signed in, on the same PATH. If it lives somewhere else, write `~/.botling-agent/config.json`:
  `{"claude": "/path/to/claude"}`.
- Nothing else is installed by hand: over ssh, Botling uploads its own agent to `~/.botling-agent` the first time
  and again whenever Botling's version changes (the app and the agent always run the same version).

`~/.botling-agent` on the machine holds:

| Path | What |
| --- | --- |
| `bin/botling-agent`, `lib/botling-agent.cjs` | the launcher and the agent |
| `sessions/<worker>/` | each worker's event log, tool requests and session lock |
| `repos/<project>.git` | a bare repository per project (the bases Botling sent) |
| `work/<worker>/` | each worker's worktree, on its branch |

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
- `npm run test:spec` holds the app to the model (`spec/tests/remote-worker.spec.test.ts`).
