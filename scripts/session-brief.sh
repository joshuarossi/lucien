#!/bin/zsh
#
# Claude Code SessionStart hook: prime the assistant with the Dreaming —
# its synthesized memory of the user — plus the live article index.
#
# IMPORTANT: this only helps the Claude Code CLI (the only client that runs
# SessionStart hooks). claude.ai and Claude Desktop do NOT run this; the
# cross-client equivalent is the Lucien MCP server's `instructions` string.
#
# No-op (zero output, exit 0) if ~/Dreaming is absent, so it is safe to ship
# in user-level settings on machines that don't have the Dreaming.
set -u

ARTICLES="$HOME/Dreaming/articles"
[ -d "$ARTICLES" ] || exit 0

cat <<'EOF'
=== The Dreaming — your memory of this user ===
The Dreaming is your synthesized, persistent memory of this user: a
CURRENT-STATE LEDGER, not a transcript archive. Each ARTICLE is the
consolidated understanding of its topic, already distilled from many past
conversations — the synthesis from messages into understanding has been
done for you. Recall is not understanding: do not reconstruct what the
user thinks from raw history or fragments. Find the relevant article and
read it; the article itself already contains the answer. Query the Lucien
MCP rather than guessing or relying on this index alone:
  - lucien_article_search  — find the article(s) for a topic (start here)
  - lucien_list_articles   — full index
  - lucien_article_read    — read an article in full
A topic may span more than one article, but each is the complete answer
for its subject — you are reading finished understanding, not assembling
it from pieces. Treat the article as the user's current position; trace
citations rather than confabulate.

Article index (stems — read the full article via lucien_article_read):
EOF

find "$ARTICLES" -maxdepth 1 -name '*.md' -exec basename {} .md \; \
  | sort \
  | sed 's/^/  - /'

exit 0
