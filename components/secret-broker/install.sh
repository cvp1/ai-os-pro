#!/usr/bin/env bash
# Install the ai-os secret broker AND register the /secret skill so your AI-OS
# can actually use it. Override locations with AIOS_HOME / CLAUDE_SKILLS_DIR.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${AIOS_HOME:-$HOME/ai-os}"
SKILLS="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"

# 1. install the broker executable ------------------------------------------------
mkdir -p "$DEST/bin"
install -m 0755 "$HERE/secret" "$DEST/bin/secret"
echo "✓ broker installed:  $DEST/bin/secret"

# 2. register the /secret skill (hot-loadable Claude Code skill) -------------------
mkdir -p "$SKILLS/secret"
if [ -f "$SKILLS/secret/SKILL.md" ] && ! cmp -s "$HERE/skill/SKILL.md" "$SKILLS/secret/SKILL.md"; then
  cp "$SKILLS/secret/SKILL.md" "$SKILLS/secret/SKILL.md.bak"
  echo "  (backed up your existing skill → $SKILLS/secret/SKILL.md.bak)"
fi
install -m 0644 "$HERE/skill/SKILL.md" "$SKILLS/secret/SKILL.md"
echo "✓ skill registered:  $SKILLS/secret/SKILL.md   → /secret"

# 3. add the secrets convention to your AI-OS CLAUDE.md (idempotent, best-effort) --
claude_md=""
for c in "$DEST/CLAUDE.md" "$HOME/.claude/CLAUDE.md"; do
  [ -f "$c" ] && { claude_md="$c"; break; }
done
if [ -n "$claude_md" ]; then
  if grep -q "SECRETS CONVENTION:" "$claude_md"; then
    echo "✓ secrets convention already present in $claude_md"
  else
    { echo; cat "$HERE/convention.txt"; } >> "$claude_md"
    echo "✓ secrets convention added to $claude_md"
  fi
else
  echo "• no AI-OS CLAUDE.md found — the convention is embedded in the skill; to make"
  echo "  it global, paste $HERE/convention.txt into your CLAUDE.md."
fi

# 4. keyring check ---------------------------------------------------------------
if command -v security >/dev/null 2>&1 || command -v secret-tool >/dev/null 2>&1; then
  echo "✓ OS keyring detected — ready to store credentials."
else
  echo "! no OS keyring found (need macOS Keychain, or Linux gnome-keyring +"
  echo "  libsecret-tools for 'secret-tool'). Install one before storing a secret."
fi

cat <<EOF

Next:
  1. Start a FRESH Claude Code session so /secret registers.
  2. Store a credential:  $DEST/bin/secret set secret://<name>
     (or add it in your OS keyring app under service "ai-os", account "<name>")
EOF
