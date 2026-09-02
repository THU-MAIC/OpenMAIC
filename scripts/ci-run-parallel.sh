#!/usr/bin/env bash
# Run NAME/COMMAND pairs in parallel, print each log as a GitHub Actions group,
# and exit non-zero if any command failed.
#
# Usage:
#   scripts/ci-run-parallel.sh NAME COMMAND [NAME COMMAND ...]
set -uo pipefail

if [ "$#" -lt 2 ] || [ $(( $# % 2 )) -ne 0 ]; then
  echo "usage: $0 NAME COMMAND [NAME COMMAND ...]" >&2
  exit 2
fi

logdir="${RUNNER_TEMP:-$(mktemp -d)}/ci-parallel-$$"
mkdir -p "$logdir"

pids=()
names=()
logs=()
i=0
while [ "$#" -ge 2 ]; do
  name="$1"
  cmd="$2"
  shift 2
  log="$logdir/$i.log"
  names+=("$name")
  logs+=("$log")
  (
    bash -c "$cmd" >"$log" 2>&1
  ) &
  pids+=("$!")
  i=$((i + 1))
done

fail=0
for idx in "${!pids[@]}"; do
  pid="${pids[$idx]}"
  name="${names[$idx]}"
  log="${logs[$idx]}"
  if wait "$pid"; then
    echo "::group::${name} (ok)"
    cat "$log"
    echo "::endgroup::"
  else
    status=$?
    if [ "${CI_PARALLEL_ANNOTATE:-1}" != "0" ]; then
      echo "::error::${name} failed with exit ${status}"
    else
      echo "${name} failed with exit ${status}"
    fi
    echo "::group::${name} (failed)"
    cat "$log"
    echo "::endgroup::"
    fail=1
  fi
done

exit "$fail"
