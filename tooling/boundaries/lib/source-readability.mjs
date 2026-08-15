#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// source-readability.mjs — the ONE implementation of "a tracked source file
// must be readable by search", usable BOTH as a library and as a standalone
// per-repository gate.
//
// WHY THIS FILE IS SELF-CONTAINED AND VENDORED
//
//   A source file containing a raw NUL byte is classified as BINARY by every
//   binary-skipping search tool — ugrep, ripgrep, `grep -I`, and the editor and
//   review surfaces built on them. They do not warn; they skip the whole file
//   and report zero matches. So the file is invisible to every audit, every
//   review sweep, every grep-based boundary check, and every agent that answers
//   a question by searching the tree.
//
//   The aggregator has gated this since 2026-08-11 across all declared
//   repositories. That is necessary and not sufficient: a defect that lands in
//   a carved repository passes THAT repository's CI and only surfaces when
//   somebody syncs the aggregator's submodule pointer — late, far from its
//   cause. It happened twice on 2026-08-15 (`repos-infra/xema-deploy` carried
//   raw NULs in a tracked script; `repos/xema-kernel-sdk` had no equivalent
//   gate either), and in the xema-deploy case the NULs hid a function
//   DEFINITION while twelve call sites stayed visible — the exact shape that
//   gets live code deleted as dead.
//
//   So every repository runs it over its own index. The delivery mechanism is a
//   byte-identical VENDORED COPY, not an npm package, and that is deliberate:
//
//     • It must run from a BARE CHECKOUT with no install. Most producing repos
//       never `pnpm install` before their earliest gates, and seven of the
//       eight `repos-infra/*` repositories have no `package.json` at all (they
//       are Go / Terraform / Ansible / GitOps-YAML trees). A package they
//       cannot install is a gate they cannot run.
//     • The independent submodules declare `packageManager: npm` and must stay
//       Xema-agnostic; giving them an `@xemahq/*` dependency to check their own
//       bytes would be exactly the coupling `.claude/rules/submodules.md`
//       forbids.
//
//   That is the same shape, for the same reason, as
//   `tooling/boundaries/lib/executable-source.mjs` and
//   `tooling/dev/assert-single-package-store.mjs`. Drift is prevented the same
//   way: `check-source-readability-parity.mjs` sha256-compares every copy
//   against this canonical one and asserts each repository actually RUNS it.
//   A behavioural comparison ("does it export `findUnreadableBytes`?") is the
//   weaker form that would admit a body degenerated to `return []` — this repo
//   has shipped that mistake enough times to name it.
//
// WHAT IT ASSERTS
//
//   No tracked source file contains a byte that makes a search tool refuse to
//   read it:
//     • a NUL byte (0x00)              — the classifier every tool agrees on;
//     • any other C0 control byte or DEL, except TAB / LF / CR — same authoring
//       hazard, and several tools treat these as binary too;
//     • invalid UTF-8                  — GNU grep calls an encoding error
//                                        binary exactly as it does a NUL.
//
//   Detection reads the BYTES directly and never shells out to a grep. This is
//   deliberate: the greps disagree with each other. BSD `grep -lI ''` short-
//   circuits on the first matching line and reported two of the sixteen files
//   found in the original sweep as perfectly readable, while ugrep — which
//   reads the whole file, and is what the audit actually used — skipped both. A
//   guard whose verdict depends on which grep is on PATH is not a guard.
//
// FIXING A FINDING
//
//   Replace the raw byte with its unicode escape (`\u0000`, `\u0001`, …) and
//   leave a comment at the site saying why the escape must stay. Do NOT delete
//   the byte: it is almost always a key separator chosen precisely because it
//   cannot occur in the data, and removing it introduces a collision.
//
//   There is deliberately NO allowlist. A file that genuinely needs raw binary
//   content is not a source file — give it a binary extension so it falls
//   outside `SOURCE_EXTENSIONS`, or store it as base64. Every prior instance of
//   this repo's "a check that reports green while executing nothing" defect
//   survived because the skip had somewhere quiet to live.
//
// USAGE
//   node <path>/source-readability.mjs              # gate this repository
//   node <path>/source-readability.mjs --self-test  # prove the detector works
//
//   As a library:
//     import { findUnreadableBytes, inspectRepository } from './source-readability.mjs';
//
// ⚠ VENDORED COPY — DO NOT EDIT IN PLACE.
//   The canonical file is `tooling/boundaries/lib/source-readability.mjs` in the
//   xema-monorepo aggregator. Every other copy is byte-identical and verified by
//   sha256. Edit the canonical one and re-vendor; editing a copy turns the
//   parity gate red, which is the point.
// ═══════════════════════════════════════════════════════════════════════════

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * Text-source extensions. An extension is on this list because a file carrying
 * it is authored and read as text — so a byte that makes it unsearchable is
 * always a defect. Anything genuinely binary (images, fonts, tarballs, `.bin`
 * fixtures) has an extension that is NOT here and is never inspected.
 */
