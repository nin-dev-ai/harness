#!/usr/bin/env bash
# Live demo with one real vendor (Claude Code). SPENDS A LITTLE QUOTA: one small task + one review.
# Usage: pnpm build && bash scripts/live-demo.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/apps/cli/dist/main.js"
[ -f "$CLI" ] || { echo "build first: pnpm build"; exit 1; }
command -v claude >/dev/null || { echo "claude CLI not found"; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/harness-live.XXXXXX")"
export HARNESS_HOME="$WORK/home"
REPO="$WORK/slug"
h() { node "$CLI" --project "$REPO" "$@"; }

mkdir -p "$REPO/src" "$REPO/test" && cd "$REPO"
git init -q -b main && git config user.email demo@example.com && git config user.name demo
printf '{ "name": "slug", "private": true, "type": "module", "scripts": { "test": "node --test test/" } }\n' > package.json
printf 'import { test } from "node:test";\ntest("placeholder", () => {});\n' > test/placeholder.test.js
printf '# AGENTS.md\nPlain ES modules, no dependencies. Run `npm test` before finishing.\n' > AGENTS.md
cat > harness.yaml <<'YAML'
version: 1
project: slug
routes:
  claude-sub: { vendor: claude, auth: subscription }
roles:
  backend:
    route: claude-sub
    paths_allow: ["src/**", "test/**"]
    instructions: "Small, well-tested ES modules."
  reviewer:
    route: claude-sub
    mode: readonly
limits:
  max_task_minutes: 10
YAML
mkdir -p .harness && cat > .harness/checks.yaml <<'YAML'
version: 1
checks:
  - id: unit
    argv: ["npm", "test", "--silent"]
    timeout_s: 120
YAML
git add -A && git commit -qm "sample"

h doctor || true
h task add "Add slugify" --role backend --size S --approve \
  --acceptance "src/slug.js exports slugify(text) that lowercases, trims, and joins words with single dashes" \
  --acceptance "test/slug.test.js covers spaces, punctuation and empty input with node:test" \
  --files "src/slug.js,test/slug.test.js"
h run
printf "== Claude is working"
for _ in $(seq 1 600); do
  state=$(h status --json | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(s.tasks[0].state)')
  case "$state" in MERGED|NEEDS_HUMAN|PR_READY) break ;; esac
  printf "."; sleep 2
done
echo
h status --no-color
h task show T-001 --no-color | sed -n '/Runs/,$p' | head -30
echo "== merged code:"
git show harness/integration:src/slug.js 2>/dev/null || true
h usage --no-color
h stop
echo "== files kept in $WORK"
