#!/usr/bin/env node
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";

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
  const defaults = manifest.defaults || {};
  const repos = manifest.repos || [];

  for (const repo of repos) {
    const repoName = repo.name;
    const repoPath = repo.path;
    const license = repo.license;

    if (!repoName || !repoPath || !license) {
      throw new Error(`Invalid manifest entry: ${JSON.stringify(repo)}`);
    }

    if (license === "ASK") {
      console.log(`SKIP ${repoName}: license=ASK`);
      continue;
    }

    const repoAbs = join(workspaceRoot, repoPath);
    if (!(await pathExists(repoAbs))) {
      throw new Error(`Target repo path does not exist: ${repoPath}`);
    }

    const vars = {
      organization: manifest.organization,
      year: manifest.copyright_year,
      contact: manifest.contact,
      repoName,
      bslAdditionalUseGrantSections: defaults?.bsl?.additional_use_grant_sections || "",
    };

    console.log(`APPLY ${repoName} (${license})`);
    if (license === "bsl") {
      const licenseTmpl = await loadTemplate(baseDir, "bsl-1.1", "LICENSE.tmpl");
      const noticeTmpl = await loadTemplate(baseDir, "bsl-1.1", "NOTICE.tmpl");
      console.log(`  wrote ${await writeRendered(workspaceRoot, repoPath, "LICENSE", render(licenseTmpl, vars))}`);
      console.log(`  wrote ${await writeRendered(workspaceRoot, repoPath, "NOTICE", render(noticeTmpl, vars))}`);
      continue;
    }

    if (license === "apache") {
      const apacheLicense = await loadTemplate(baseDir, "apache-2.0", "LICENSE");
      const noticeTmpl = await loadTemplate(baseDir, "apache-2.0", "NOTICE.tmpl");
      console.log(`  wrote ${await writeRendered(workspaceRoot, repoPath, "LICENSE", apacheLicense)}`);
      console.log(`  wrote ${await writeRendered(workspaceRoot, repoPath, "NOTICE", render(noticeTmpl, vars))}`);
      continue;
    }

    if (license === "mit") {
      const mitLicenseTmpl = await loadTemplate(baseDir, "mit", "LICENSE.tmpl");
      console.log(`  wrote ${await writeRendered(workspaceRoot, repoPath, "LICENSE", render(mitLicenseTmpl, vars))}`);
      continue;
    }

    if (license === "proprietary") {
      const licTmpl = await loadTemplate(baseDir, "proprietary", "LICENSE.tmpl");
      const noticeTmpl = await loadTemplate(baseDir, "proprietary", "NOTICE.tmpl");
      console.log(`  wrote ${await writeRendered(workspaceRoot, repoPath, "LICENSE", render(licTmpl, vars))}`);
      console.log(`  wrote ${await writeRendered(workspaceRoot, repoPath, "NOTICE", render(noticeTmpl, vars))}`);
      continue;
    }

    throw new Error(`Unknown license kind '${license}' for repo '${repoName}'`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
