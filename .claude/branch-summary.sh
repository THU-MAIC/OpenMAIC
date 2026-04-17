#!/bin/bash
# Runs on Stop events; only acts if 12 hours have elapsed since last summary.
# Appends a condensed branch-activity summary to HISTORY.md.

REPO="/home/user/OpenMAIC"
STAMP_FILE="$REPO/.claude/last-summary-at"
HISTORY="$REPO/HISTORY.md"

NOW=$(date +%s)

# Skip if fewer than 12 hours since last run
if [ -f "$STAMP_FILE" ]; then
  LAST=$(cat "$STAMP_FILE" 2>/dev/null)
  if [ $((NOW - LAST)) -lt 43200 ]; then
    exit 0
  fi
fi

# Fetch quietly
git -C "$REPO" fetch --all --quiet 2>/dev/null

# Commits on any branch in the last 12 hours, no merges
SINCE="12 hours ago"
COMMITS=$(git -C "$REPO" log --all --no-merges --oneline --since="$SINCE" 2>/dev/null)

# Even if no commits, stamp and exit (nothing to summarise)
echo "$NOW" > "$STAMP_FILE"
[ -z "$COMMITS" ] && exit 0

# Count per branch (first-parent names)
BRANCH_SUMMARY=$(git -C "$REPO" log --all --no-merges --format="%D" --since="$SINCE" 2>/dev/null \
  | grep -oP 'origin/\K[^,\s]+' | sort | uniq -c | sort -rn \
  | awk '{printf "  - %s (%s new commit%s)\n", $2, $1, ($1==1?"":"s")}')

TIMESTAMP=$(date -u '+%Y-%m-%d %H:%M UTC')
COMMIT_COUNT=$(echo "$COMMITS" | wc -l | tr -d ' ')

cat >> "$HISTORY" << EOF

---

### Branch snapshot — $TIMESTAMP

**$COMMIT_COUNT commit(s) in the last 12 hours:**

$BRANCH_SUMMARY

\`\`\`
$COMMITS
\`\`\`
EOF
