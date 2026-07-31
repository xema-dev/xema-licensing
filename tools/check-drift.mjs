#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";

import {
  checkChangeDateRule,
  checkFleetCoverage,
  checkManifestMirror,
  checkNoUndeclaredPublishChannel,
  checkRenderedPunctuation,
} from "./lib/checks.mjs";
import {
  LicenseKind,
  MANIFEST_JSON,
  describeUnresolved,
  expectedFiles,
  loadManifest,
  varsForRepo,
} from "./lib/manifest.mjs";
import { checkExceptionShape, checkPackageLicenses, loadPackageLicenseExceptions } from "./lib/package-licenses.mjs";

// A placeholder that survives render() means a template references a variable
// render() does not substitute -- the rendered LICENSE would ship with literal
// "{{ORG}}" in it.
const UNRENDERED_PLACEHOLDER = /\{\{[A-Z_]+\}\}/g;

function parseArgs(argv) {
  const args = { workspaceRoot: "../..", manifestOnly: false };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--workspace-root") {
      args.workspaceRoot = argv[i + 1];
      i += 1;
    } else if (token === "--manifest-only") {
      args.manifestOnly = true;
    } else {
      throw new Error(`Unknown argument '${token}'. Usage: check-drift.mjs [--workspace-root <dir>] [--manifest-only]`);
    }
  }
  return args;
}

async function readExisting(path) {
  try {
    await stat(path);
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function directoryExists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function report(heading, problems) {
  if (problems.length === 0) {
    return false;
  }
  console.error(`${heading}:`);
  for (const problem of problems) {
    console.error(`- ${problem}`);
  }
  return true;
}

// Assertions that need only this repository's own files, so CI can run them
// without checking out the governed fleet.
async function checkManifestAndTemplates(baseDir, manifest, exceptions) {
  const problems = [];

  problems.push(...(await checkManifestMirror(baseDir, manifest)));
  problems.push(...(await checkChangeDateRule(baseDir, manifest)));
  problems.push(...(await checkRenderedPunctuation(baseDir, manifest)));
  // Only the SHAPE of the package-license exceptions here; matching them against
  // real package manifests needs the fleet checked out (see checkDrift below).
  problems.push(...checkExceptionShape(exceptions));

  for (const repo of manifest.repos) {
    if (repo.license === LicenseKind.Unresolved) {
      problems.push(describeUnresolved(repo));
      continue;
    }
    if (!repo.path) {
      problems.push(`${repo.name}: manifest entry has no 'path'`);
      continue;
    }

    let expected;
    try {
      expected = await expectedFiles(baseDir, repo, varsForRepo(manifest, repo));
    } catch (error) {
      problems.push(`${repo.name}: ${error.message}`);
      continue;
    }

    for (const [filename, content] of Object.entries(expected)) {
      const leftover = [...new Set(content.match(UNRENDERED_PLACEHOLDER) || [])];
      if (leftover.length > 0) {
        problems.push(`${repo.name}: ${filename} has unrendered placeholders ${leftover.join(", ")}`);
      }
    }
    console.log(`OK ${repo.name}: license=${repo.license} -> ${Object.keys(expected).join(", ")}`);
  }

  return problems;
}

// Cross-repo: requires every governed repo to be checked out under workspaceRoot.
async function checkDrift(baseDir, workspaceRoot, manifest, exceptions) {
  const problems = await checkFleetCoverage(workspaceRoot, manifest);
  problems.push(...(await checkNoUndeclaredPublishChannel(workspaceRoot, manifest)));
  problems.push(...(await checkPackageLicenses(workspaceRoot, manifest, exceptions)));

  for (const repo of manifest.repos) {
    if (repo.license === LicenseKind.Unresolved) {
      // Already reported by checkManifestAndTemplates, which always runs in the
      // same invocation. There is no license kind here to render or compare.
      continue;
    }

    const repoDir = join(workspaceRoot, repo.path);
    // Fail fast, and distinguish "wrong workspace root" from real drift: an
    // absent checkout previously reported as `missing LICENSE`, which reads
    // identically to a repo that genuinely lost its LICENSE.
    if (!(await directoryExists(repoDir))) {
      problems.push(
        `${repo.name}: listed in ${MANIFEST_JSON} but not checked out at ${repoDir}. ` +
          `Either check it out under the workspace root (--workspace-root, currently ${workspaceRoot}) ` +
          `or remove the entry — a listed repo that nothing can read is unchecked, not governed.`,
      );
      continue;
    }

    const expected = await expectedFiles(baseDir, repo, varsForRepo(manifest, repo));
    for (const [filename, expectedContent] of Object.entries(expected)) {
      const actual = await readExisting(join(repoDir, filename));
      if (actual === null) {
        problems.push(`${repo.name}: missing ${filename}`);
        continue;
      }
      if (actual !== expectedContent) {
        problems.push(`${repo.name}: drift in ${filename}`);
      }
    }
  }

  return problems;
}

async function main() {
  const args = parseArgs(process.argv);
  const baseDir = resolve(process.cwd());
  const manifest = await loadManifest(baseDir);
  const exceptions = await loadPackageLicenseExceptions(baseDir);

  if (args.manifestOnly) {
    const problems = await checkManifestAndTemplates(baseDir, manifest, exceptions);
    if (report("Manifest/template problems detected", problems)) {
      process.exit(1);
    }
    console.log(`Manifest and templates valid for ${manifest.repos.length} repos.`);
    return;
  }

  const problems = [
    ...(await checkManifestAndTemplates(baseDir, manifest, exceptions)),
    ...(await checkDrift(baseDir, resolve(baseDir, args.workspaceRoot), manifest, exceptions)),
  ];
  if (report("License problems detected", problems)) {
    process.exit(1);
  }
  console.log(`No license drift detected across ${manifest.repos.length} repos.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
