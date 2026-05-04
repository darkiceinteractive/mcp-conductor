#!/usr/bin/env bash
# Remove all v3 sprint worktrees. Run AFTER agents' branches are merged to feature/v3.
# Run from repo root: bash _plans/v3-enhancements/cleanup-worktrees.sh

set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_ROOT="$(dirname "$REPO_ROOT")/mcp-executor-darkice-worktrees"

if [ ! -d "$WORKTREE_ROOT" ]; then
  echo "Nothing to clean — $WORKTREE_ROOT does not exist."
  exit 0
fi

echo "About to remove all worktrees under $WORKTREE_ROOT and their branches."
echo "Press Ctrl-C to abort, or any key to continue..."
read -r _

for d in "$WORKTREE_ROOT"/*/; do
  [ -d "$d" ] || continue
  echo "remove $d"
  git -C "$REPO_ROOT" worktree remove --force "$d" || true
done

git -C "$REPO_ROOT" worktree prune
rmdir "$WORKTREE_ROOT" 2>/dev/null || true
echo "Done. Branches feature/v3-phase-* and feature/v3-x-* remain — delete with:"
echo "  git branch -D feature/v3-phase-{0-1,2,3,4,5,6,7} feature/v3-x{1-passthrough,2-lifecycle,4-tokenization}"
