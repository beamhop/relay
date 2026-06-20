# ADR-0004 — YAML config, auto-discovery, and zero-config startup

- **Status:** Accepted
- **Date:** 2026-06-20
- **Context source:** Grill session 2026-06-20

## Context

Config today is CLI flags plus an optional JSON file passed via `--config`
(`src/config.ts`). Two requirements were added:

- **YAML config support** (operators prefer YAML; the platform deployment already mounts a
  YAML settings file).
- **Zero-config, zero-dependency startup**: running the binary with nothing set must bring the
  relay up.

These must not break the existing JSON config documented in the README.

## Decision

- **YAML is the primary config format**, with auto-discovery: if `relay.yaml` (or
  `relay.config.yaml`) exists in the working directory it is loaded automatically, no
  `--config` needed.
- **JSON still works.** JSON is valid YAML, so a single YAML parser reads both; `--config
  path.json` continues to function.
- **Precedence (highest wins):** CLI flags → environment variables → config file → built-in
  defaults.
- **Zero-config:** with no file and no flags, the relay starts in `memory` mode on the default
  port. `just run it` is preserved (ADR-0001).
- **One committed active config**, no `.example` twin (per project convention). Secret values
  never live in the committed config.

## Consequences

- ✅ Operators get YAML; the just-run-it default is intact.
- ✅ Existing JSON configs and CLI flags keep working; no breaking change.
- ✅ The k8s deployment can mount a single `relay.yaml` ConfigMap.
- ⚠️ Adds a YAML parser to the standalone path. Acceptable: it is a tiny, dependency-light
  parser (or Bun's built-in YAML support if available) and does not pull in the production
  Postgres/Redis stack.
- ⚠️ Precedence must be explicit and tested so a mounted file plus env overrides behave
  predictably in-cluster.
