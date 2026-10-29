# Isolated candidate acceptance window

Preparation only; no UI, login, provider, or model task was launched to prepare it.
Run from the owned worktree with existing dependencies:

```sh
node desktop/test/provider-validation/staging/prepare.mjs
```

This bundles only this validation application into
`desktop/.cache/agy-staging-prepared`. It does not run the desktop build, package,
install, or change shipping gates. Its main bundle substitutes only the exact
capability module: agy workers enabled, mixed/pair routes disabled. It imports
production Bot, prompts, ACP head, workers, process ledger, and approval flow.
The renderer uses production `Web/src/components.ts` fallbackChoices and sends
actual card IDs/indices through production Bot.choose. It never calls grant or
head.answer directly. Synthetic unit choices are NOT human acceptance evidence.

## Later human-operated sequence

The following commands are prepared, not executed. From the worktree:

```sh
./desktop/.cache/agy-staging-prepared/launch.command
```

Opening the window creates a fresh private run/profile/workspace and no provider.
A trusted human Start click checks pinned ACP/helper binaries and official ACP
Keychain metadata (no credential contents). Failure stops before provider startup.
Each runner permits only one case and shuts down after five minutes. Cards expire
at the production timeout of two minutes. Never approve an unexpected action.

1. Select **Start scratch-write case**. This contacts ACP and uses model quota.
   Inspect the official worker handoff card; allow only one agy worker with the
   displayed implementation contract for private `allow-marker.txt`.
2. Inspect the worker's exact `write_file` card: relative path `allow-marker.txt`,
   content `ALLOWED`. Select **Allow once**, or **Don't allow** for a denial run.
   No other write or command is authorized by this fixture.
3. Wait for the correlated worker report. Inspect `app_task_checkpoint` with its
   actual task ID/run and concrete evidence. Allow complete only when the exact
   marker exists with the expected content; denial must produce blocked evidence.
   The UI displays marker contents. Extra read requests are outside the fixture.
4. End and close the runner. Launch a fresh runner for **Start bounded-command
   case**. Inspect its handoff and command card; allow only `sleep 30`.
5. While that command is active, click **Cancel all and end staging run**.
   This invokes production Bot.shutdown and the private ProcessLedger recovery
   path. It is a whole-run cancellation check, not an `app_cancel_task` card test.
   Record actual process identities and disappearance before accepting cleanup.
   A successful UI shutdown alone is insufficient evidence of disappearance.

Files stay under the prepared directory's `runs/run-*`: private Electron state,
store, ACP profile, workspace, run.json and evidence.json. Never share raw profile
contents; ACP may cache credentials there. Evidence is local and may contain model
text. No shared app profile, installed binary, or shipping gate is changed.
The UI has not been launched or visually verified; runtime/card evidence remains
pending. This minimal runner does not induce uncertain report delivery or crashes.
Those require a separately bounded fixture with real process observation and the
exact app_reconcile_report task/run card; unit reconstruction is not live proof.

## Official ACP login, only after separate explicit user action

No login is initiated by preparation. If the user chooses official ACP login:

```sh
./desktop/.cache/agy-staging-prepared/login.command
```

This invokes the existing pinned official server:
`/Volumes/My-SSD/botling-work/agy-engine-20261028/desktop/.cache/agy-acp-dev/server/agy_acp_server.par`.
The login-only protocol client sends `initialize`, then official
`authenticate` with `{"methodId":"oauth-personal"}`. It never creates a session
or sends a model prompt. The official server may open its browser flow; complete
that flow or interrupt the command to cancel. The client times out after five
minutes, terminates its process group and records only sanitized status. It does
not print OAuth URLs, codes, account data, or credential contents.

GEMINI_HOME points to the private `login-profile`; it isolates settings/session
files but does NOT isolate the official macOS Keychain service `gemini`, account
`antigravity-acp`. The official runtime can reuse that store without copying
credentials. Login/refresh can update the shared official account and affect other
ACP sessions. If Keychain storage is unavailable and only a private fallback token
is created, the fresh staging profiles will deliberately fail metadata preflight;
no credential copy or automatic fallback is provided. Existing live sessions have
not been proved signed out. Metadata existence alone does not prove fresh auth
validity: the vendor can request interactive login during session creation.

## Acceptance boundary

Keep shipping gates closed until independent P2 fix review, real tool inventory,
approval allow/deny binding, process disappearance, recovery/report reconciliation,
and agy-only concurrency/isolation evidence pass review. The prepared UI supplies
the real human-card path; it does not claim those checks passed. Mixed-engine
validation is required only before enabling the separate mixed gate. Activation
requires a separately reviewed enabling commit. No integration or packaging here.
