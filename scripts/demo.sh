#!/usr/bin/env bash
# End-to-end demo with the fake agents: plan a PRD, approve, run, watch it merge.
# Spends no vendor quota. Usage: pnpm build && pnpm demo
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/apps/cli/dist/main.js"
[ -f "$CLI" ] || { echo "build first: pnpm build"; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/harness-demo.XXXXXX")"
export HARNESS_HOME="$WORK/home"
export HARNESS_FAKE_SCRIPTS="$WORK/scripts.json"
REPO="$WORK/quotes"
h() { node "$CLI" --project "$REPO" "$@"; }

echo "== sample repo: $REPO"
mkdir -p "$REPO/src/server" "$REPO/src/ui" "$REPO/test" "$REPO/docs"
cd "$REPO"
git init -q -b main
git config user.email demo@example.com
git config user.name demo
cat > package.json <<'JSON'
{ "name": "quotes", "private": true, "type": "module", "scripts": { "test": "node --test test/" } }
JSON
cat > test/smoke.test.js <<'JS'
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
test("every quote module exports something", async () => {
  for (const f of ["src/server", "src/ui"].flatMap((d) => (fs.existsSync(d) ? fs.readdirSync(d).map((x) => `${d}/${x}`) : []))) {
    const m = await import(`../${f}`);
    assert.ok(Object.keys(m).length > 0, f);
  }
});
JS
cat > docs/prd.md <<'MD'
# Live quotes
Show a watchlist of symbols with live prices. The backend adapts a quote feed;
the frontend renders a panel. Both agree on a Quote type.
MD
printf '# AGENTS.md\nRun `npm test` before you finish.\n' > AGENTS.md
git add -A && git commit -qm "sample app"

echo "== harness init"
h init --no-baseline >/dev/null
cat > harness.yaml <<'YAML'
version: 1
project: quotes
routes:
  planner-route: { vendor: fake, auth: api_key }
  backend-route: { vendor: fake, auth: api_key }
  frontend-route: { vendor: fake, auth: api_key }
  review-route: { vendor: fake, auth: api_key }
roles:
  planner: { route: planner-route, mode: readonly }
  backend: { route: backend-route, paths_allow: ["src/server/**", "docs/contracts/**"] }
  frontend: { route: frontend-route, paths_allow: ["src/ui/**"] }
  reviewer: { route: review-route, mode: readonly, independent_of: [backend, frontend] }
limits:
  routes:
    review-route: { manual_budget: { unit: runs, per: day, amount: 40 } }
YAML
cat > .harness/checks.yaml <<'YAML'
version: 1
checks:
  - id: unit
    argv: ["npm", "test", "--silent"]
    timeout_s: 120
YAML
git add -A && git commit -qm "harness config"

# What the fake agents do (a real run would use claude, codex or cursor).
cat > "$HARNESS_FAKE_SCRIPTS" <<'JSON'
{
  "PLAN": { "steps": [ { "kind": "message", "text": "Reading the PRD" }, { "kind": "result", "ok": true, "summary": "plan", "structured": {
    "summary": "Contract first, then the adapter and the panel in parallel.",
    "tasks": [
      { "key": "contract", "title": "Quote contract", "role": "backend", "size": "S", "depends_on": [], "acceptance": ["Quote type exported"], "files_hint": ["docs/contracts/quote.js"], "contract_ref": null, "description": "Define the Quote shape both sides use." },
      { "key": "feed", "title": "Quote feed adapter", "role": "backend", "size": "M", "depends_on": ["contract"], "acceptance": ["exports latestQuote()"], "files_hint": ["src/server/feed.js"], "contract_ref": "docs/contracts/quote.js", "description": "Adapt the quote feed." },
      { "key": "panel", "title": "Watchlist panel", "role": "frontend", "size": "M", "depends_on": ["contract"], "acceptance": ["exports renderWatchlist()"], "files_hint": ["src/ui/watchlist.js"], "contract_ref": "docs/contracts/quote.js", "description": "Render the watchlist." }
    ] } } ] },
  "T-001": { "steps": [ { "kind": "message", "text": "Writing the contract" }, { "kind": "file_change", "path": "docs/contracts/quote.js", "content": "export const QUOTE_FIELDS = [\"symbol\", \"price\", \"ts\"];\n" }, { "kind": "result", "ok": true, "summary": "Contract written" } ] },
  "T-002": { "sessionId": "feed-1",
    "steps": [ { "kind": "message", "text": "Writing the adapter" }, { "kind": "file_change", "path": "src/server/feed.js", "content": "export const feed = (() => { throw new Error(\"FEED_URL is not configured\"); })();\n" }, { "kind": "result", "ok": true, "summary": "Done, tests pass" } ],
    "resumeSteps": [ { "kind": "message", "text": "Fixing the failing check" }, { "kind": "file_change", "path": "src/server/feed.js", "content": "export function latestQuote(symbol = \"ACME\") { return { symbol, price: 101.5, ts: Date.now() }; }\n" }, { "kind": "result", "ok": true, "summary": "Fixed" } ] },
  "T-003": { "steps": [ { "kind": "message", "text": "Rendering the panel" }, { "kind": "file_change", "path": "src/ui/watchlist.js", "content": "export function renderWatchlist(qs) { return qs.map((q) => `${q.symbol} ${q.price}`).join(\"\\n\"); }\n" }, { "kind": "result", "ok": true, "summary": "Panel done" } ] },
  "review": { "steps": [ { "kind": "result", "ok": true, "summary": "reviewed", "structured": { "summary": "Looks good.", "findings": [ { "severity": "nit", "file": null, "line": null, "message": "Consider naming constants." } ] } } ] }
}
JSON

echo "== harness plan docs/prd.md"
h plan docs/prd.md
echo "== harness approve --all && harness run"
h approve --all
h run

printf "== waiting for the team"
for _ in $(seq 1 120); do
  if h status --json | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); process.exit(s.tasks.every(t=>["MERGED","NEEDS_HUMAN"].includes(t.state))?0:1)'; then break; fi
  printf "."; sleep 1
done
echo
h status --no-color
echo "== the adapter failed its first gate (the agent said it passed) and was repaired by resuming its session:"
h task show T-002 --no-color | sed -n '/Runs/,/History/p' | head -12
echo "== integration branch (main is untouched):"
git log --oneline main..harness/integration
echo "== harness review T-003"
h review T-003 --no-color | head -20
echo "== harness pr --dry-run (no push)"
h pr --dry-run | head -24
h stop
echo "== demo files kept in $WORK"
