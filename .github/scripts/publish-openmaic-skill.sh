#!/usr/bin/env bash

set -euo pipefail

fail() {
  echo "::error::$1" >&2
  exit 1
}

if [[ "$#" -eq 0 ]]; then
  dry_run=false
elif [[ "$#" -eq 1 && "$1" == "--dry-run" ]]; then
  dry_run=true
else
  fail "Usage: publish-openmaic-skill.sh [--dry-run]"
fi

[[ -n "${SOURCE_REPO:-}" ]] || fail "SOURCE_REPO is required."
[[ "${PUBLISH_VERSION+x}" == x ]] || fail "PUBLISH_VERSION is required."
[[ -n "${CLAWHUB:-}" ]] || fail "CLAWHUB is required."

source_commit="$(git rev-parse HEAD)"
publish_args=(
  skills/openmaic
  --slug openmaic
  --name OpenMAIC
  --owner wyuc
  --source-repo "$SOURCE_REPO"
  --source-commit "$source_commit"
  --source-path skills/openmaic
)

if [[ -n "$PUBLISH_VERSION" ]]; then
  [[ -n "${RUNNER_TEMP:-}" ]] || fail "RUNNER_TEMP is required for version preflight."
  preflight_file="$RUNNER_TEMP/clawhub-version-preflight.json"
  "$CLAWHUB" skill publish "${publish_args[@]}" --dry-run --json | tee "$preflight_file"
  if ! decision="$(PREFLIGHT_FILE="$preflight_file" node .github/scripts/check-clawhub-version.mjs)"; then
    exit 1
  fi
  IFS=$'\t' read -r action canonical_version extra <<< "$decision"
  if [[ -n "${extra:-}" || -z "$action" || -z "$canonical_version" ]]; then
    fail "Invalid version preflight decision."
  fi
  case "$action" in
    noop)
      echo "::notice::The requested version already has identical content."
      exit 0
      ;;
    continue) publish_args+=(--version "$canonical_version") ;;
    *) fail "Unknown version preflight action." ;;
  esac
fi

if [[ "$dry_run" == true ]]; then
  "$CLAWHUB" skill publish "${publish_args[@]}" --dry-run --json
else
  "$CLAWHUB" skill publish "${publish_args[@]}" --json
fi
