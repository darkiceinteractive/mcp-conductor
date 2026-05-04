#!/usr/bin/env bash
# Create 10 git worktrees off feature/v3, one per agent.
# Run from repo root: bash _plans/v3-enhancements/setup-worktrees.sh

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_ROOT="$(dirname "$REPO_ROOT")/mcp-executor-darkice-worktrees"

echo "Repo root:     $REPO_ROOT"
echo "Worktree root: $WORKTREE_ROOT"

# Confirm we're on feature/v3
current_branch="$(git -C "$REPO_ROOT" branch --show-current)"
if [ "$current_branch" != "feature/v3" ]; then
  echo "ERROR: must be on branch 'feature/v3' (currently on '$current_branch')"
  exit 1
fi

git -C "$REPO_ROOT" fetch origin

mkdir -p "$WORKTREE_ROOT"

declare -a TREES=(
  "A-phase-0-1:feature/v3-phase-0-1"
  "B-phase-2:feature/v3-phase-2"
  "C-phase-3:feature/v3-phase-3"
  "D-phase-4:feature/v3-phase-4"
  "E-phase-5:feature/v3-phase-5"
  "F-phase-6:feature/v3-phase-6"
  "G-phase-7:feature/v3-phase-7"
  "H-x1:feature/v3-x1-passthrough"
  "I-x2:feature/v3-x2-lifecycle"
  "J-x4:feature/v3-x4-tokenization"
)

for entry in "${TREES[@]}"; do
  dir="${entry%%:*}"
  branch="${entry##*:}"
  path="$WORKTREE_ROOT/$dir"
  if [ -d "$path" ]; then
    echo "skip   $dir (already exists)"
    continue
  fi
  echo "create $dir on branch $branch"
  git -C "$REPO_ROOT" worktree add -b "$branch" "$path" feature/v3
done

echo
echo "All worktrees created under $WORKTREE_ROOT"
echo "List:"
git -C "$REPO_ROOT" worktree list
