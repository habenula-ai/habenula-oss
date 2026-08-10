#!/usr/bin/env bash
# Create packages/engine/.dev.vars when it is missing. Idempotent: an existing
# file is never touched. Called by `just setup` and by the `just dev` preflight.
#
# Resolution order:
#   1. File exists              -> do nothing.
#   2. Linked git worktree      -> copy the main checkout's .dev.vars if it has
#                                  one (the file is gitignored, so a new
#                                  worktree never carries it over).
#   3. Otherwise                -> copy .dev.vars.example and generate real
#                                  values for the two local secrets.
#
# Only local secrets are generated: CREDENTIAL_ENCRYPTION_KEY (at-rest
# encryption for stored credentials) and INTERNAL_MCP_TOKEN (the CLI-to-engine
# caller token). ANTHROPIC_API_KEY is an external credential and is never
# auto-filled; `just dev` warns when it is missing.
set -euo pipefail

cd "$(dirname "$0")/.."

vars=packages/engine/.dev.vars
example=packages/engine/.dev.vars.example

if [ -f "$vars" ]; then
    exit 0
fi

git_dir=$(git rev-parse --path-format=absolute --git-dir)
common_dir=$(git rev-parse --path-format=absolute --git-common-dir)
if [ "$git_dir" != "$common_dir" ]; then
    main_checkout=$(dirname "$common_dir")
    if [ -f "$main_checkout/$vars" ]; then
        cp "$main_checkout/$vars" "$vars"
        echo "scaffold-dev-vars: adopted $vars from the main checkout ($main_checkout)"
        exit 0
    fi
fi

cp "$example" "$vars"
# Write through a temp file instead of sed -i: GNU sed wants -i, BSD/macOS sed
# wants -i '', and the temp-file form works on both plus Git Bash on Windows.
setvar() {
    sed "s|^$1=.*|$1=$2|" "$vars" > "$vars.tmp" && mv "$vars.tmp" "$vars"
}
setvar CREDENTIAL_ENCRYPTION_KEY "$(openssl rand -hex 32)"
setvar INTERNAL_MCP_TOKEN "$(openssl rand -hex 32)"
echo "scaffold-dev-vars: created $vars from the example, with generated local secrets."
echo "scaffold-dev-vars: chat needs a real ANTHROPIC_API_KEY in $vars (or an LLM_* provider) — see the comments in that file."
