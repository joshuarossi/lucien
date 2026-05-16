#!/bin/zsh
#
# Lucien nightly pipeline wrapper. Invoked by launchd
# (~/Library/LaunchAgents/com.lucien.nightly.plist) at 02:00 local.
#
# Runs the four incremental stages in order. The claude.ai sub-source of
# stage 1 may degrade (Cloudflare re-auth needed, or no GUI session at 2am)
# — that is logged and NOT fatal; per-source watermarks mean the next
# successful run catches up with zero data loss. A hard failure in any
# stage stops the chain and exits non-zero so launchd records it.
#
# Everything is tee'd to .lucien/logs/nightly-<timestamp>.log.

set -u
set -o pipefail

# launchd gives a minimal environment. Source the interactive profile so
# bun / claude / git resolve exactly as they do in a normal terminal.
[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"

REPO="/Users/joshrossi/Code/lucien"
cd "$REPO" || { echo "FATAL: cannot cd to $REPO"; exit 1; }

LOG_DIR="$REPO/.lucien/logs"
mkdir -p "$LOG_DIR"
TS="$(date +%Y-%m-%d-%H%M%S)"
LOG="$LOG_DIR/nightly-$TS.log"

# Absolute paths as a belt-and-suspenders fallback if profile sourcing
# didn't put them on PATH under launchd.
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"

exec > >(tee -a "$LOG") 2>&1

echo "=== Lucien nightly run $TS (local $(date)) ==="

run_stage() {
  local label="$1"; shift
  echo ""
  echo ">>> STAGE: $label  ::  $*"
  local start=$SECONDS
  if "$@"; then
    echo "<<< $label OK ($((SECONDS - start))s)"
    return 0
  else
    local code=$?
    echo "!!! $label FAILED (exit $code) — stopping nightly run"
    return $code
  fi
}

# Stage 1: ingest. The adapter itself decides claude.ai degradation; a
# non-zero exit here means a real failure (e.g. DB unwritable), so we stop.
run_stage "ingest-recent"        "$BUN" run scripts/ingest-recent.ts        || exit 10
run_stage "chunk-recent"         "$BUN" run scripts/chunk-recent.ts         || exit 11
run_stage "cluster-assign-recent" "$BUN" run scripts/cluster-assign-recent.ts || exit 12
run_stage "synthesize-dispatch"  "$BUN" run scripts/synthesize-dispatch.ts  || exit 13

echo ""
echo "=== Lucien nightly run complete $(date) ==="

# Retention: keep the 30 most recent logs.
ls -1t "$LOG_DIR"/nightly-*.log 2>/dev/null | tail -n +31 | xargs -I{} rm -f -- {} 2>/dev/null || true

exit 0
