#!/bin/bash
set -euo pipefail

STATE_DIR="${OPENCLAW_STATE_DIR:-/data/openclaw}"
RUNTIME_DIR="$STATE_DIR/runtime"
SECRETS_DIR="${OPENCLAW_SECRETS_DIR:-/data/secrets}"
SHARED_SKILLS="/shared-skills"
CONFIG_SOURCE="/config/openclaw.json"
SKILLS_DIR="$STATE_DIR/agents/main/skills"
OPENCLAW_VERSION="${OPENCLAW_VERSION:-latest}"

function _skill_is_enabled()
{
  local skill_name="$1"

  if [ "${OPENCRANE_ALLOWED_SKILLS+set}" != "set" ]; then
    return 0
  fi

  case ",${OPENCRANE_ALLOWED_SKILLS}," in
    *",${skill_name},"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Ensure GCS-backed directory structure
mkdir -p "$STATE_DIR/agents/main/agent" "$SKILLS_DIR" \
         "$STATE_DIR/sessions" "$STATE_DIR/uploads" "$STATE_DIR/knowledge" \
         "$RUNTIME_DIR"

# Ensure pod-local secrets dir (emptyDir, Memory-backed)
mkdir -p "$SECRETS_DIR"

# Ensure temporary writable paths exist when the root filesystem is read-only.
mkdir -p /tmp/opencrane-home /tmp/npm-cache

# Install or verify OpenClaw runtime on persistent storage
OPENCLAW_BIN="$RUNTIME_DIR/node_modules/.bin/openclaw"
if [ ! -x "$OPENCLAW_BIN" ]; then
  echo "[opencrane] Installing OpenClaw@${OPENCLAW_VERSION} to persistent storage..."
  npm install --prefix "$RUNTIME_DIR" "openclaw@${OPENCLAW_VERSION}" --omit=dev
  echo "[opencrane] OpenClaw installed successfully"
else
  echo "[opencrane] OpenClaw runtime found at $OPENCLAW_BIN"
fi

# Add runtime bin to PATH
export PATH="$RUNTIME_DIR/node_modules/.bin:$PATH"

# Copy base config if not already present (preserves tenant customizations)
if [ ! -f "$STATE_DIR/openclaw.json" ] && [ -f "$CONFIG_SOURCE" ]; then
  cp "$CONFIG_SOURCE" "$STATE_DIR/openclaw.json"
  echo "[opencrane] Initialized config from base template"
fi

# Symlink shared org skills
if [ -d "$SHARED_SKILLS/org" ]; then
  for skill_dir in "$SHARED_SKILLS/org"/*/; do
    skill_name=$(basename "$skill_dir")
    if ! _skill_is_enabled "$skill_name"; then
      continue
    fi
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
    if ! _skill_is_enabled "$skill_name"; then
      continue
    fi
    target="$SKILLS_DIR/$skill_name"
    if [ ! -e "$target" ]; then
      ln -sf "$skill_dir" "$target"
    fi
  done
  echo "[opencrane] Linked team skills for $OPENCRANE_TEAM"
fi

echo "[opencrane] Starting OpenClaw gateway"
exec openclaw gateway run --bind lan --port "${OPENCLAW_GATEWAY_PORT:-18789}"
