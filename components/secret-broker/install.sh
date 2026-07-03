#!/usr/bin/env bash
# Install the ai-os secret broker into ~/ai-os/bin/secret (override dir with AIOS_HOME).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${AIOS_HOME:-$HOME/ai-os}"

mkdir -p "$DEST/bin"
install -m 0755 "$HERE/secret" "$DEST/bin/secret"
echo "installed: $DEST/bin/secret"

if command -v security >/dev/null 2>&1 || command -v secret-tool >/dev/null 2>&1; then
  echo "OS keyring detected — ready to store credentials."
else
  echo "WARNING: no OS keyring found (need macOS Keychain, or on Linux:"
  echo "  gnome-keyring + libsecret-tools for the 'secret-tool' command)."
  echo "  Install one before storing a secret — the headless fallback is not in this build."
fi

echo
echo "Store a credential:   $DEST/bin/secret set secret://<name>"
echo "Skill fragment:       $HERE/skill/secret.md   (add to your AI-OS build)"
echo "Convention line:      $HERE/convention.txt"
