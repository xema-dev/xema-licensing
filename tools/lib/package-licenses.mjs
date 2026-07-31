// Package-level license assertions.
//
// The repo-level checks in checks.mjs govern the LICENSE/NOTICE a recipient of
// a REPOSITORY gets. They say nothing about what a recipient of a PACKAGE gets:
// npm reads `license` out of package.json, and a published tarball carries no
// repository. A version published from a package.json with no `license` field
// therefore leaves no record of its terms at all, and — for BSL — no anchor from
// which its Change Date can be derived (see CHANGE-DATES.md: the date is derived
// per version from the first public release, which presumes the version states
// it is BSL in the first place).
//
// Nothing here warns, for the same reason as the rest of this tooling.
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { LicenseKind, MANIFEST_JSON } from "./manifest.mjs";

export const PACKAGE_LICENSE_EXCEPTIONS_JSON = "package-license-exceptions.json";

// Closed set. `documented` is a permanent, reasoned difference; `unresolved` is
// a known difference with no decision behind it, and fails — exactly like a repo
// carrying `license: unresolved`.
export const ExceptionStatus = Object.freeze({
  Documented: "documented",
  Unresolved: "unresolved",
});

export const EXCEPTION_STATUSES = Object.freeze(Object.values(ExceptionStatus));

const MIN_REASON_LENGTH = 40;

// Directories that never contain an authored package manifest. `dist` and
// `build` are deliberate: a build output can contain a COPY of a package.json,
// and asserting on a copy reports a defect nobody can fix at that path.
const SKIP_DIRECTORIES = Object.freeze(
  new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", ".turbo", ".nx", "out"]),
);

export async function loadPackageLicenseExceptions(baseDir) {
  const raw = JSON.parse(await readFile(join(baseDir, PACKAGE_LICENSE_EXCEPTIONS_JSON), "utf8"));
  if (!Array.isArray(raw.exceptions)) {
    throw new Error(`${PACKAGE_LICENSE_EXCEPTIONS_JSON}: 'exceptions' must be an array.`);
  }
  return raw.exceptions;
}

// The SPDX identifier a repo of each license kind must stamp on its packages.
// Read from the manifest defaults so the package rule and the LICENSE templates
// can never disagree about what, say, `bsl` means.
export function spdxByLicenseKind(manifest) {
  const problems = [];
  const map = {};
  for (const kind of [LicenseKind.Bsl, LicenseKind.Apache, LicenseKind.Mit, LicenseKind.Proprietary]) {
    const spdx = manifest.defaults?.[kind]?.spdx;
    if (typeof spdx !== "string" || spdx.trim().length === 0) {
      problems.push(
        `${MANIFEST_JSON}: defaults.${kind}.spdx is missing, so nothing defines what a '${kind}' package must declare.`,
      );
      continue;
    }
    map[kind] = spdx;
  }
  return { map, problems };
}

/**
 * Shape of the exception registry. Needs no governed checkout, so it runs in
 * `--manifest-only` too — a malformed entry must not wait for a full workspace
 * to be reported.
 */
export function checkExceptionShape(exceptions) {
  const problems = [];
  const seen = new Set();

  for (const [index, entry] of exceptions.entries()) {
    const at = `${PACKAGE_LICENSE_EXCEPTIONS_JSON} entry ${index + 1}`;
    for (const field of ["package", "repo", "path", "status"]) {
      if (typeof entry[field] !== "string" || entry[field].trim().length === 0) {
        problems.push(`${at}: '${field}' is missing.`);
      }
    }
    if (!EXCEPTION_STATUSES.includes(entry.status)) {
      problems.push(`${at} (${entry.package}): unknown status '${entry.status}' (expected ${EXCEPTION_STATUSES.join(" | ")}).`);
      continue;
    }

    const key = `${entry.repo}:${entry.path}`;
    if (seen.has(key)) {
      problems.push(`${at} (${entry.package}): duplicate entry for ${key}. One package, one decision.`);
    }
    seen.add(key);

    if (entry.status === ExceptionStatus.Documented) {
      if (typeof entry.license !== "string" || entry.license.trim().length === 0) {
        problems.push(
          `${at} (${entry.package}): a documented exception must state the 'license' the package legitimately declares.`,
        );
      }
      if (typeof entry.reason !== "string" || entry.reason.trim().length < MIN_REASON_LENGTH) {
        problems.push(
          `${at} (${entry.package}): a documented exception needs a substantive 'reason' ` +
            `(at least ${MIN_REASON_LENGTH} characters) stating why this package differs from its repo.`,
        );
      }
      continue;
    }

    if (typeof entry.question !== "string" || entry.question.trim().length < MIN_REASON_LENGTH) {
      problems.push(
        `${at} (${entry.package}): an unresolved exception must state the decision it is waiting on ` +
          `in 'question' (at least ${MIN_REASON_LENGTH} characters).`,
      );
    }
    if (!Array.isArray(entry.options) || entry.options.length < 2) {
      problems.push(
        `${at} (${entry.package}): an unresolved exception must list at least two 'options'. ` +
          `A question with one answer is a decision nobody took.`,
      );
    }
  }

  return problems;
}

async function walkPackageManifests(repoDir) {
  const found = [];
  const stack = [""];

  while (stack.length > 0) {
    const relative = stack.pop();
    let entries;
    try {
      entries = await readdir(join(repoDir, relative), { withFileTypes: true });
    } catch {
      // The repo directory itself is missing; the caller reports that.
      return found;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) {
          continue;
        }
        stack.push(relative ? `${relative}/${entry.name}` : entry.name);
        continue;
      }
      if (entry.name === "package.json") {
        found.push(relative ? `${relative}/package.json` : "package.json");
      }
    }
  }

  return found;
}

