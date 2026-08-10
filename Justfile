# Habenula OSS recipes

# Show available commands
default:
    @just --list

# One-command local dev: scaffold .dev.vars if missing, warn on placeholder
# secrets, then start the engine, wait for /api/health, run the interactive
# CLI, tear the engine down on exit. The two-terminal engine-dev / cli-dev
# recipes remain for debugging — the REPL's recovery behavior makes their
# ordering safe.
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    # Preflight: create .dev.vars when missing (adopting the main checkout's
    # copy in a worktree), then warn — never block — on values that fail
    # closed at runtime. The engine still boots; the warnings name the fix.
    bash scripts/scaffold-dev-vars.sh
    vars=packages/engine/.dev.vars
    getvar() { grep "^$1=" "$vars" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
    for k in CREDENTIAL_ENCRYPTION_KEY INTERNAL_MCP_TOKEN; do
        case "$(getvar "$k")" in
            ""|*your-64-char*|*YOUR-KEY-HERE*|*CHANGEME*|*changeme*)
                echo "warning: $k in $vars is empty or a placeholder — the engine fails closed without a real value (generate one: openssl rand -hex 32)" >&2 ;;
        esac
    done
    case "$(getvar ANTHROPIC_API_KEY)" in
        ""|*YOUR-KEY-HERE*|*your-key-here*)
            if [ -z "$(getvar LLM_ENDPOINT)" ]; then
                echo "warning: no ANTHROPIC_API_KEY (or LLM_* provider) in $vars — the REPL starts, but chat turns will fail until one is set" >&2
            fi ;;
    esac
    # The CLI must present the engine's internal token on /internal/mcp.
    # Bridge it from .dev.vars so this flow needs no manual export; an
    # explicit HABENULA_INTERNAL_MCP_TOKEN in the environment still wins.
    if [ -z "${HABENULA_INTERNAL_MCP_TOKEN:-}" ]; then
        case "$(getvar INTERNAL_MCP_TOKEN)" in
            ""|*your-64-char*) ;;
            *) export HABENULA_INTERNAL_MCP_TOKEN="$(getvar INTERNAL_MCP_TOKEN)" ;;
        esac
    fi
    log="$(mktemp)"
    # Own process group for the engine tree, so the EXIT trap can kill
    # wrangler's children too, not just the `just` wrapper.
    set -m
    (cd packages/engine && exec just dev) >"$log" 2>&1 &
    engine_pid=$!
    set +m
    trap 'kill -- "-$engine_pid" 2>/dev/null || true' EXIT
    # Poll the same base URL the CLI will connect to, not a hardcoded one, so a
    # HABENULA_API_URL override waits on the engine the REPL actually uses.
    # `%/` trims a trailing slash so an override like `http://host:8787/`
    # yields `.../api/health`, not a double-slashed `.../ /api/health`.
    base_url="${HABENULA_API_URL:-http://localhost:8787}"
    health_url="${base_url%/}/api/health"
    for _ in $(seq 1 60); do
        if curl -fsS --max-time 2 "$health_url" >/dev/null 2>&1; then
            # Engine's up — hand off to the interactive CLI in the foreground
            # and make its exit status the recipe's. The EXIT trap tears the
            # engine down either way. errexit is relaxed for the handoff so a
            # non-zero CLI exit is propagated deliberately, not swallowed by
            # `set -e` before we can forward it.
            cd packages/cli
            set +e
            just dev
            exit $?
        fi
        if ! kill -0 "$engine_pid" 2>/dev/null; then
            echo "engine exited during startup — its output:" >&2
            cat "$log" >&2
            exit 1
        fi
        sleep 0.5
    done
    # A failed engine boot (port taken, bad .dev.vars, compile error) must
    # fail loudly, not wedge the recipe. The bound is 60 attempts (~30s of
    # sleeps, longer if the port stalls each 2s curl), not a wall-clock 30s.
    echo "engine did not become healthy after 60 attempts — its output:" >&2
    cat "$log" >&2
    exit 1

# Install git hooks (runs lint + typecheck + tests before every commit) and
# scaffold the local engine config (.dev.vars)
setup:
    bash scripts/install-hooks.sh
    bash scripts/scaffold-dev-vars.sh
    @echo "Development environment ready."

# --- Engine package ---

# Run engine tests
engine-test:
    cd packages/engine && just test

# Run engine tests in watch mode
engine-test-watch:
    cd packages/engine && just test-watch

# Run engine type check
engine-typecheck:
    cd packages/engine && just typecheck

# Run engine linting
engine-lint:
    cd packages/engine && just lint

# Run engine dev server
engine-dev:
    cd packages/engine && just dev

# Regenerate engine Zod row schemas from the DDL registry
engine-codegen:
    cd packages/engine && just codegen

# Build the engine: Worker bundle + module surface + daemon (scripts/build.mjs)
engine-build:
    cd packages/engine && just build

# Run all engine checks
engine-pre-commit:
    cd packages/engine && just pre-commit

# --- CLI package ---

