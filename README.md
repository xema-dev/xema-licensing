# xema-licensing

Central source of truth for xema licensing artifacts across repositories.

This repository stores:
- Canonical license templates
- Repository license manifest
- Rendering and drift-check tooling
- CI verification workflow

## Principles

- Each target repository must contain real root `LICENSE` / `NOTICE` files.
- No symlinks and no git-submodule indirection for legal artifacts.
- Drift is blocked in CI via deterministic render-and-compare checks.
- **Fail-closed.** Nothing here warns. A check that cannot prove its property
  fails, so a disconnected or partial check never reads as coverage.

## The manifest

`repos.manifest.json` is what the tools read; `repos.manifest.yaml` is the
human-facing mirror. `tools/check-drift.mjs` pins the two together — the ordered
`(name, path, license)` triples and `scan_roots` must be identical — so the file
a reader trusts cannot drift from the file that is enforced.

`license` is a closed set: `bsl` | `apache` | `mit` | `proprietary` |
`unresolved`. `unresolved` is a **declared pending decision, not a license**: it
renders no files and **fails** the check, carrying the question, the evidence,
and the options with it. It is never skipped — a repository with no license
decision is a live defect, not an exemption.

`scan_roots` is what makes the manifest a statement about the whole tree: every
directory under every scan root must have an entry, and every entry must live
under a scan root. An unlisted repo fails; a listed repo missing from disk
fails; a scan root that is absent or that contains zero repositories fails.

## Package licenses

A repo's `LICENSE` governs a recipient of the REPOSITORY. It says nothing about
a recipient of a PACKAGE: a published npm tarball carries no repository, and
`license` in `package.json` is the entire record of terms a consumer gets. A
version published from a manifest with no `license` field states nothing — and
for BSL that also leaves no anchor for the per-version Change Date.

So every package a governed repo can publish must declare its repo's SPDX class
(`defaults.<kind>.spdx` in the manifest — one source for the templates and the
packages alike). "Can publish" is not a guess: every release workflow in the
fleet publishes exactly the packages whose `package.json` does not say
`private: true`, which is also the only thing npm itself refuses to publish.

`package-license-exceptions.json` is the only way a package may differ, and
`status` is a closed set:

- `documented` — a deliberate, permanent difference, with the SPDX it declares
  and a substantive reason.
- `unresolved` — a KNOWN difference with no decision behind it. It **fails**,
  exactly like `license: unresolved` on a repo, and carries the question, the
  evidence and the options with it.

Entries are checked for staleness: one whose package is gone, has become
private, or now matches its repo class fails. Silence is never an exception.

## Change dates

BSL Change Dates are **derived per version, never recorded** — see
`CHANGE-DATES.md` for why a hand-maintained registry is the wrong artifact and
what is enforced in its place.

## Quick Start

```bash
cd repos/xema-licensing

# Manifest, mirror, templates and the change-date rule. Needs no other checkout.
node tools/check-drift.mjs --manifest-only

# Everything above, plus fleet coverage, per-repo LICENSE/NOTICE drift and the
# package-level license rule. Requires every governed repo checked out under the
# workspace root.
node tools/check-drift.mjs --workspace-root ../..

# Just the package-level rule. Resolves its own base dir, so it runs from
# anywhere -- which is how the aggregator's boundary gate invokes it.
node tools/check-package-licenses.mjs --workspace-root ../..

# Render the legal artifacts. --only scopes the write to named repos, so
# onboarding one repository does not rewrite the fleet's LICENSE files.
node tools/sync-licenses.mjs --workspace-root ../.. --only xema-base,xema-cli
```

CI runs `--manifest-only`: the full check needs the governed repos as siblings,
which a standalone CI checkout does not have and no available credential can
produce (several of those repos are private). Run the full check from a local
monorepo workspace.

## Contribution Policy

External contributions to repositories governed by this system are subject to a CLA policy. See `CONTRIBUTING.md`.

## Trademark

Brand usage policy is documented in `TRADEMARKS.md`.
