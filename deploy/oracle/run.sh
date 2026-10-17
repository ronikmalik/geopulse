#!/usr/bin/env bash
# Runs one or more scripts/run-job.ts jobs in order, on the Oracle VM
# (2026-10-17; replaces the GitHub Actions workflows after GitHub disabled
# Actions on this repo). Called by the systemd units bootstrap.sh writes:
#
#   run.sh ingest review-pending generate-briefs   (every 30 min)
#   run.sh snapshot pipeline-health                (daily 18:00 UTC)
#
# Every job runs even if an earlier one failed, matching ingest.yml's
# `if: !cancelled()` chaining; the exit code is non-zero if any failed.
# The whole body sits in one { } block so bash has parsed it before the
# `git reset` below can rewrite this file underneath it.
{
set -uo pipefail
APP=/opt/geopulse/app
cd "$APP" || exit 1

# Same per-job ceilings the workflows passed as timeout-minutes.
timeout_for() {
  case "$1" in
    ingest|snapshot|snapshot-flights|audit-classifier|sync-sanctions) echo 10 ;;
    review-pending|generate-briefs) echo 6 ;;
    train-*) echo 15 ;;
    *) echo 3 ;;
  esac
}

# Deploy = whatever is on master, as each Actions run checked it out.
# A failed fetch keeps the current checkout; dependencies are reinstalled
# only when the lockfile changes.
if [ "${1:-}" = "ingest" ]; then
  before=$(sha256sum package-lock.json | cut -d' ' -f1)
  if git fetch -q origin master && git reset -q --hard origin/master; then
    after=$(sha256sum package-lock.json | cut -d' ' -f1)
    if [ "$before" != "$after" ] || [ ! -d node_modules ]; then
      npm ci --no-audit --no-fund --loglevel=error || echo "npm ci failed; keeping old node_modules"
    fi
  else
    echo "git update failed; running the current checkout ($(git rev-parse --short HEAD))"
  fi
fi

failed=()
for job in "$@"; do
  echo "== $job ($(git rev-parse --short HEAD))"
  JOB_TIMEOUT_MINUTES=$(timeout_for "$job") node_modules/.bin/tsx scripts/run-job.ts "$job" || failed+=("$job")
done

# Optional dead-man's switch: a healthchecks.io-style URL per unit, set in
# /etc/geopulse/env. A missing ping is how a stopped VM gets noticed.
ping_var="HC_PING_${GEOPULSE_UNIT:-}"
url="${!ping_var:-}"
if [ -n "$url" ]; then
  if [ ${#failed[@]} -eq 0 ]; then curl -fsS -m 10 --retry 3 "$url" >/dev/null
  else curl -fsS -m 10 --retry 3 "$url/fail" >/dev/null; fi
fi

if [ ${#failed[@]} -gt 0 ]; then echo "failed: ${failed[*]}"; exit 1; fi
exit 0
}