async function directoryExists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every package a governed repo can publish must declare its repo's license.
 *
 * "Can publish" is not a guess. Every release workflow in the fleet publishes
 * exactly `pnpm -r --filter='./packages/**' … ` minus the packages whose
 * package.json says `private: true` — `private` is the ONLY exclusion any of
 * them applies, and npm itself refuses to publish a private package. So
 * `private !== true` is the publishable set, verified against the tree: of 344
 * package manifests, zero private ones carry `publishConfig` and 194 of the 200
 * non-private ones do. The rule is deliberately one notch wider than the
 * workflows' `packages/**` path filter, because a manifest outside that path is
 * still one `npm publish` away from shipping, and declaring a license costs
 * nothing.
 *
 * Requires the governed repos checked out under `workspaceRoot`.
 */
export async function checkPackageLicenses(workspaceRoot, manifest, exceptions) {
  const problems = [...checkExceptionShape(exceptions)];
  const { map: spdxByKind, problems: spdxProblems } = spdxByLicenseKind(manifest);
  problems.push(...spdxProblems);

  const exceptionByKey = new Map(exceptions.map((entry) => [`${entry.repo}:${entry.path}`, entry]));
  const matchedExceptionKeys = new Set();
  let scanned = 0;

  for (const repo of manifest.repos) {
    if (repo.license === LicenseKind.Unresolved) {
      // No license decision for the repo means no class to require of its
      // packages. The repo-level check already fails on it.
      continue;
    }
    const expected = spdxByKind[repo.license];
    if (!expected) {
      // spdxByLicenseKind already reported the missing default, or the kind is
      // invalid and expectedFiles() reports that.
      continue;
    }

    const repoDir = join(workspaceRoot, repo.path);
    if (!(await directoryExists(repoDir))) {
      problems.push(
        `${repo.name}: not checked out at ${repoDir}, so no package manifest in it was inspected.`,
      );
      continue;
    }

    for (const relative of await walkPackageManifests(repoDir)) {
      let pkg;
      try {
        pkg = JSON.parse(await readFile(join(repoDir, relative), "utf8"));
      } catch (error) {
        problems.push(`${repo.name}: ${relative} is not readable as JSON — ${error.message}`);
        continue;
      }
      scanned += 1;

      const key = `${repo.name}:${relative}`;
      const exception = exceptionByKey.get(key);
      const isPrivate = pkg.private === true;

      if (exception) {
        matchedExceptionKeys.add(key);
        if (isPrivate) {
          problems.push(
            `${repo.name}: STALE exception for ${relative} (${exception.package}) — the package is now ` +
              `private and cannot be published, so it needs no exception. Remove the entry.`,
          );
          continue;
        }
        if (exception.status === ExceptionStatus.Unresolved) {
          problems.push(
            `${repo.name}: ${exception.package} (${relative}) declares '${pkg.license}' but its repo is ` +
              `'${repo.license}' (${expected}), and the difference is UNRESOLVED — no license decision exists.\n` +
              `    raised:   ${exception.raised ?? "(not recorded)"}\n` +
              `    question: ${exception.question}\n` +
              (exception.evidence ? `    evidence: ${exception.evidence}\n` : "") +
              (exception.options ?? []).map((option) => `    option:   ${option}\n`).join("") +
              (exception.blocking ? `    blocking: ${exception.blocking}` : "").trimEnd(),
          );
          continue;
        }
        if (pkg.license !== exception.license) {
          problems.push(
            `${repo.name}: ${relative} declares '${pkg.license}' but its documented exception says ` +
              `'${exception.license}'. Update whichever is wrong — an exception that does not match the ` +
              `package documents nothing.`,
          );
          continue;
        }
        if (pkg.license === expected) {
          problems.push(
            `${repo.name}: STALE exception for ${relative} (${exception.package}) — it now declares its ` +
              `repo's class '${expected}', so the exception is no longer an exception. Remove the entry.`,
          );
        }
        continue;
      }

      if (isPrivate) {
        // npm refuses to publish it and every release workflow skips it, so no
        // version of it can ship without a license record.
        continue;
      }

      if (typeof pkg.license !== "string" || pkg.license.trim().length === 0) {
        problems.push(
          `${repo.name}: ${relative} (${pkg.name ?? "unnamed"}) is publishable (no \`private: true\`) but ` +
            `declares no 'license'. A version published from it carries no record of its terms` +
            (repo.license === LicenseKind.Bsl ? `, and no anchor for its BSL Change Date` : "") +
            `. Declare "license": "${expected}", or add an entry to ${PACKAGE_LICENSE_EXCEPTIONS_JSON}.`,
        );
        continue;
      }

      if (pkg.license !== expected) {
        problems.push(
          `${repo.name}: ${relative} (${pkg.name ?? "unnamed"}) declares '${pkg.license}' but its repo is ` +
            `'${repo.license}' (${expected}). A package may differ from its repo only through an explicit ` +
            `entry in ${PACKAGE_LICENSE_EXCEPTIONS_JSON} — silence is not an exception.`,
        );
      }
    }
  }

  for (const [key, entry] of exceptionByKey) {
    if (!matchedExceptionKeys.has(key)) {
      problems.push(
        `${PACKAGE_LICENSE_EXCEPTIONS_JSON}: STALE entry for ${entry.package} — nothing was inspected at ` +
          `${key.replace(":", "/")}. Either the path moved or the repo is not checked out; an exception ` +
          `nobody can match is an exemption for a package that may no longer exist.`,
      );
    }
  }

  if (scanned === 0) {
    // A walk that reads nothing would otherwise report a clean fleet.
    problems.push(
      `No package manifests were inspected under ${workspaceRoot} — refusing to report coverage over an empty scan.`,
    );
  }

  return problems;
}
