#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";

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
    }
  }
  return args;
}

function render(template, vars) {
  return template
    .replaceAll("{{ORG}}", vars.organization)
    .replaceAll("{{YEAR}}", String(vars.year))
    .replaceAll("{{CONTACT}}", vars.contact)
    .replaceAll("{{REPO_NAME}}", vars.repoName)
    .replaceAll("{{BSL_ADDITIONAL_USE_GRANT_SECTIONS}}", vars.bslAdditionalUseGrantSections || "");
}

async function loadManifest(baseDir) {
  const raw = await readFile(join(baseDir, "repos.manifest.json"), "utf8");
  return JSON.parse(raw);
}

async function loadTemplate(baseDir, licenseKind, filename) {
  const fullPath = join(baseDir, "templates", licenseKind, filename);
  return readFile(fullPath, "utf8");
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

function varsForRepo(manifest, defaults, repo) {
  return {
    organization: manifest.organization,
    year: manifest.copyright_year,
    contact: manifest.contact,
    repoName: repo.name,
    bslAdditionalUseGrantSections: defaults?.bsl?.additional_use_grant_sections || "",
  };
}

async function expectedFiles(baseDir, repo, defaults, vars) {
  if (repo.license === "bsl") {
    return {
      LICENSE: render(await loadTemplate(baseDir, "bsl-1.1", "LICENSE.tmpl"), vars),
      NOTICE: render(await loadTemplate(baseDir, "bsl-1.1", "NOTICE.tmpl"), vars),
    };
  }

  if (repo.license === "apache") {
    return {
      LICENSE: await loadTemplate(baseDir, "apache-2.0", "LICENSE"),
      NOTICE: render(await loadTemplate(baseDir, "apache-2.0", "NOTICE.tmpl"), vars),
    };
  }

  if (repo.license === "mit") {
    return {
      LICENSE: render(await loadTemplate(baseDir, "mit", "LICENSE.tmpl"), vars),
    };
  }

  if (repo.license === "proprietary") {
    return {
      LICENSE: render(await loadTemplate(baseDir, "proprietary", "LICENSE.tmpl"), vars),
      NOTICE: render(await loadTemplate(baseDir, "proprietary", "NOTICE.tmpl"), vars),
    };
  }

  if (repo.license === "ASK") {
    return null;
  }

  throw new Error(`Unknown license kind '${repo.license}' for repo '${repo.name}'`);
}

// Self-contained: proves every declared license kind resolves to templates that
// exist and render completely. Needs no sibling checkouts, so CI can run it.
async function checkManifest(baseDir, manifest, defaults, repos) {
  const problems = [];

  for (const repo of repos) {
    if (repo.license === "ASK") {
      console.log(`SKIP ${repo.name}: license=ASK`);
      continue;
    }
    if (!repo.path) {
      problems.push(`${repo.name}: manifest entry has no 'path'`);
      continue;
    }

    let expected;
    try {
      expected = await expectedFiles(baseDir, repo, defaults, varsForRepo(manifest, defaults, repo));
    } catch (error) {
      problems.push(`${repo.name}: ${error.message}`);
      continue;
    }
    if (!expected) {
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

  if (problems.length > 0) {
    console.error("Manifest/template problems detected:");
    for (const item of problems) {
      console.error(`- ${item}`);
    }
    process.exit(1);
  }

  console.log(`Manifest and templates valid for ${repos.length} repos.`);
}

// Cross-repo: requires every declared repo to be checked out under workspaceRoot.
async function checkDrift(baseDir, workspaceRoot, manifest, defaults, repos) {
  const mismatches = [];

  for (const repo of repos) {
    if (repo.license === "ASK") {
      console.log(`SKIP ${repo.name}: license=ASK`);
      continue;
    }

    const repoDir = join(workspaceRoot, repo.path);
    // Fail fast, and distinguish "wrong workspace root" from real drift: an
    // absent checkout previously reported as `missing LICENSE`, which reads
    // identically to a repo that genuinely lost its LICENSE.
    if (!(await directoryExists(repoDir))) {
      throw new Error(
        `Repo '${repo.name}' is not checked out at ${repoDir}. ` +
          `check-drift needs every repo in repos.manifest.json present under the workspace root ` +
          `(--workspace-root, currently ${workspaceRoot}). ` +
          `To validate only this repo's manifest and templates, use --manifest-only.`,
      );
    }

    const expected = await expectedFiles(baseDir, repo, defaults, varsForRepo(manifest, defaults, repo));
    if (!expected) {
      continue;
    }

    for (const [filename, expectedContent] of Object.entries(expected)) {
      const actual = await readExisting(join(repoDir, filename));
      if (actual === null) {
        mismatches.push(`${repo.name}: missing ${filename}`);
        continue;
      }
      if (actual !== expectedContent) {
        mismatches.push(`${repo.name}: drift in ${filename}`);
      }
    }
  }

  if (mismatches.length > 0) {
    console.error("License drift detected:");
    for (const item of mismatches) {
      console.error(`- ${item}`);
    }
    process.exit(1);
  }

  console.log("No license drift detected.");
}

async function main() {
  const args = parseArgs(process.argv);
  const baseDir = resolve(process.cwd());

  const manifest = await loadManifest(baseDir);
  const defaults = manifest.defaults || {};
  const repos = manifest.repos || [];

  if (args.manifestOnly) {
    await checkManifest(baseDir, manifest, defaults, repos);
    return;
  }

  await checkDrift(baseDir, resolve(baseDir, args.workspaceRoot), manifest, defaults, repos);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
