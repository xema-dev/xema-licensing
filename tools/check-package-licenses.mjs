#!/usr/bin/env node
// Standalone entry point for the package-level license assertions, so the
// aggregator's boundary gate can run THIS check without also running the
// repo-level LICENSE/NOTICE drift comparison. They fail for unrelated reasons
// and a gate that conflates them teaches people to ignore it.
//
// Unlike check-drift.mjs, this resolves its own base directory from the module
// URL rather than from process.cwd(), because the boundary gate spawns every
// check with the aggregator root as cwd.
//
// ── ITS ONLY LIVE INVOCATION IS THE AGGREGATOR'S, AND THAT IS STRUCTURAL ────
// The aggregator runs it as the `package-licenses` entry of
// tooling/ci/run-boundary-checks.mjs. This repository deliberately does NOT
// invoke it from its own `ci.yaml`, and there used to be a `check:packages`
// script implying otherwise — deleted 2026-08-14.
//
// The reason is the same one ci.yaml already gives for the full drift check:
// this walks the SIBLING repositories named in repos.manifest.json, and a
// standalone CI checkout of this repo has none of them. It does not degrade
// quietly in that situation — it exits 1 with "refusing to report coverage over
// an empty scan" — so wiring it here would produce a workflow that can only ever
// be red, and a script entry nothing can run is a gate that reads as
// enforcement while being neither runnable nor run.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadManifest } from "./lib/manifest.mjs";
import { checkPackageLicenses, loadPackageLicenseExceptions } from "./lib/package-licenses.mjs";

const BASE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { workspaceRoot: resolve(BASE_DIR, "../..") };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--workspace-root") {
      args.workspaceRoot = resolve(process.cwd(), argv[i + 1] ?? "");
      i += 1;
    } else {
      throw new Error(`Unknown argument '${token}'. Usage: check-package-licenses.mjs [--workspace-root <dir>]`);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const manifest = await loadManifest(BASE_DIR);
  const exceptions = await loadPackageLicenseExceptions(BASE_DIR);
  const problems = await checkPackageLicenses(args.workspaceRoot, manifest, exceptions);

  if (problems.length > 0) {
    console.error("Package license problems detected:");
    for (const problem of problems) {
      console.error(`- ${problem}`);
    }
    process.exit(1);
  }

  console.log(
    `Every publishable package in ${manifest.repos.length} repos declares its repo's license ` +
      `(${exceptions.length} documented exception(s)).`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
