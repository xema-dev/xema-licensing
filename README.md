# xema-licensing

Source of truth for the license files (`LICENSE`, `NOTICE`, file headers) of every
Xema repository, with tooling that renders them and fails CI on drift.

## When to use it

Use it to onboard a repository to a license, change a license template, or check
that every repository carries the right legal files and package licenses.

## Contents

| Path | Purpose |
|---|---|
| `repos.manifest.json` | Machine-read list of governed repositories, each with a `license` (`bsl`, `apache`, `mit`, `proprietary` or `unresolved`) |
| `templates/` | License, notice and header templates |
| `package-license-exceptions.json` | Documented exceptions to the package-license rule |
| `CHANGE-DATES.md` | How BSL Change Dates are derived |

`unresolved` is a pending decision, not a license: it blocks rendering.

## Usage

```bash
# Render legal files; --only limits the write to named repositories
node tools/sync-licenses.mjs --workspace-root <workspace> --only <repo>,<repo>
```

`<workspace>` is the directory containing the governed repositories. `pnpm sync` wraps the script.

## Links

- [xema.dev](https://xema.dev)
- [Contributing](CONTRIBUTING.md) &middot; [Trademarks](TRADEMARKS.md)

## License

Apache-2.0. See [LICENSE](LICENSE).
