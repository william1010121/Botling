# `botling run`: Botling with no GUI

`botling run` runs one task with Botling's real core under plain Node: no Electron, no window, nobody to click.
It is for benchmarks such as Harbor's terminal tasks, where Botling is measured as a harness against plain
Claude Code.

```sh
botling run --task /tasks/instruction.md --workdir /app --out /logs/agent/botling --timeout 3600
```

What it does:

1. Starts the headless core (`out/core/main.cjs`, the same core the desktop app runs, talking JSON lines on stdio)
   on a fresh, temporary data folder.
2. Adds `--workdir` as a project, so the bot is an ordinary project bot: Botling's real head prompt, its
   `app_handoff` workers and their coordination, and the built-in plugins, as in the app.
3. Sends the task as the user's message.
4. Answers what would wait for a person:
   - tool permissions are bypassed (`claudeBypassPermissions`), so nothing is asked. With `--ask-permissions`, each
     tool approval card is answered **Allow once** instead;
   - a `<choices>` card is answered with its recommended option (the first one if none is marked), and a question
     group with each question's recommended option.
5. Waits until the head is idle, no worker or background task is running and no other bot is answering in its chat,
   and all of that has held for `--settle` seconds (default 20; a worker's report wakes the head again within that time).
6. Writes the trajectory to `--out`, stops the core (no end-of-run note tidying) and exits.

The agent's shell commands run where `botling run` runs. To run them inside a task container, run `botling run` in the
container (below), the way Harbor runs its built-in `claude-code` agent. There is no `--exec` prefix: Botling, claude
and the workers all start their own processes (Bash tool, worktrees, git, file tools), so a `docker exec` prefix on the
host would cover only part of them.

## Exit codes

| code | meaning |
|---|---|
| 0 | the bot finished (its last turn ended normally and everything has been quiet for `--settle` seconds) |
| 1 | an error: the last turn failed (API error, claude crashed), the core exited, bad arguments, a missing work folder |
| 124 | `--timeout` passed (the trajectory up to then is still written) |

Whether the task passed is for the benchmark's own tests to say; exit 0 only means Botling finished.
SIGTERM or SIGINT ends the run the same way: the core is stopped and the trajectory written, then it exits 1.

## Options

| option | default | |
|---|---|---|
| `--task FILE` | | the task, sent as the user's message (`-` reads stdin) |
| `--instruction TEXT` | | the task as text instead of a file |
| `--out DIR` | required | where the trajectory goes (made if missing) |
| `--workdir DIR` | current folder | the bot's working folder |
| `--timeout SEC` | 3600 | give up after SEC seconds and exit 124; 0: no limit |
| `--settle SEC` | 20 | how long everything must stay quiet to count as finished |
| `--model NAME` | claude's default | the head's model (`claude --model`), e.g. `opus` |
| `--data-dir DIR` | a temporary folder, removed after | Botling's data folder (kept when given) |
| `--keep-bot-dir` | off | leave `<workdir>/.bot` (the bot's notes folder) in place; by default it is removed when this run made it |
| `--no-worktrees` | off | workers work in the folder itself instead of app-managed git worktrees |
| `--ask-permissions` | off | do not bypass permissions; approval cards are answered "Allow once" |

Environment it reads: `ANTHROPIC_API_KEY` (or claude's own login), `CLAUDE_CONFIG_DIR`, `BOTLING_CLAUDE_PATH`
(the claude binary, default `claude` on `PATH`), `BOTLING_MODEL` (as `--model`). Other `BOTLING_*` variables from the
calling environment are dropped, so a run started from a Botling app's shell does not touch that app's data.
When it runs as root with permissions bypassed it sets `IS_SANDBOX=1`, which claude needs to accept bypass mode as root.

## Output

```
<out>/
  summary.json          status, exitCode, error, durationSec, turns, failedTurns, workers, approvalsAnswered,
                        choicesAnswered, claudeSessions, tokens {input, output, cache_creation, cache_read}, finalText
  instruction.md        the task as sent
  chat.json             the bot's chat from its first line: every message with its steps (tool calls), and the bot's view
  chat.md               the same, readable
  workers/<id>.json     each app-managed worker's own view: its instructions, steps, messages and report
  claude-transcripts/   claude's own session transcripts (head and workers, .jsonl) written during the run
  botling/data/         Botling's files for the bot: chat.json, head.json, worker-ledger.json, subagents/*.jsonl
  botling/bot-dir/      the bot's notes folder (<workdir>/.bot): archive, memory, routines
  core.log              the core's log
```

`tokens` adds up every assistant message in the claude transcripts written during the run (each streamed message
once), head and workers together. It does not include Codex.

## Installing it in a Linux container

What it needs: **Node 22 or newer**, **git**, the **claude CLI**, and an API key. Nothing macOS-only is on this
path: no Electron, no Keychain (plugin secrets are simply absent), no native modules.

1. Build the bundle on any machine with the repo:

   ```sh
   cd desktop && scripts/pack-headless.sh --build /tmp/botling-headless
   tar -C /tmp -czf botling-headless.tgz botling-headless     # about 10 MB
   ```

   It holds `out/core`, `out/host`, `out/cli`, `out/builtin-plugins` (without the desktop terminal's native build)
   and a `botling` launcher. It is plain JavaScript, so the same bundle runs on Linux x64 and arm64.

2. In the container:

   ```sh
   # Node 22 (Debian/Ubuntu; skip if the image has node >= 22)
   apt-get update && apt-get install -y curl ca-certificates git
   curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
   npm install -g @anthropic-ai/claude-code
   mkdir -p /opt && tar -C /opt -xzf botling-headless.tgz        # → /opt/botling-headless/botling
   ln -sf /opt/botling-headless/botling /usr/local/bin/botling
   ```

3. Run, with `ANTHROPIC_API_KEY` in the environment:

   ```sh
   cd /app && botling run --task /tmp/instruction.md --out /logs/agent/botling --timeout 3000 --model opus
   ```

Checked: the packed bundle in `node:22-bookworm-slim` as root, with the fake claude, ran a task through an
`app_handoff` worker and exited 0.

## A Harbor custom agent (sketch)

Harbor's own `claude-code` agent installs claude in the task container and runs it there; a Botling agent does the
same with `botling run`. A sketch for harbor-eval to adapt (check the class and method names against the Harbor
version you use):

```python
# botling_agent.py
import os
import shlex
from pathlib import Path
from harbor.agents.installed.base import BaseInstalledAgent, ExecInput

class BotlingAgent(BaseInstalledAgent):
    @staticmethod
    def name() -> str:
        return "botling"

    @property
    def _install_agent_template_path(self) -> Path:
        return Path(__file__).parent / "install-botling.sh.j2"

    def create_run_agent_commands(self, instruction: str) -> list[ExecInput]:
        env = {"ANTHROPIC_API_KEY": os.environ["ANTHROPIC_API_KEY"]}
        model = self.model_name.split("/")[-1] if self.model_name else None
        run = (
            f"printf %s {shlex.quote(instruction)} > /tmp/instruction.md && "
            f"botling run --task /tmp/instruction.md --workdir \"$PWD\" "
            f"--out /logs/agent/botling --timeout 3000"
            + (f" --model {shlex.quote(model)}" if model else "")
            + " 2>&1 | tee /logs/agent/botling-run.txt"
        )
        return [ExecInput(command=run, env=env)]
```

```sh
# install-botling.sh.j2
set -e
apt-get update && apt-get install -y curl ca-certificates git
if ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' 2>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
fi
npm install -g @anthropic-ai/claude-code
# The bundle: uploaded into the container by the agent's setup (environment upload), or fetched from where you host it.
mkdir -p /opt && tar -C /opt -xzf /installed-agent/botling-headless.tgz
ln -sf /opt/botling-headless/botling /usr/local/bin/botling
```

Run it with `harbor run --agent-import-path botling_agent:BotlingAgent --model anthropic/claude-opus-5-5 …`, beside
the built-in `claude-code` agent on the same model, so the difference is Botling's orchestration.

Notes for comparing:

- The timeout given to `botling run` should be a little under Harbor's agent timeout, so the trajectory is written
  before Harbor kills the container exec.
- Workers default to app-managed git worktrees when the work folder is a git repository, as in the app. Their work is
  merged back by the head; pass `--no-worktrees` if a task's tests are sensitive to extra branches.
- `<workdir>/.bot` is removed at the end unless `--keep-bot-dir`, so the task folder is left as the agent changed it.

## Limits

- Claude heads only have been checked. A Codex head (`codex` CLI, `codexBypassPermissions`) uses the same path but was
  not tried.
- No live run with the real claude CLI was done while building this; the tests use the fake claude. The first real
  run is the check that bypass mode, the head prompt and the workers behave as in the app.
- `--settle` is a heuristic: a worker that goes quiet for longer than it without being counted as running would end
  the run early. Workers, background tasks and call-ins are all counted, so this should not happen in practice.
- Plugins that need secrets or the desktop (the terminal pane, the browser, phone pairing) are not available.
