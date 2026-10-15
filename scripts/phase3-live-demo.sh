#!/usr/bin/env bash
# Opt-in live check: one tiny task on each signed-in subscription route.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/apps/cli/dist/main.js"
[ -f "$CLI" ] || { echo "Run pnpm build first"; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/harness-phase3-live.XXXXXX")"
export HARNESS_HOME="$WORK/home"
REPO="$WORK/project"
h() { node "$CLI" --project "$REPO" "$@"; }
finish() { h stop >/dev/null 2>&1 || true; echo "Live evidence: $WORK"; }
trap finish EXIT

mkdir -p "$REPO/src" "$REPO/.harness"
cd "$REPO"
git init -q -b main
git config user.name "Harness live check"
git config user.email "harness-live@example.invalid"
printf '# Three subscription route check\n' > README.md
cat > harness.yaml <<'YAML'
version: 1
project: phase3-live
base_branch: main
land: auto
routes:
  claude-sub: { vendor: claude, auth: subscription }
  codex-sub: { vendor: codex, auth: subscription }
  cursor-sub: { vendor: cursor, auth: subscription }
roles:
  claude-job: { route: claude-sub, pool: [codex-sub, cursor-sub], paths_allow: ["src/claude.mjs"] }
  codex-job: { route: codex-sub, paths_allow: ["src/codex.mjs"] }
  cursor-job: { route: cursor-sub, paths_allow: ["src/cursor.mjs"] }
limits:
  max_parallel_workers: 3
  max_task_minutes: 5
  review_sizes: [M, L]
policy:
  autonomy: approved-scope
  unattended: { claude-sub: allow, codex-sub: allow, cursor-sub: allow }
YAML
cat > .harness/checks.yaml <<'YAML'
version: 1
checks:
  - id: source
    argv: ["node", "-e", "const fs=require('fs'); for(const f of fs.readdirSync('src')) if(f.endsWith('.mjs') && !fs.readFileSync('src/'+f,'utf8').includes('export const route')) process.exit(1)"]
YAML
git add -A
git commit -qm 'live fixture'

h task add 'Create src/claude.mjs with exactly export const route = "claude";' --role claude-job --size S --files src/claude.mjs --acceptance 'src/claude.mjs exports route as the string claude' --approve
h task add 'Create src/codex.mjs with exactly export const route = "codex";' --role codex-job --size S --files src/codex.mjs --acceptance 'src/codex.mjs exports route as the string codex' --approve
h task add 'Create src/cursor.mjs with exactly export const route = "cursor";' --role cursor-job --size S --files src/cursor.mjs --acceptance 'src/cursor.mjs exports route as the string cursor' --approve
h run

deadline=$((SECONDS + 300))
while (( SECONDS < deadline )); do
  status="$(h status --json)"
  verdict="$(printf '%s' "$status" | node -e 'let x="";process.stdin.on("data",c=>x+=c).on("end",()=>{const t=JSON.parse(x).tasks;console.log(t.map(v=>`${v.id}:${v.state}:${v.delivery??"-"}`).join(" "))})')"
  echo "$verdict"
  if [[ "$verdict" == *"NEEDS_HUMAN"* || "$verdict" == *"blocked"* ]]; then
    echo "$status"
    exit 1
  fi
  if [[ "$verdict" == *"T-001:MERGED:delivered"* && "$verdict" == *"T-002:MERGED:delivered"* && "$verdict" == *"T-003:MERGED:delivered"* ]]; then
    break
  fi
  sleep 3
done

if [[ "$verdict" != *"T-001:MERGED:delivered"* || "$verdict" != *"T-002:MERGED:delivered"* || "$verdict" != *"T-003:MERGED:delivered"* ]]; then
  echo "Live check did not deliver all tasks before the deadline."
  exit 1
fi

for vendor in claude codex cursor; do
  test "$(git show "main:src/$vendor.mjs")" = "export const route = \"$vendor\";"
done
test "$(git rev-list --count main..harness/integration)" = "0"
h status --json > "$WORK/status.json"
echo "All three requested files were verified and delivered to main. Inspect task runs to see any route failover."