export const SOURCE_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'mjs', 'cjs', 'jsx',
  'json', 'jsonc',
  'md', 'mdx',
  'yaml', 'yml', 'toml',
  'sql', 'prisma', 'graphql', 'gql',
  'sh', 'bash',
  'css', 'scss', 'html',
  'go', 'py', 'tf', 'tfvars',
]);

/** Directories whose contents are build output or vendored, never authored here. */
export const PRUNED_PATH_SEGMENTS = [
  '/node_modules/', '/dist/', '/.next/', '/.turbo/', '/coverage/', '/.xema/', '/vendor/',
];

const NUL = 0x00;

/** TAB, LF, CR are the only C0 bytes a text file may carry raw. */
function isForbiddenControlByte(b) {
  if (b === 0x09 || b === 0x0a || b === 0x0d) return false;
  return b < 0x20 || b === 0x7f;
}

/**
 * Classify one file's bytes.
 *
 * @param {Buffer} buf
 * @returns {{kind: string, byte: number, offset: number}[]} findings, empty when clean
 */
export function findUnreadableBytes(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i += 1) {
    const b = buf[i];
    if (!isForbiddenControlByte(b)) continue;
    out.push({ kind: b === NUL ? 'NUL' : 'control', byte: b, offset: i });
  }
  if (out.length > 0) return out;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    out.push({ kind: 'invalid-utf8', byte: -1, offset: -1 });
  }
  return out;
}

/** 1-based (line, column) of a byte offset, counting LF only. */
export function positionOf(buf, offset) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset; i += 1) {
    if (buf[i] === 0x0a) {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
  return { line, col };
}

/** Render one file's findings as the short `NUL@12:7 0x01@40:3` form. */
export function describeFindings(buf, findings, limit = 8) {
  const shown = findings.slice(0, limit);
  const where = shown
    .map((f) => {
      if (f.kind === 'invalid-utf8') return 'invalid UTF-8';
      const { line, col } = positionOf(buf, f.offset);
      const name = f.kind === 'NUL' ? 'NUL' : `0x${f.byte.toString(16).padStart(2, '0')}`;
      return `${name}@${line}:${col}`;
    })
    .join(' ');
  const more = findings.length > shown.length ? ` (+${findings.length - shown.length} more)` : '';
  return `${where}${more}`;
}

/**
 * Every tracked (and not-yet-staged) source file in ONE git repository.
 *
 * `--others --exclude-standard` includes a new file the author has not staged
 * yet, so the finding lands before the commit rather than in CI.
 *
 * A failed `git ls-files` is FATAL, never an empty list: a repository this
 * cannot enumerate is not a repository with nothing to check, and every prior
 * instance of this codebase's most-repeated defect entered exactly there.
 *
 * @param {string} repoRoot absolute path to a git working tree
 * @returns {string[]} repo-relative paths
 */
export function listTrackedSourceFiles(repoRoot) {
  let listed;
  try {
    listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: repoRoot,
      encoding: 'buffer',
      maxBuffer: 512 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`\`git ls-files\` failed in ${repoRoot}: ${error.message}`);
  }
  const out = [];
  for (const rel of listed.toString('utf8').split('\0')) {
    if (!rel) continue;
    const dot = rel.lastIndexOf('.');
    if (dot === -1 || !SOURCE_EXTENSIONS.has(rel.slice(dot + 1))) continue;
    if (PRUNED_PATH_SEGMENTS.some((seg) => `/${rel}`.includes(seg))) continue;
    out.push(rel);
  }
  return out;
}

