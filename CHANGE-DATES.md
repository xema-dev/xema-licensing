# Change Dates

Repositories licensed under the Xema Business Source License 1.1 convert to the
**Mozilla Public License, Version 2.0** four years after each version is first
publicly released. The Change Date is therefore **per version**, not per
repository, and it is **derived** — never assigned by hand.

```
change_date(version) = first_public_release(version) + 4 years
```

## Why there is no change-date registry

An earlier revision of this document said maintainers "should update release
notes or a per-repo change-date registry at release time". No such registry
existed, and one was deliberately not created. A hand-maintained registry is the
wrong artifact here:

- **It duplicates an immutable record.** Every public release already carries an
  authoritative publication timestamp in the channel it was released through.
  Copying those dates into a file in this repository creates a second source of
  truth that can disagree with the first.
- **It rots silently, and the evidence says it already would have.**
  No release step writes it, so it records only what someone remembered to
  record. `xema-biome-sdk` carries **6** git tags but has published **28+**
  versions of `@xemahq/biome-sdk` to the public npm registry. A tag- or
  registry-driven record would have captured 6 of 28 public releases and reported
  full coverage for the other 22 — the exact failure mode this repository exists
  to prevent.

A version's Change Date becomes unprovable only if one of two things breaks.
Both are checked mechanically by `tools/check-drift.mjs`:

1. **The rule stops shipping with the work.** The BSL LICENSE template states the
   per-version derivation in its `Change Date` parameter, so every copy of the
   Licensed Work tells its recipient how to compute its own Change Date. The
   check fails if that clause is removed from the template, or if the Change
   License named in the template, in `repos.manifest.json`, and in this document
   ever disagree.
2. **A repository releases through an undeclared channel.** Every `bsl` repo in
   `repos.manifest.json` must declare `release_channels` — where its public
   releases happen and therefore where the authoritative first-public-release
   timestamp is read from. A `bsl` repo with no declared channel fails the check,
   so a repository cannot start publishing without the lookup path being written
   down first.

## Determining `first_public_release(version)`

Read it from the declared channel. Do not estimate it, and do not substitute a
git tag date — a tag is an internal marker, is mutable, and (see above) most
released versions were never tagged.

| `release_channels[].kind` | Authoritative timestamp | How to read it |
| --- | --- | --- |
| `npm` | The npm registry's publish time for that exact version | `npm view <pkg> time --json` → the entry keyed by the version |
| `oci` | The image config's creation timestamp in the public registry it was pushed to | `crane config <ref>` → `.created` |
| `git_tag` | The GitHub Release publication timestamp (not the tag's commit date) | `gh release view <tag> --json publishedAt` |
| `none` | No version has been publicly released; **no Change Date has started** | n/a — the `reason` field states why |

A repository that is private and publishes nothing publicly has released nothing
under the BSL, so no clock is running for any of its versions. That is what
`kind: none` records, and it must carry a `reason`.

## When a repository starts publishing

Change `release_channels` in `repos.manifest.json` (and the `repos.manifest.yaml`
mirror) from `none` to the real channel in the same change that enables
publishing. `tools/check-drift.mjs` fails while a `bsl` repo has no channel
declared, so this cannot be skipped silently.
