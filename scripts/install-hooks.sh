#!/usr/bin/env bash
# Installs git hooks from .githooks/ into the repository's hooks directory.
# Run via: just setup

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS_SRC="$REPO_ROOT/.githooks"

# Ask git for the hooks path rather than assuming `.git/hooks`. In a linked
# worktree `.git` is a file (a `gitdir:` pointer), not a directory, so the
# hardcoded path does not exist and `cp` fails with "Not a directory" — which
# broke `just setup` for anyone working in a linked worktree.
#
# `--git-path` returns an absolute path from a worktree but a path relative to
# the repo root from a normal checkout, so normalize before use.
#
# "Absolute" is not just a leading slash: under Git Bash on Windows git reports
# a drive-qualified path like `D:/a/repo/.git/hooks`, which a `/*` test misses.
# Prefixing REPO_ROOT onto that produced a nested junk directory
# (`/d/a/wt-probe/D:/a/repo/.git/hooks`) instead of failing outright, so match
# the drive form explicitly.
HOOKS_DST="$(cd "$REPO_ROOT" && git rev-parse --git-path hooks)"
case "$HOOKS_DST" in
  /* | [A-Za-z]:/* | [A-Za-z]:\\*) ;;
  *) HOOKS_DST="$REPO_ROOT/$HOOKS_DST" ;;
esac

if [ ! -d "$HOOKS_SRC" ]; then
  echo "No .githooks/ directory found — nothing to install."
  exit 0
fi

echo "Installing git hooks..."

mkdir -p "$HOOKS_DST"

installed=0
for hook in "$HOOKS_SRC"/*; do
  [ -f "$hook" ] || continue
  name="$(basename "$hook")"
  cp "$hook" "$HOOKS_DST/$name"
  chmod +x "$HOOKS_DST/$name"
  # Assert the hook is actually in place and runnable. A hook that silently
  # fails to install is worse than a loud failure: the pre-commit guards just
  # never run, and nothing says so.
  if [ ! -x "$HOOKS_DST/$name" ]; then
    echo "  FAILED: $name did not install to $HOOKS_DST" >&2
    exit 1
  fi
  echo "  Installed: $name"
  installed=$((installed + 1))
done

echo "Git hooks installed ($installed into $HOOKS_DST)."
