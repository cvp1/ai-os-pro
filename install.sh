#!/usr/bin/env bash
# AI-OS Pro — install native components into ~/ai-os (override with AIOS_HOME).
# Usage: ./install.sh [component ...]   (default: all)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
components=("$@")
if [ ${#components[@]} -eq 0 ]; then
  components=(secret-broker)
fi

for c in "${components[@]}"; do
  script="$HERE/components/$c/install.sh"
  if [ ! -x "$script" ]; then
    echo "unknown component: $c" >&2
    exit 1
  fi
  echo "=== $c ==="
  "$script"
  echo
done

echo "Done. AI-OS Pro components installed into ${AIOS_HOME:-$HOME/ai-os}."
