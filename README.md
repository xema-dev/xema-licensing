# xema-licensing

Central source of truth for Neuralchowder licensing artifacts across repositories.

This repository stores:
- Canonical license templates
- Repository license manifest
- Rendering and drift-check tooling
- CI verification workflow

## Principles

- Each target repository must contain real root `LICENSE` / `NOTICE` files.
- No symlinks and no git-submodule indirection for legal artifacts.
- Drift is blocked in CI via deterministic render-and-compare checks.

## Quick Start

```bash
cd repos/xema-licensing
node tools/sync-licenses.mjs --workspace-root ../..
node tools/check-drift.mjs --workspace-root ../..
```

## Contribution Policy

External contributions to repositories governed by this system are subject to a CLA policy. See `CONTRIBUTING.md`.

## Trademark

Brand usage policy is documented in `TRADEMARKS.md`.
