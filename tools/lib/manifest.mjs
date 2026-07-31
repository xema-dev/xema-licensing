// Manifest + template loading and rendering. Shared by check-drift.mjs and
// sync-licenses.mjs so the two tools can never disagree about what a given
// license kind renders to.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Closed set. A repo carries exactly one of these; `unresolved` is a declared
// pending decision, not a license, and never renders files.
export const LicenseKind = Object.freeze({
  Bsl: "bsl",
  Apache: "apache",
  Mit: "mit",
  Proprietary: "proprietary",
  Unresolved: "unresolved",
});

export const LICENSE_KINDS = Object.freeze(Object.values(LicenseKind));

// The `templates/<dir>` each license kind renders from. Single source: both
// expectedFiles() and the header-template assertions read this map, so a kind
// can never be looked up under two different directory names.
export const TEMPLATE_DIR = Object.freeze({
  [LicenseKind.Bsl]: "bsl-1.1",
  [LicenseKind.Apache]: "apache-2.0",
  [LicenseKind.Mit]: "mit",
  [LicenseKind.Proprietary]: "proprietary",
});

// The comment-syntax variants of the per-file license header. Not rendered into
// any repo by these tools today, but they carry {{ORG}} and are stamped into
// source files by hand, so they are held to the same rendering assertions.
export const HEADER_TEMPLATES = Object.freeze(["headers/hash.txt", "headers/doubleslash.txt"]);

// Closed set. Where a repository's public releases happen, and therefore where
// the authoritative first-public-release timestamp is read from. See
// CHANGE-DATES.md.
export const ReleaseChannelKind = Object.freeze({
  Npm: "npm",
  Oci: "oci",
  GitTag: "git_tag",
  None: "none",
});

export const RELEASE_CHANNEL_KINDS = Object.freeze(Object.values(ReleaseChannelKind));

export const MANIFEST_JSON = "repos.manifest.json";
export const MANIFEST_YAML = "repos.manifest.yaml";
export const CHANGE_DATES_DOC = "CHANGE-DATES.md";

export async function loadManifest(baseDir) {
  const manifest = JSON.parse(await readFile(join(baseDir, MANIFEST_JSON), "utf8"));
  if (!Array.isArray(manifest.repos) || manifest.repos.length === 0) {
    throw new Error(`${MANIFEST_JSON} declares no repos — refusing to report coverage over an empty fleet.`);
  }
  if (!Array.isArray(manifest.scan_roots) || manifest.scan_roots.length === 0) {
    throw new Error(`${MANIFEST_JSON} declares no scan_roots — coverage of the tree cannot be verified.`);
  }
  return manifest;
}

export async function loadTemplate(baseDir, licenseKind, filename) {
  return readFile(join(baseDir, "templates", licenseKind, filename), "utf8");
}

export function render(template, vars) {
  return template
    .replaceAll("{{ORG}}", vars.organization)
    .replaceAll("{{YEAR}}", String(vars.year))
    .replaceAll("{{CONTACT}}", vars.contact)
    .replaceAll("{{REPO_NAME}}", vars.repoName)
    .replaceAll("{{BSL_ADDITIONAL_USE_GRANT_SECTIONS}}", vars.bslAdditionalUseGrantSections || "");
}

export function varsForRepo(manifest, repo) {
  return {
    organization: manifest.organization,
    year: manifest.copyright_year,
    contact: manifest.contact,
    repoName: repo.name,
    bslAdditionalUseGrantSections: manifest.defaults?.bsl?.additional_use_grant_sections || "",
  };
}

// The LICENSE/NOTICE a repo must contain, keyed by filename. Returns null only
// for `unresolved`, which callers must treat as a failure — never as a skip.
export async function expectedFiles(baseDir, repo, vars) {
  if (repo.license === LicenseKind.Bsl) {
    const dir = TEMPLATE_DIR[LicenseKind.Bsl];
    return {
      LICENSE: render(await loadTemplate(baseDir, dir, "LICENSE.tmpl"), vars),
      NOTICE: render(await loadTemplate(baseDir, dir, "NOTICE.tmpl"), vars),
    };
  }

  if (repo.license === LicenseKind.Apache) {
    const dir = TEMPLATE_DIR[LicenseKind.Apache];
    return {
      LICENSE: await loadTemplate(baseDir, dir, "LICENSE"),
      NOTICE: render(await loadTemplate(baseDir, dir, "NOTICE.tmpl"), vars),
    };
  }

  if (repo.license === LicenseKind.Mit) {
    return {
      LICENSE: render(await loadTemplate(baseDir, TEMPLATE_DIR[LicenseKind.Mit], "LICENSE.tmpl"), vars),
    };
  }

  if (repo.license === LicenseKind.Proprietary) {
    const dir = TEMPLATE_DIR[LicenseKind.Proprietary];
    return {
      LICENSE: render(await loadTemplate(baseDir, dir, "LICENSE.tmpl"), vars),
      NOTICE: render(await loadTemplate(baseDir, dir, "NOTICE.tmpl"), vars),
    };
  }

  if (repo.license === LicenseKind.Unresolved) {
    return null;
  }

  throw new Error(
    `Unknown license kind '${repo.license}' for repo '${repo.name}' (expected one of ${LICENSE_KINDS.join(", ")})`,
  );
}

// An unresolved repo has no license decision, so it has no LICENSE to check and
// no rights are reserved or granted on disk. Rendered as a failure, never a skip.
export function describeUnresolved(repo) {
  const u = repo.unresolved;
  if (!u || typeof u.question !== "string" || u.question.trim().length === 0) {
    return (
      `${repo.name}: license=unresolved but the entry carries no 'unresolved.question'. ` +
      `An unresolved license must state the decision it is waiting on.`
    );
  }
  const options = Array.isArray(u.options) ? u.options : [];
  const lines = [
    `${repo.name}: license is UNRESOLVED — no license decision exists for ${repo.path}.`,
    `    raised:   ${u.raised ?? "(not recorded)"}`,
    `    question: ${u.question}`,
  ];
  if (u.evidence) {
    lines.push(`    evidence: ${u.evidence}`);
  }
  for (const option of options) {
    lines.push(`    option:   ${option}`);
  }
  if (u.blocking) {
    lines.push(`    blocking: ${u.blocking}`);
  }
  return lines.join("\n");
}
