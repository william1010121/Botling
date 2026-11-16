# Agent notes

- **Before writing or reviewing code, read `docs/code-standards.md`** (hard rules: breaking one is FIX FIRST; the common-mistakes checklist every handoff includes) and the lessons in `docs/LESSONS.md` tagged for your area.

- **Where is this symbol:** `node desktop/scripts/where.mjs <name>` (definitions with file:line, kind and signature, and up to 40 references; `--exports <file>` for one file's exports; `--json`). Read only, about half a second. Use it before grepping for a symbol.

## 2.x desktop app (`desktop/`)

- **Test budget (user decision 2026-11-16): run tests as little as possible; one full confirmation at the end.**
  - Final confirmation, once: after the branch is merged into main, one
    `desktop/scripts/remote-test.sh <sha> --typecheck <all related test files>`. Only if it passes, build.
  - Every other step makes at most 1–2 `remote-test.sh` runs, never with `--typecheck`, only the related test files:
    implementing worker at most 2; review 1 (related tests plus the batch mutation check in the same connection,
    see L-010); fix round 1; re-review none of its own (it reads the fix round's result). `npm run build` on the Mac
    does not count.
  - Over the limit: stop and say so in your report; do not rerun. A run lost to an ssh drop or that returned no
    result does not count.
- **No `test:changed`, `tsc` or `npm run typecheck` on the Mac** (the biggest CPU load, and it typechecks). The
  typecheck happens only in the final confirmation above; locally run only `npm run build` (fast). Use
  `remote-test.sh <sha> --typecheck-only` only when the coordinator asks for it.
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
- `npm run build` only bundles `out/` (under a second); `npm run typecheck` is `tsc --noEmit` (only in the final confirmation, on the host, see above).

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