# Run the CLI from source (e.g. `just cli-dev status`)
cli-dev *ARGS:
    cd packages/cli && just dev {{ARGS}}

# Bundle the CLI to dist/index.js (Node bin, #!/usr/bin/env node)
cli-build:
    cd packages/cli && just build

# Run CLI tests
cli-test:
    cd packages/cli && just test

# Run CLI tests in watch mode
cli-test-watch:
    cd packages/cli && just test-watch

# Run CLI type check
cli-typecheck:
    cd packages/cli && just typecheck

# Run CLI linting
cli-lint:
    cd packages/cli && just lint

# Run all CLI checks
cli-pre-commit:
    cd packages/cli && just pre-commit

# --- Contracts package ---

# Run contracts tests (no-op: covered by engine contract test + consumer typechecks)
contracts-test:
    cd packages/contracts && just test

# Run contracts type check
contracts-typecheck:
    cd packages/contracts && just typecheck

# Run contracts linting
contracts-lint:
    cd packages/contracts && just lint

# Emit the contracts published surface (dist/)
contracts-build:
    cd packages/contracts && just build

# Run all contracts checks
contracts-pre-commit:
    cd packages/contracts && just pre-commit

# --- Tools package ---

# Run tools tests
tools-test:
    cd packages/tools && just test

# Run tools tests in watch mode
tools-test-watch:
    cd packages/tools && just test-watch

# Run tools type check
tools-typecheck:
    cd packages/tools && just typecheck

# Run tools linting
tools-lint:
    cd packages/tools && just lint

# Emit the tools published surface (dist/)
tools-build:
    cd packages/tools && just build

# Run all tools checks
tools-pre-commit:
    cd packages/tools && just pre-commit

# --- Credentials package ---

# Run credentials tests
credentials-test:
    cd packages/credentials && just test

# Run credentials tests in watch mode
credentials-test-watch:
    cd packages/credentials && just test-watch

# Run credentials type check
credentials-typecheck:
    cd packages/credentials && just typecheck

# Run credentials linting
credentials-lint:
    cd packages/credentials && just lint

# Emit the credentials published surface (dist/)
credentials-build:
    cd packages/credentials && just build

# Run all credentials checks
credentials-pre-commit:
    cd packages/credentials && just pre-commit

# --- Governance package ---

# Run governance tests
governance-test:
    cd packages/governance && just test

# Run governance tests in watch mode
governance-test-watch:
    cd packages/governance && just test-watch

# Run governance type check
governance-typecheck:
    cd packages/governance && just typecheck

# Run governance linting
governance-lint:
    cd packages/governance && just lint

# Emit the governance published surface (dist/)
governance-build:
    cd packages/governance && just build

# Run all governance checks
governance-pre-commit:
    cd packages/governance && just pre-commit

# --- Audit package ---

# Run audit tests
audit-test:
    cd packages/audit && just test

# Run audit tests in watch mode
audit-test-watch:
    cd packages/audit && just test-watch

# Run audit type check
audit-typecheck:
    cd packages/audit && just typecheck

# Run audit linting
audit-lint:
    cd packages/audit && just lint

# Emit the audit published surface (dist/)
audit-build:
    cd packages/audit && just build

# Run all audit checks
audit-pre-commit:
    cd packages/audit && just pre-commit

# --- Habenula umbrella package (the unscoped npm front door) ---

# Run umbrella forwarder tests (they spawn the built CLI bundle, so build it first)
habenula-test: cli-build
    cd packages/habenula && just test

# Run umbrella type check (no-op: plain-JS forwarder)
habenula-typecheck:
    cd packages/habenula && just typecheck

# Run umbrella linting
habenula-lint:
    cd packages/habenula && just lint

# Run all umbrella checks
habenula-pre-commit: cli-build
    cd packages/habenula && just pre-commit

# --- All packages ---

# --- Published-surface builds ---

# Build the seven buildable OSS packages, leaf-first (the emit order the
# publish path uses). The habenula umbrella has no build step — its one
# plain-JS forwarder ships as-committed.
oss-build: contracts-build credentials-build governance-build audit-build tools-build engine-build cli-build

# The published-shape gate: stage + transform the eight packages, pack each
# once, run publint --strict and attw (declared narrowing only), then the
# wildcard/bin/consumer tarball smoke tests. Validate-only — nothing publishes
oss-verify-tarballs: oss-build
    node .github/scripts/npm-publish.mjs --validate-only
    node .github/scripts/npm-tarball-smoke.mjs

# Verify dependency versions are pinned across all packages
verify-deps:
    node scripts/check-pinned-deps.cjs

# Run all pre-commit checks across all packages (leaf packages first: credentials,
# governance, and audit are leaves the engine consumes, tools depends on
# credentials, and the habenula umbrella spawns the CLI its tests front)
pre-commit: contracts-pre-commit credentials-pre-commit governance-pre-commit audit-pre-commit tools-pre-commit engine-pre-commit cli-pre-commit habenula-pre-commit
    @echo "All pre-commit checks passed."
