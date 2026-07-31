#!/usr/bin/env node
import { writeFile, mkdir, stat } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";

import { LicenseKind, describeUnresolved, expectedFiles, loadManifest, varsForRepo } from "./lib/manifest.mjs";

function parseArgs(argv) {
  const args = { workspaceRoot: "../..", only: null };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--workspace-root") {
      args.workspaceRoot = argv[i + 1];
      i += 1;
    } else if (token === "--only") {
      args.only = new Set(
        (argv[i + 1] ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
      );
      i += 1;
    } else {
      throw new Error(`Unknown argument '${token}'. Usage: sync-licenses.mjs [--workspace-root <dir>] [--only <names>]`);
    }
  }
  if (args.only && args.only.size === 0) {
    throw new Error("--only requires at least one repo name");
  }
  return args;
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeRendered(rootDir, repoPath, filename, content) {
  const target = join(rootDir, repoPath, filename);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  return target;
}

async function main() {
  const args = parseArgs(process.argv);
  const baseDir = resolve(process.cwd());
  const workspaceRoot = resolve(baseDir, args.workspaceRoot);

  const manifest = await loadManifest(baseDir);
  const unresolved = [];
  const unknownNames = new Set(args.only ?? []);

  for (const repo of manifest.repos) {
    if (!repo.name || !repo.path || !repo.license) {
      throw new Error(`Invalid manifest entry: ${JSON.stringify(repo)}`);
    }
    unknownNames.delete(repo.name);

    if (args.only && !args.only.has(repo.name)) {
      continue;
    }

    if (repo.license === LicenseKind.Unresolved) {
      // No decision means there is nothing to write. Collected and reported as
      // a failure at the end so the rest of the fleet still syncs.
      unresolved.push(describeUnresolved(repo));
      continue;
    }

    const repoAbs = join(workspaceRoot, repo.path);
    if (!(await pathExists(repoAbs))) {
      throw new Error(`Target repo path does not exist: ${repo.path}`);
    }

    console.log(`APPLY ${repo.name} (${repo.license})`);
    const files = await expectedFiles(baseDir, repo, varsForRepo(manifest, repo));
    for (const [filename, content] of Object.entries(files)) {
      console.log(`  wrote ${await writeRendered(workspaceRoot, repo.path, filename, content)}`);
    }
  }

  if (unknownNames.size > 0) {
    throw new Error(`--only names no such repo: ${[...unknownNames].join(", ")}`);
  }

  if (unresolved.length > 0) {
    console.error("\nRepos with no license decision — nothing was written for these:");
    for (const item of unresolved) {
      console.error(`- ${item}`);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
