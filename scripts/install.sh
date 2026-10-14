#!/usr/bin/env bash
# Install harness from this checkout: dependencies, build, and a `harness` command on your PATH.
# HARNESS_BIN_DIR picks where the command goes (default ~/.local/bin).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${HARNESS_BIN_DIR:-$HOME/.local/bin}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "error: $1 is required. $2"; exit 1; }; }
need node "Install Node.js 20.19 or newer: https://nodejs.org"
need git "Install git: https://git-scm.com"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=19)?0:1)' \
  || { echo "error: Node.js 20.19 or newer is required (found $(node --version))"; exit 1; }
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not found; enabling it through corepack"
  corepack enable pnpm
fi

echo "== installing dependencies"
(cd "$ROOT" && pnpm install --frozen-lockfile)
echo "== building"
(cd "$ROOT" && pnpm build)

mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/harness" <<SH
#!/bin/sh
exec node "$ROOT/apps/cli/dist/main.js" "\$@"
SH
chmod +x "$BIN_DIR/harness"
echo "== installed $BIN_DIR/harness ($("$BIN_DIR/harness" --version))"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Add it to your PATH:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
echo "Next: cd your-repo && harness init && harness doctor"
