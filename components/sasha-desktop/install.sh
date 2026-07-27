#!/usr/bin/env bash
# Sasha Desktop — build the local window onto your AI-OS. Source build, no binaries yet.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${AIOS_HOME:-$HOME/ai-os}"

echo "Sasha Desktop — a local window onto your AI-OS."
echo

if [ ! -d "$DEST" ]; then
  echo "! No AI-OS install at $DEST."
  echo "  Sasha Desktop is a window onto an existing AI-OS, not a replacement for one."
  echo "  Set up AI-OS first (https://github.com/cvp1/ai-os), then run this again."
  echo "  If your install lives elsewhere, set AIOS_HOME and re-run."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "! node not found. Sasha Desktop needs Node.js 22 or newer." >&2
  exit 1
fi

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 22 ]; then
  echo "! Node $(node -v) found; 22 or newer is required." >&2
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "  note: Claude Code was not found on PATH. Sasha Desktop drives YOUR install —"
  echo "        it does not bundle one and never signs in for you. The doorbell still"
  echo "        works without it; running /doctor from the window will not."
  echo
fi

cd "$HERE"

echo "Installing build dependencies (Electron + TypeScript; zero runtime dependencies)…"
npm install --no-fund --no-audit

echo
echo "Building…"
npm run build

echo
# Build first: the tests import the compiled output, so verifying a clean checkout
# before building it can only fail. (`pretest` now enforces this independently.)
echo "Verifying — security surface, dependency posture, types, and behaviour…"
npm run verify

cat <<EOF

✓ Sasha Desktop is built.

  Start it:      cd $HERE && npm start
  Watching:      $DEST
  Quiet hours:   9pm–5am by default (change from the tray icon)

  It lives in your menu bar / tray. Closing the window does not quit it — that is
  the point: it is a doorbell, and it rings when something is waiting for you.

  What it does NOT do: no account, no gateway, no telemetry, no network calls of
  its own. It reads your AI-OS files and runs your own Claude Code. The only thing
  it ever writes inside $DEST is an aggregate count in .aios-usage.jsonl, and only
  if you already have that file.

EOF
