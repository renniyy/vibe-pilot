# Changelog

All notable changes to vibe-pilot are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/).

## [0.1.4] — 2026-11-14

First public release. Version numbers 0.1.1–0.1.3 were previously published and
retired on the npm registry, so the first release ships as 0.1.4.

### Added

- **CLI** (`vibe-pilot`): `scan`, `context`, `focus`, `init`, `mcp` commands with
  `--json`, `--profile`, `--focus`, `--hot-days`, `--no-write`, `--out` options.
- **Scanner**: gitignore-aware traversal (nested `.gitignore` support with
  negation, dir-only and anchored patterns), built-in boilerplate rules
  (`node_modules/`, `dist/`, `__pycache__/`, …), generated-artifact detection
  (lockfiles, `*.min.*`, source maps), 7-class file classification
  (source/test/config/docs/assets/generated/data), 512KB oversize guard.
- **Import graph** for JS/TS and Python: relative + tsconfig `paths` alias
  resolution, monorepo workspace packages with `@scope/pkg` subpath imports,
  entry detection from `package.json` `main`/`module`/`exports`/`bin` with a
  `dist/`→`src/` fallback, Python relative imports (`from .pkg.mod import X`)
  and from-import submodules, reachability analysis producing dead-code
  candidates.
- **Hotspots**: per-file commit counts over a configurable window
  (`git log --name-only`, correct for root commits); focus scoring that boosts
  1-hop import-graph neighbors at half weight.
- **`.context/` package**: `PROJECT.md` (AI briefing), `tree.txt` (pruned tree,
  `▲` hot / `✦` focus / `~` cold), `files.json` (tiered index, compact JSON),
  `manifest.json` (stats + reproducibility), all fitted to a per-profile token
  budget.
- **MCP server** (stdio): `vibe_pilot_scan`, `get_context`, `focus`,
  `list_files` tools; ~24k-character result truncation; stderr-only diagnostics.
- **Profiles**: `conservative` / `balanced` / `aggressive`.
- **Tests**: 12 tests in 7 suites, including an end-to-end MCP stdio JSON-RPC
  handshake test.
- **Benchmark**: 21 real repositories — 300.6M raw tokens → 877.1k brief tokens
  (−99.7%); raw data in `docs/benchmark.json`.
