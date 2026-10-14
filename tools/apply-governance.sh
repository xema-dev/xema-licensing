#!/usr/bin/env bash
# INVOKER: none automated, by design — an OPERATOR command, run by hand against
# the GitHub org. Nothing in any of the repositories enumerated from
# `.gitmodules` names it, and nothing should: it mutates branch protection through `gh`, which is an organisation
# setting rather than a build artifact. Wiring it into CI would give a workflow
# admin authority over its own merge rules.
#
# Its two siblings in this directory ARE wired — `tools/check-drift.mjs` as
# `pnpm check` and `tools/sync-licenses.mjs` as `pnpm sync` — so the absence of
# a caller here is a property of what this script DOES, not an oversight.
#
# Apply standard branch-protection governance to a repo's `main`.
#
# NOTE: GitHub only allows branch protection on PUBLIC repos (or paid plans).
# Run this for each repo AFTER you flip it public.
#
# Governance model (Terraform-style):
#   - Pull requests required to merge into `main`.
#   - At least one approving review from a CODEOWNER (the `xema-admin` team).
#   - Stale approvals dismissed on new pushes; conversations must resolve.
#   - Only the `xema-admin` team may push/merge to `main`.
#   - Force-pushes and branch deletion disabled.
#   - enforce_admins=false: org admins (you) can still push directly if needed.
#
# Prereqs: `gh` authenticated with admin on the org; the `xema-admin` team
# exists and has access to the repo; a `.github/CODEOWNERS` file exists.
#
# Usage:
#   tools/apply-governance.sh <repo>            # one repo
#   tools/apply-governance.sh --all             # every repo listed below
set -euo pipefail

ORG="xema-dev"
REPOS=(
  xema-kernel-contracts xema-kernel-sdk xema-biome-sdk xema-runtime-core
  xema-apps identity-api event-hub-api llm-gateway-api secrets-api
  billing-api xema-licensing
)

read -r -d '' BODY <<'JSON' || true
{
  "required_status_checks": null,
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true,
    "required_approving_review_count": 1
  },
  "restrictions": { "users": [], "teams": ["xema-admin"], "apps": [] },
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON

protect() {
  local repo="$1"
  echo "→ protecting ${ORG}/${repo}@main"
  echo "$BODY" | gh api --method PUT "repos/${ORG}/${repo}/branches/main/protection" --input - >/dev/null \
    && echo "  ✓ protected" \
    || echo "  ✗ failed (is the repo public yet?)"
  # Self-hosted-runner safety: require approval for outside-collaborator
  # workflow runs. (No stable REST endpoint — set in the UI:)
  #   Settings → Actions → General → Fork pull request workflows from outside
  #   collaborators → "Require approval for all outside collaborators".
}

if [[ "${1:-}" == "--all" ]]; then
  for r in "${REPOS[@]}"; do protect "$r"; done
else
  [[ -n "${1:-}" ]] || { echo "usage: $0 <repo> | --all"; exit 1; }
  protect "$1"
fi
