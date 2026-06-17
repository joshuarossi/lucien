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

set -o pipefail

# launchd gives a minimal environment. Source the interactive profile so
# bun / claude / git resolve exactly as they do in a normal terminal.
# Done with nounset OFF: third-party dotfile code (chruby, LS_COLORS)
# legitimately references unset params and would otherwise spam stderr.
[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"

# Neutralize interactive zsh hooks the profile installs (chruby_auto on
# preexec, starship prompt hooks). A non-interactive batch pipeline must
# not auto-switch Ruby or render a prompt on every command/cd; chruby_auto
# in particular spams stderr with `RUBY_AUTO_VERSION: parameter not set`
# (a ${VAR?} expansion, fires regardless of nounset) on every command.
preexec_functions=() precmd_functions=() chpwd_functions=()

# Our own code runs under strict nounset; the profile above does not.
set -u

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
# Capture the Dreaming repo HEAD *before* synthesis so the editorial stage can
# scope itself to exactly the articles this run rewrites (their "Synthesis
# update:" commits land after this SHA).
DREAM_BEFORE="$(git -C "$HOME/Dreaming" rev-parse HEAD 2>/dev/null || echo "")"

run_stage "synthesize-dispatch"  "$BUN" run scripts/synthesize-dispatch.ts --concurrency 1 || exit 13

# Stage 4a: deterministic footnote repair. Synthesis is *told* to keep
# [^N] markers/definitions bijective and contiguous but violates it on
# large articles (orphan markers, gaps), which makes wikify's gate reject
# the article every night. This pass ENFORCES the invariant before wikify
# sees it: drops orphan markers/defs, renumbers survivors, records every
# drop in an auditable Talk note, self-commits per article. Idempotent and
# a byte-identical no-op on healthy articles, so --all is safe and cheap.
# Non-fatal: if it errors, wikify simply rejects malformed articles as
# before (graceful degradation), so the chain continues.
run_stage "normalize-footnotes" "$BUN" run scripts/normalize-footnotes.ts --all \
  || echo "!!! normalize-footnotes failed (non-fatal) — continuing"

# Stage 4b: editorial pass. For every article synthesis touched this run,
# wikify.ts runs a Wikipedia-editor restructure behind a deterministic gate
# (no dropped citations, footnote integrity, >=70% word-floor, structural
# sanity) and self-commits "Editorial restructure: <stem>" only when the gate
# passes — a failed gate leaves the merged article untouched. Per-article
# errors (e.g. a rate-limit mid-run) are logged and skipped, not fatal; the
# stage exits 0 so the chain continues. A skipped article is simply not
# restructured until it is synthesized again. Runs before normalize so any
# links the editor emits are canonicalized by the next stage.
if [ -n "$DREAM_BEFORE" ]; then
  run_stage "synthesize-editorial" \
    "$BUN" run scripts/wikify.ts --changed-since "$DREAM_BEFORE" || exit 15
else
  echo ">>> STAGE: synthesize-editorial :: SKIPPED (could not read Dreaming HEAD)"
fi

# Stage 5: normalize wikilink targets to canonical underscore stems. The
# synthesizer can emit a spaced link ([[AI Coding Workflow]]) that resolves to
# nothing and spawns a 0-byte orphan the next time it is clicked in Obsidian.
# This sweep is idempotent and conservative (true redlinks are left alone), so
# it is safe to run unconditionally. Stage only modifications to already-tracked
# markdown articles ('git add -u' + a '*.md' pathspec) — this excludes both
# Obsidian-created orphan stubs (untracked) and the tracked but noisy
# articles/.obsidian/ workspace files.
run_stage "normalize-wikilinks"  "$BUN" run scripts/normalize-wikilinks.ts  || exit 14
(
  cd "$HOME/Dreaming" \
    && git add -u -- 'articles/*.md' \
    && { git diff --cached --quiet \
         || git commit -m "Normalize wikilinks to canonical article stems"; }
) || echo "!!! normalize-wikilinks commit skipped (non-fatal)"

# Stage 6: changelog. Deterministic per-run digest — diffs articles/ between
# the pre-synthesis HEAD and now, prepends a dated "## YYYY-MM-DD — OK" section
# (new/updated/removed, one line per article) to Meta/Changelog.md. Answers the
# morning "did it run / what changed" question with a single page. Non-fatal:
# a changelog failure must not fail a run that already succeeded.
if [ -n "$DREAM_BEFORE" ]; then
  run_stage "write-changelog" "$BUN" run scripts/write-changelog.ts --since "$DREAM_BEFORE" \
    || echo "!!! write-changelog failed (non-fatal)"
  (
    cd "$HOME/Dreaming" \
      && git add -- 'Meta/Changelog.md' \
      && { git diff --cached --quiet \
           || git commit -m "Changelog: $(date +%Y-%m-%d) run"; }
  ) || echo "!!! changelog commit skipped (non-fatal)"
else
  echo ">>> STAGE: write-changelog :: SKIPPED (could not read Dreaming HEAD)"
fi

echo ""
echo "=== Lucien nightly run complete $(date) ==="

# Retention: keep the 30 most recent logs.
ls -1t "$LOG_DIR"/nightly-*.log 2>/dev/null | tail -n +31 | xargs -I{} rm -f -- {} 2>/dev/null || true

exit 0
