#!/usr/bin/env bash
# Live team demo: real Claude Code (and Codex if signed in) on a throwaway repo.
# SPENDS A LITTLE QUOTA: one or two small tasks plus one lead check.
# Shows: routing without tags, parallel agents, the team board, the lead, and land.
# Usage: pnpm build && bash scripts/live-team.sh ["message to the team"]
#   default: a one-agent server task. Try a cross-agent one to see the planner split it and agents run in parallel:
#   bash scripts/live-team.sh "Add server/cart.js with cartTotal(items) in cents, and web/cart.js with renderCart(items) returning an HTML string that shows the total via formatPrice-style dollars; tests for both in test/"
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/apps/cli/dist/main.js"
[ -f "$CLI" ] || { echo "build first: pnpm build"; exit 1; }
command -v claude >/dev/null || { echo "claude CLI not found"; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/harness-team.XXXXXX")"
export HARNESS_HOME="$WORK/home"
REPO="$WORK/shop"
h() { node "$CLI" --project "$REPO" "$@"; }

FRONT_ROUTE=claude-sub
if command -v codex >/dev/null && codex login status >/dev/null 2>&1; then FRONT_ROUTE=codex-sub; fi

mkdir -p "$REPO/server" "$REPO/web" "$REPO/test" && cd "$REPO"
git init -q -b main && git config user.email demo@example.com && git config user.name demo
printf '{ "name": "shop", "private": true, "type": "module", "scripts": { "test": "node --test test/" } }\n' > package.json
printf 'import { test } from "node:test";\ntest("placeholder", () => {});\n' > test/placeholder.test.js
printf '# AGENTS.md\nPlain ES modules, no dependencies. server/ is backend, web/ is frontend. Tests in test/ use node:test. Run `npm test` before finishing.\n' > AGENTS.md
cat > harness.yaml <<YAML
version: 1
project: shop
routes:
  claude-sub: { vendor: claude, auth: subscription }
  codex-sub: { vendor: codex, auth: subscription }
roles:
  backend:
    route: claude-sub
    paths_allow: ["server/**", "test/**"]
  frontend:
    route: $FRONT_ROUTE
    paths_allow: ["web/**", "test/**"]
  planner:
    route: claude-sub
    mode: readonly
  lead:
    route: claude-sub
    mode: readonly
limits:
  max_task_minutes: 10
  lead_rounds: 1
policy:
  unattended: { claude-sub: allow, codex-sub: allow }
YAML
mkdir -p .harness && cat > .harness/checks.yaml <<'YAML'
version: 1
checks:
  - id: unit
    argv: ["npm", "test", "--silent"]
    timeout_s: 120
YAML
git add -A && git commit -qm "sample shop"

echo "== frontend runs on $FRONT_ROUTE"
MESSAGE="${1:-Add server/price.js exporting formatPrice(cents) that returns a string like \$12.50, with a node:test test in test/price.test.js}"
h tell "$MESSAGE"
h run >/dev/null
printf "== agents are working"
for _ in $(seq 1 450); do
  done_all=$(h status --json | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(s.tasks.length>0 && s.tasks.every(t=>["MERGED","NEEDS_HUMAN","CANCELLED"].includes(t.state)) ? 1 : 0)')
  [ "$done_all" = 1 ] && break
  printf "."; sleep 2
done
echo
sleep 20   # give the lead its turn
h status --no-color | sed -n '/TASKS/,$p'
echo "== timeline"
h export --no-color 2>/dev/null | node -e 'const l=require("fs").readFileSync(0,"utf8").trim().split("\n").map(JSON.parse).filter(e=>e.kind==="event"&&["run.started","run.finished","branch.merged","lead.reported"].includes(e.type)); for (const e of l) console.log(e.ts.slice(11,19), e.type, e.taskId??"", e.workerId??"", e.payload?.route??"")' || true
echo "== board"
h board --no-color
echo "== land"
h land --no-color || true
git log --oneline -5
h stop >/dev/null
echo "== files kept in $WORK"
