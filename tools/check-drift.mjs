#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";

function parseArgs(argv) {
  const args = { workspaceRoot: "../.." };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--workspace-root") {
      args.workspaceRoot = argv[i + 1];
      i += 1;
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

async function main() {
  const args = parseArgs(process.argv);
  const baseDir = resolve(process.cwd());
  const workspaceRoot = resolve(baseDir, args.workspaceRoot);

  const manifest = await loadManifest(baseDir);
  const defaults = manifest.defaults || {};
  const repos = manifest.repos || [];
  const mismatches = [];

  for (const repo of repos) {
    if (repo.license === "ASK") {
      console.log(`SKIP ${repo.name}: license=ASK`);
      continue;
    }

    const vars = {
      organization: manifest.organization,
      year: manifest.copyright_year,
      contact: manifest.contact,
      repoName: repo.name,
      bslAdditionalUseGrantSections: defaults?.bsl?.additional_use_grant_sections || "",
    };

    const expected = await expectedFiles(baseDir, repo, defaults, vars);
    if (!expected) {
      continue;
    }

    for (const [filename, expectedContent] of Object.entries(expected)) {
      const target = join(workspaceRoot, repo.path, filename);
      const actual = await readExisting(target);
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

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
