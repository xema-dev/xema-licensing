// The fleet-posture assertions. Each returns a list of problem strings; an
// empty list is the only passing result. Nothing here warns: a check that
// cannot prove its property fails, so a disconnected check never reads as
// coverage.
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  CHANGE_DATES_DOC,
  HEADER_TEMPLATES,
  LicenseKind,
  MANIFEST_JSON,
  MANIFEST_YAML,
  RELEASE_CHANNEL_KINDS,
  ReleaseChannelKind,
  TEMPLATE_DIR,
  expectedFiles,
  loadTemplate,
  render,
  varsForRepo,
} from "./manifest.mjs";

const MIN_REASON_LENGTH = 40;

// No legal text in `templates/` contains a doubled period of its own — not the
// Apache-2.0 body, not the BSL additional-use-grant sections. So any `..` in a
// rendered artifact came from concatenation, which is exactly the defect this
// pins.
const DOUBLED_PERIOD = /\.\./;

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

async function directoryExists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every directory under every scan root must be governed by a manifest entry,
 * and every manifest entry must live under a scan root. This is what makes the
 * manifest a statement about the whole tree rather than about the subset
 * somebody remembered to list.
 *
 * Requires the repos checked out under `workspaceRoot`, so it runs only in the
 * full cross-repo mode.
 */
export async function checkFleetCoverage(workspaceRoot, manifest) {
  const problems = [];
  const byPath = new Map(manifest.repos.map((repo) => [repo.path, repo]));
  const scanRoots = manifest.scan_roots;

  for (const repo of manifest.repos) {
    if (!repo.path) {
      problems.push(`${repo.name}: manifest entry has no 'path'`);
      continue;
    }
    const root = repo.path.split("/")[0];
    if (!scanRoots.includes(root)) {
      problems.push(
        `${repo.name}: path '${repo.path}' is outside every scan root (${scanRoots.join(", ")}), ` +
          `so nothing verifies that this repo still exists or that siblings of it are governed.`,
      );
    }
  }

  for (const root of scanRoots) {
    const rootDir = join(workspaceRoot, root);
    if (!(await directoryExists(rootDir))) {
      problems.push(
        `scan root '${root}' does not exist at ${rootDir}. check-drift must run against a workspace ` +
          `containing every governed repo (--workspace-root); use --manifest-only to validate this ` +
          `repository's manifest and templates alone.`,
      );
      continue;
    }

    const entries = await readdir(rootDir, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory());
    if (directories.length === 0) {
      // A root that scans zero directories would otherwise report as full
      // coverage of nothing.
      problems.push(`scan root '${root}' contains no repositories at ${rootDir} — refusing to report coverage.`);
      continue;
    }

    for (const directory of directories) {
      const path = `${root}/${directory.name}`;
      if (!byPath.has(path)) {
        problems.push(
          `${path} is present in the tree but absent from ${MANIFEST_JSON}. ` +
            `An unlisted repo is unchecked: add an entry with its license kind, or with ` +
            `license=unresolved plus the decision it is waiting on.`,
        );
      }
    }
  }

  return problems;
}

// A public `publish` invocation in a repo's own CI is a release channel by
// definition. Matching the flag (not merely the verb) is what keeps this
// deterministic: `--access public` is the single unambiguous marker that the
// artifact leaves the private plane, and it cannot be reached by a
// `--access restricted` or unscoped-internal publish.
const PUBLIC_PUBLISH_INVOCATION = /\b(?:npm|pnpm|yarn)\s+publish\b[^\n]*--access[ =]+public\b/;