/**
 * Enumerate + inspect one repository.
 *
 * @param {string} repoRoot absolute path to a git working tree
 * @returns {{listed: number, inspected: number, violations: {rel: string, findings: object[], buf: Buffer}[]}}
 */
export function inspectRepository(repoRoot) {
  const files = listTrackedSourceFiles(repoRoot);
  const violations = [];
  let inspected = 0;
  for (const rel of files) {
    const full = resolve(repoRoot, rel);
    // `--cached` lists what the INDEX holds, which includes a file deleted in
    // the working tree but not yet staged — an ordinary state mid-change. Drop
    // those here; a read failure on a file that DOES exist stays fatal.
    if (!existsSync(full)) continue;
    let buf;
    try {
      buf = readFileSync(full);
    } catch (error) {
      throw new Error(`failed to read ${rel}: ${error.message}`);
    }
    inspected += 1;
    const findings = findUnreadableBytes(buf);
    if (findings.length > 0) violations.push({ rel, findings, buf });
  }
  return { listed: files.length, inspected, violations };
}

// ── Self-test ──────────────────────────────────────────────────────────────
// The detector's failure mode is silence: if `findUnreadableBytes` stops
// recognising a byte class, every gate built on it reports a clean tree over
// files it no longer understands — indistinguishable from real coverage. So it
// re-proves itself, in both directions, before it is trusted to say green.
//
// This runs on EVERY invocation of the CLI below, not only under `--self-test`.
// A self-test nobody remembers to pass a flag for is a self-test that does not
// run; it costs well under a millisecond and it is the only thing standing
// between a degenerate detector and a green tick.
export function runSelfTest() {
  const cases = [
    ['clean ascii', Buffer.from('const a = 1;\n'), 0],
    ['clean utf8 + tabs/CRLF', Buffer.from('const s = "héllo — ok";\r\n\tconst t = 2;\n'), 0],
    ['escaped NUL is CLEAN', Buffer.from('const k = `a\\u0000b`;\n'), 0],
    ['raw NUL', Buffer.from([0x61, 0x00, 0x62, 0x0a]), 1],
    ['raw SOH', Buffer.from([0x61, 0x01, 0x62, 0x0a]), 1],
    ['raw DEL', Buffer.from([0x61, 0x7f, 0x62, 0x0a]), 1],
    ['raw ESC', Buffer.from([0x61, 0x1b, 0x62, 0x0a]), 1],
    ['two raw NULs', Buffer.from([0x61, 0x00, 0x62, 0x00, 0x63, 0x0a]), 2],
    ['invalid utf8', Buffer.from([0x63, 0x6f, 0x6e, 0x73, 0x74, 0x20, 0xc3, 0x28, 0x0a]), 1],
    ['form feed is forbidden', Buffer.from([0x61, 0x0c, 0x62, 0x0a]), 1],
  ];
  const failures = [];
  for (const [label, buf, expected] of cases) {
    const found = findUnreadableBytes(buf).length;
    if (found !== expected) failures.push(`"${label}" expected ${expected} finding(s), got ${found}`);
  }
  // Position reporting must be right, or a finding names the wrong line and the
  // author edits somewhere else.
  const posBuf = Buffer.from([0x6c, 0x69, 0x6e, 0x65, 0x31, 0x0a, 0x6c, 0x69, 0x6e, 0x65, 0x32, 0x00, 0x78, 0x0a]);
  const pos = positionOf(posBuf, findUnreadableBytes(posBuf)[0].offset);
  if (pos.line !== 2 || pos.col !== 6) failures.push(`positionOf expected 2:6, got ${pos.line}:${pos.col}`);
  // The extension filter is the other silent-shrink surface: a typo'd entry
  // empties the scan for a whole language while every other case still passes.
  for (const ext of ['ts', 'mjs', 'go', 'tf', 'yaml', 'sh', 'md', 'sql']) {
    if (!SOURCE_EXTENSIONS.has(ext)) failures.push(`SOURCE_EXTENSIONS lost "${ext}"`);
  }
  return { cases: cases.length, failures };
}

