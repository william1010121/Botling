# Agent notes

- **Before writing or reviewing code, read `docs/code-standards.md`** (hard rules: breaking one is FIX FIRST; the common-mistakes checklist every handoff includes) and the lessons in `docs/LESSONS.md` tagged for your area.

## 2.x desktop app (`desktop/`)

- **Default check while working:** `cd desktop && npm run test:changed`. It typechecks, rebuilds
  `out/` and runs only the unit tests related to your changes (uncommitted work against `HEAD`,
  untracked files included). For committed work on a branch, give the base:
  `npm run test:changed -- <base-branch>`. A typical run takes seconds.
- **Typecheck on the Linux test host, not on the Mac:** locally run only `npm run build` (fast). For the
  typecheck, commit and run `desktop/scripts/remote-test.sh <sha> --typecheck-only` (add `--typecheck` before
  a test run to do both). Do not run `tsc` / `npm run typecheck` / `npm run test:changed` on the Mac in parallel
  with other workers; they are the biggest CPU load there.
- **New worktree:** run `desktop/scripts/link-deps.sh` once (no `npm install`). It links
  `desktop/node_modules` and `Web/node_modules` to the shared install for this lockfile on the
  external SSD (`/Volumes/My-SSD/botling-work/deps/desktop-<lock hash>`, made with `npm ci` the first
  time; `BOTLING_DEPS_DIR` moves it). Run it again after `package-lock.json` changes.
- Run only the relevant checks for your change and reuse evidence you already have. Do not run the
  full suite (`npm test`, `npm run test:unit`), e2e, live or packaged tests, or a package build
  during development. The full suite runs once, before a release.
- **Dev build:** `npm run dist:dir` (the unpacked app, about 15 s). Put its output and caches on a
  volume with free space: `BOTLING_DIST_DIR`, `electron_config_cache`, `ELECTRON_BUILDER_CACHE`
  (see `desktop/README.md`).
- `npm run build` only bundles `out/` (under a second); `npm run typecheck` is `tsc --noEmit` (run it on the host, see above).

## Spec program (`spec/`)

- `spec/` holds the protocols Botling must keep: TLA+ models (`spec/models/`), the same machines in TypeScript
  (`spec/reference/`), the test drivers and conformance tests. The app side is `desktop/spec-adapters/`.
  Layout and rules: `spec/README.md`.
- **Only the strong model (opus) and people change `spec/`.** Cheaper models may read it, never write it.
  App-managed workers not on a model in settings.json `specWriters` (default `["opus"]`) are refused writes there
  (`desktop/src/core/spec-guard.ts`); bot heads are not restricted. If a fix seems to need a spec change, say so in
  your report instead.
- A pull request that changes `spec/**` needs the `spec-approved` label or a `bot/spec-*` branch (the Spec gate
  workflow); `.github/CODEOWNERS` asks the owner to review `spec/` and `desktop/spec-adapters/`.
- Checks: `spec/tools/check-models.sh` (all models with TLC; needs Java, fetches the pinned jar into
  `$BOTLING_SPEC_CACHE`, locally `/Volumes/My-SSD/botling-work/cache/tla`) and `cd desktop && npm run test:spec`
  (conformance tests). CI runs both in the `spec` job.
