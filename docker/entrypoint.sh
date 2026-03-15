#!/bin/bash
set -euo pipefail

STATE_DIR="${OPENCLAW_STATE_DIR:-/data/openclaw}"
SHARED_SKILLS="/shared-skills"
CONFIG_SOURCE="/config/openclaw.json"
SKILLS_DIR="$STATE_DIR/agents/main/skills"

# Ensure state directory structure exists
mkdir -p "$STATE_DIR/agents/main/agent" "$SKILLS_DIR"

# Copy base config if not already present (preserves tenant customizations)
if [ ! -f "$STATE_DIR/openclaw.json" ] && [ -f "$CONFIG_SOURCE" ]; then
  cp "$CONFIG_SOURCE" "$STATE_DIR/openclaw.json"
  echo "[opencrane] Initialized config from base template"
fi

# Symlink shared org skills
if [ -d "$SHARED_SKILLS/org" ]; then
  for skill_dir in "$SHARED_SKILLS/org"/*/; do
    skill_name=$(basename "$skill_dir")
    target="$SKILLS_DIR/$skill_name"
    if [ ! -e "$target" ]; then
      ln -sf "$skill_dir" "$target"
    fi
  done
  echo "[opencrane] Linked org skills"
fi

# Symlink shared team skills (OPENCRANE_TEAM env var selects the team)
if [ -n "${OPENCRANE_TEAM:-}" ] && [ -d "$SHARED_SKILLS/teams/$OPENCRANE_TEAM" ]; then
  for skill_dir in "$SHARED_SKILLS/teams/$OPENCRANE_TEAM"/*/; do
    skill_name=$(basename "$skill_dir")
    target="$SKILLS_DIR/$skill_name"
    if [ ! -e "$target" ]; then
      ln -sf "$skill_dir" "$target"
    fi
  done
  echo "[opencrane] Linked team skills for $OPENCRANE_TEAM"
fi

echo "[opencrane] Starting OpenClaw gateway"
exec "$@"