// ── CLI ────────────────────────────────────────────────────────────────────
// Runs only when this file is the entry point, so importing it as a library
// (the aggregator's multi-repository gate does) costs nothing.
const CHECK_NAME = 'check-source-readability';

function main() {
  const { cases, failures } = runSelfTest();
  if (failures.length > 0) {
    console.error(`\n✘ ${CHECK_NAME}: ${failures.length} self-test failure(s). The detector is broken; its`);
    console.error('  green means nothing until this passes.\n');
    for (const f of failures) console.error(`  • ${f}`);
    exit(2);
  }
  if (argv.includes('--self-test')) {
    console.log(`✓ ${CHECK_NAME} self-test: ${cases} detector case(s), position reporting, extension set.`);
    exit(0);
  }

  // The repository is resolved by asking GIT, not by counting `..` from this
  // file's location. The copies are vendored at different depths in different
  // repositories (`tooling/boundaries/lib/`, `scripts/lib/`, …) and a relative
  // walk would have to differ per copy — which would break byte-identity, which
  // is the one thing keeping the copies honest.
  let repoRoot;
  try {
    repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch (error) {
    console.error(`\n✘ ${CHECK_NAME}: not inside a git working tree (${error.message}).`);
    console.error('  This gate reads the repository index; there is nothing to read.\n');
    exit(2);
  }

  let result;
  try {
    result = inspectRepository(repoRoot);
  } catch (error) {
    console.error(`\n✘ ${CHECK_NAME}: ${error.message}`);
    console.error('  Refusing to report a verdict over a scan that did not complete.\n');
    exit(2);
  }

  // The zero-scan invariant, inlined because this file may import nothing.
  // Every repository in this fleet carries authored text — a README at minimum —
  // so zero here is a broken read or a stale extension set, never a repository
  // with nothing to check.
  if (result.inspected === 0) {
    console.error(
      `\n✘ ${CHECK_NAME}: enumerated ${result.listed} file(s) and opened NONE in ${repoRoot}.\n` +
        '  A scan that inspects nothing is not a pass. Check SOURCE_EXTENSIONS and\n' +
        '  PRUNED_PATH_SEGMENTS, and that this is a populated checkout.\n',
    );
    exit(2);
  }

  if (result.violations.length > 0) {
    console.error(
      `\n✘ ${CHECK_NAME}: ${result.violations.length} tracked source file(s) contain bytes that make ` +
        'search tools classify them as BINARY and skip them SILENTLY.\n',
    );
    for (const { rel, findings, buf } of result.violations) {
      console.error(`  ${rel}`);
      console.error(`      ${describeFindings(buf, findings)}`);
    }
    console.error(
      '\nSuch a file is invisible to ugrep / ripgrep / `grep -I`, to every grep-based check in the\n' +
        'fleet, and to every audit or review that searches the tree. An audit already concluded a\n' +
        'live error code had zero producers because its only producer sat in one of these files.\n\n' +
        'Fix: spell the byte as its unicode escape (`\\u0000`, `\\u0001`, …) — value-identical in\n' +
        'every JS/TS string and template literal — and leave a comment at the site saying why the\n' +
        'escape must stay. Do NOT delete the byte; it is almost always a key separator chosen\n' +
        'because it cannot occur in the data.\n',
    );
    exit(1);
  }

  console.log(
    `✓ ${CHECK_NAME}: ${result.inspected} tracked source file(s) in this repository are readable ` +
      'by search — no NUL, no stray control byte, valid UTF-8.',
  );
}

if (argv[1] && resolve(argv[1]) === fileURLToPath(import.meta.url)) main();
