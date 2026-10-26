# Agent notes

## 2.x desktop app (`desktop/`)

- **Default check while working:** `cd desktop && npm run test:changed`. It typechecks, rebuilds
  `out/` and runs only the unit tests related to your changes (uncommitted work against `HEAD`,
  untracked files included). For committed work on a branch, give the base:
  `npm run test:changed -- <base-branch>`. A typical run takes seconds.
- Run only the relevant checks for your change and reuse evidence you already have. Do not run the
  full suite (`npm test`, `npm run test:unit`), e2e, live or packaged tests, or a package build
  during development. The full suite runs once, before a release.
- **Dev build:** `npm run dist:dir` (the unpacked app, about 15 s). Put its output and caches on a
  volume with free space: `BOTLING_DIST_DIR`, `electron_config_cache`, `ELECTRON_BUILDER_CACHE`
  (see `desktop/README.md`).
- `npm run build` only bundles `out/` (under a second); `npm run typecheck` is `tsc --noEmit`.
