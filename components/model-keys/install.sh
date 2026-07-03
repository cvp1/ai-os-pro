#!/usr/bin/env bash
# Register the /ask-model skill (call hosted LLMs via keys in the secret-broker).
# Requires the secret-broker component + stored provider handles.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${AIOS_HOME:-$HOME/ai-os}"
SKILLS="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"

if [ ! -x "$DEST/bin/secret" ]; then
  echo "! secret-broker not installed — run: ./install.sh secret-broker  (this skill needs it)"
fi

mkdir -p "$SKILLS/ask-model"
if [ -f "$SKILLS/ask-model/SKILL.md" ] && ! cmp -s "$HERE/skill/SKILL.md" "$SKILLS/ask-model/SKILL.md"; then
  cp "$SKILLS/ask-model/SKILL.md" "$SKILLS/ask-model/SKILL.md.bak"
  echo "  (backed up existing skill → $SKILLS/ask-model/SKILL.md.bak)"
fi
install -m 0644 "$HERE/skill/SKILL.md" "$SKILLS/ask-model/SKILL.md"
echo "✓ skill registered:  $SKILLS/ask-model/SKILL.md   → /ask-model"

cat <<EOF

Store the provider keys you want (once, no echo):
  $DEST/bin/secret set secret://openrouter
  $DEST/bin/secret set secret://gemini
  $DEST/bin/secret set secret://deepseek
Then start a fresh Claude Code session so /ask-model registers.
EOF