/**
 * `release_channels: [{kind: none}]` is a factual claim — "no version of this
 * repo has been publicly released" — and it is the anchor every BSL Change Date
 * derives from. `checkChangeDateRule` only length-checks its `reason`, so a
 * false claim reads as substantive prose and passes.
 *
 * That is not hypothetical: five BSL submodules declared `kind: none` with the
 * reason "build artifacts (container images) are published only to a private
 * registry" while each ran `npm publish --access public` for a client package
 * carrying `LicenseRef-Xema-BSL-1.1` — the Licensed Work itself, released
 * publicly, with every Change Date anchored to a release the manifest denied.
 * `CHANGE-DATES.md` names "a repository releases through an undeclared channel"
 * as the exact failure this posture exists to prevent, and it still slipped
 * through, because nothing read the repo.
 *
 * So this reads the repo. It asserts only the direction that is decidable
 * offline and without inference: a repo claiming NO channel must contain no
 * public publish in its own workflows. The converse — a declared channel that
 * is dormant — is not an error and is not checked.
 *
 * Cross-repo, so it runs only in full workspace mode. A repo that is not
 * checked out is skipped here and reported by `checkFleetCoverage`, so absence
 * is never silently read as compliance.
 */
export async function checkNoUndeclaredPublishChannel(workspaceRoot, manifest) {
  const problems = [];

  for (const repo of manifest.repos) {
    const declaresNoChannel = (repo.release_channels ?? []).some(
      (channel) => channel.kind === ReleaseChannelKind.None,
    );
    if (!declaresNoChannel) continue;

    const workflowsDir = join(workspaceRoot, repo.path, ".github", "workflows");
    if (!(await directoryExists(workflowsDir))) continue;

    for (const entry of await readdir(workflowsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;

      const lines = (await readFile(join(workflowsDir, entry.name), "utf8")).split("\n");
      for (const [index, line] of lines.entries()) {
        if (!PUBLIC_PUBLISH_INVOCATION.test(line)) continue;
        problems.push(
          `${repo.name}: declares release channel 'none' ("no version has been publicly released"), but ` +
            `${repo.path}/.github/workflows/${entry.name}:${index + 1} publishes publicly: ` +
            `"${line.trim()}". That publish IS a release channel, and every Change Date for this BSL ` +
            `repo is derived from a first-public-release the manifest denies exists. Declare the ` +
            `channel (kind 'npm' or 'oci' with its registry), or remove the publish.`,
        );
      }
    }
  }

  return problems;
}

function excerptAround(content, index) {
  return normalizeWhitespace(content.slice(Math.max(0, index - 60), index + 20));
}

/**
 * The templates end a sentence with `{{ORG}}` and no literal period, because the
 * organization's own name supplies one ("... Neuralchowder Inc."). While a
 * template ALSO carried its own `.`, every rendered artifact read
 * "Neuralchowder Inc.." — which shipped in 39 LICENSE/NOTICE files across the
 * fleet before anyone caught it, because nothing asserted the rendered text.
 *
 * Both halves of that convention are pinned here:
 *   1. the organization must supply the terminal period the templates omit; and
 *   2. no rendered artifact — LICENSE, NOTICE, or per-file header — may contain
 *      a doubled period, whatever produced it.
 *
 * Needs only this repository's own files, so it runs in `--manifest-only` too.
 */
export async function checkRenderedPunctuation(baseDir, manifest) {
  const problems = [];
  const organization = manifest.organization;

  if (typeof organization !== "string" || organization.trim().length === 0) {
    return [`${MANIFEST_JSON}: 'organization' is missing or empty — every rendered legal artifact names it.`];
  }
  if (!organization.endsWith(".")) {
    problems.push(
      `${MANIFEST_JSON}: organization "${organization}" does not end with a period, but the templates ` +
        `place {{ORG}} at the end of a sentence WITHOUT one, relying on the name's own abbreviation ` +
        `period (as in "Neuralchowder Inc."). Re-punctuate the templates for the new name in the same ` +
        `change, or every rendered LICENSE/NOTICE ships unterminated sentences.`,
    );
  }

  const assertNoDoubledPeriod = (label, content) => {
    const match = DOUBLED_PERIOD.exec(content);
    if (match) {
      problems.push(
        `${label}: rendered text contains a doubled period — "${excerptAround(content, match.index)}". ` +
          `A template must not add a period after a value that already ends in one.`,
      );
    }
  };

  for (const repo of manifest.repos) {
    if (repo.license === LicenseKind.Unresolved) {
      // Reported by describeUnresolved; there is no license kind here to render.
      continue;
    }
    let expected;
    try {
      expected = await expectedFiles(baseDir, repo, varsForRepo(manifest, repo));
    } catch {
      // The kind is invalid or a template is missing. checkManifestAndTemplates
      // reports that; re-reporting it here would double the noise.
      continue;
    }
    for (const [filename, content] of Object.entries(expected)) {
      assertNoDoubledPeriod(`${repo.name}: ${filename}`, content);
    }
  }

  // Header templates are not written into any repo by these tools, so the loop
  // above never sees them. They carry {{ORG}} all the same.
  const vars = varsForRepo(manifest, { name: "" });
  for (const [kind, dir] of Object.entries(TEMPLATE_DIR)) {
    for (const headerTemplate of HEADER_TEMPLATES) {
      const content = render(await loadTemplate(baseDir, dir, headerTemplate), vars);
      assertNoDoubledPeriod(`templates/${dir}/${headerTemplate} (license kind '${kind}')`, content);
    }
  }

  return problems;
}

/**
 * `repos.manifest.yaml` is the human-facing mirror named by README_GO_PUBLIC.md
 * while the tools read `repos.manifest.json`. Two files holding the same
 * assignments can disagree, and the one a reader trusts is not the one that is
 * enforced. This pins the load-bearing part — the ordered (name, path, license)
 * triples and the scan roots. Prose fields (reasons, options) are deliberately
 * out of scope; the license assignment is what governs.
 */
export async function checkManifestMirror(baseDir, manifest) {
  const problems = [];
  const yaml = await readFile(join(baseDir, MANIFEST_YAML), "utf8");
  const lines = yaml.split("\n");

  const triples = [];
  let current = null;
  let scanRoots = null;

  for (const line of lines) {
    const scanRootsMatch = /^scan_roots: \[(.*)\]$/.exec(line);
    if (scanRootsMatch) {
      scanRoots = scanRootsMatch[1]
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      continue;
    }
    const nameMatch = /^ {2}- name: (\S+)$/.exec(line);
    if (nameMatch) {
      current = { name: nameMatch[1] };
      triples.push(current);
      continue;
    }
    const pathMatch = /^ {4}path: (\S+)$/.exec(line);
    if (pathMatch && current) {
      current.path = pathMatch[1];
      continue;
    }
    const licenseMatch = /^ {4}license: (\S+)$/.exec(line);
    if (licenseMatch && current) {
      current.license = licenseMatch[1];
    }
  }

  if (scanRoots === null) {
    problems.push(`${MANIFEST_YAML}: no 'scan_roots: [...]' line found`);
  } else if (scanRoots.join(",") !== manifest.scan_roots.join(",")) {
    problems.push(
      `${MANIFEST_YAML}: scan_roots [${scanRoots.join(", ")}] disagree with ${MANIFEST_JSON} ` +
        `[${manifest.scan_roots.join(", ")}]`,
    );
  }

  if (triples.length !== manifest.repos.length) {
    problems.push(
      `${MANIFEST_YAML} lists ${triples.length} repos, ${MANIFEST_JSON} lists ${manifest.repos.length}. ` +
        `The mirrors must stay identical — the tools read the JSON.`,
    );
    return problems;
  }

  for (const [index, expected] of manifest.repos.entries()) {
    const actual = triples[index];
    if (actual.name !== expected.name || actual.path !== expected.path || actual.license !== expected.license) {
      problems.push(
        `${MANIFEST_YAML} entry ${index + 1} is (${actual.name}, ${actual.path}, ${actual.license}) ` +
          `but ${MANIFEST_JSON} has (${expected.name}, ${expected.path}, ${expected.license})`,
      );
    }
  }

  return problems;
}

/**
 * The BSL Change Date is derived per version, never recorded (see
 * CHANGE-DATES.md). That derivation holds only while (1) the rule ships inside
 * the LICENSE every recipient gets, and (2) every BSL repo declares the channel
 * its public releases go through, which is where the authoritative
 * first-public-release timestamp is read from. Both are asserted here.
 */
export async function checkChangeDateRule(baseDir, manifest) {
  const problems = [];
  const bslDefaults = manifest.defaults?.bsl;

  if (!bslDefaults?.change_license) {
    return [`${MANIFEST_JSON}: defaults.bsl.change_license is missing — the Change License is undefined.`];
  }

  const template = normalizeWhitespace(await loadTemplate(baseDir, "bsl-1.1", "LICENSE.tmpl"));
  const derivationClause =
    "Change Date: Four years from the date the specific version of the Licensed Work is first publicly released by Licensor.";

  if (!template.includes(derivationClause)) {
    problems.push(
      `templates/bsl-1.1/LICENSE.tmpl no longer states the per-version Change Date derivation. ` +
        `Expected the clause: "${derivationClause}". Without it a recipient cannot compute the ` +
        `Change Date of the copy they hold, and nothing else records it.`,
    );
  }
  if (!template.includes(`Change License: ${bslDefaults.change_license}`)) {
    problems.push(
      `templates/bsl-1.1/LICENSE.tmpl does not name the Change License declared in ${MANIFEST_JSON} ` +
        `("${bslDefaults.change_license}").`,
    );
  }

  const doc = normalizeWhitespace(await readFile(join(baseDir, CHANGE_DATES_DOC), "utf8"));
  const formula = "change_date(version) = first_public_release(version) + 4 years";
  if (!doc.includes(formula)) {
    problems.push(`${CHANGE_DATES_DOC} no longer states the derivation formula "${formula}".`);
  }
  if (!doc.includes(bslDefaults.change_license)) {
    problems.push(
      `${CHANGE_DATES_DOC} does not name the Change License declared in ${MANIFEST_JSON} ` +
        `("${bslDefaults.change_license}").`,
    );
  }

  for (const repo of manifest.repos) {
    const channels = repo.release_channels;

    if (repo.license !== LicenseKind.Bsl) {
      if (channels !== undefined) {
        problems.push(
          `${repo.name}: declares release_channels but is license=${repo.license}. ` +
            `Release channels exist to locate BSL Change Dates; a stale declaration here is misleading.`,
        );
      }
      continue;
    }

    if (!Array.isArray(channels) || channels.length === 0) {
      problems.push(
        `${repo.name}: BSL repo declares no release_channels. Every BSL repo must state where its ` +
          `public releases happen (${RELEASE_CHANNEL_KINDS.join(" | ")}), because that is where the ` +
          `first-public-release timestamp behind every Change Date is read from. See ${CHANGE_DATES_DOC}.`,
      );
      continue;
    }

    for (const channel of channels) {
      if (!RELEASE_CHANNEL_KINDS.includes(channel.kind)) {
        problems.push(
          `${repo.name}: unknown release channel kind '${channel.kind}' ` +
            `(expected one of ${RELEASE_CHANNEL_KINDS.join(", ")})`,
        );
        continue;
      }
      if (channel.kind === ReleaseChannelKind.None) {
        if (typeof channel.reason !== "string" || channel.reason.trim().length < MIN_REASON_LENGTH) {
          problems.push(
            `${repo.name}: release channel 'none' needs a substantive 'reason' ` +
              `(at least ${MIN_REASON_LENGTH} characters) stating why no version has been publicly released.`,
          );
        }
        continue;
      }
      if (
        (channel.kind === ReleaseChannelKind.Npm || channel.kind === ReleaseChannelKind.Oci) &&
        !channel.registry
      ) {
        problems.push(`${repo.name}: release channel '${channel.kind}' must name the 'registry' it publishes to.`);
      }
    }
  }

  return problems;
}
