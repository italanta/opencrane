#!/bin/bash
set -euo pipefail

STATE_DIR="${OPENCLAW_STATE_DIR:-/data/openclaw}"
RUNTIME_DIR="$STATE_DIR/runtime"
SECRETS_DIR="${OPENCLAW_SECRETS_DIR:-/data/secrets}"
SHARED_SKILLS="${OPENCRANE_SHARED_SKILLS_DIR:-/shared-skills}"
CONFIG_SOURCE="${OPENCRANE_CONFIG_SOURCE_PATH:-/config/openclaw.json}"
RUNTIME_CONTRACT_PATH="${OPENCRANE_RUNTIME_CONTRACT_PATH:-/config/opencrane-managed-runtime.json}"
SKILLS_DIR="$STATE_DIR/agents/main/skills"
OPENCLAW_VERSION="${OPENCLAW_VERSION:-latest}"
OPENCRANE_ALLOWED_MCP_SERVERS="${OPENCRANE_ALLOWED_MCP_SERVERS:-}"
OPENCRANE_DENIED_MCP_SERVERS="${OPENCRANE_DENIED_MCP_SERVERS:-}"
OPENCRANE_MCP_POLICY_ENFORCED="${OPENCRANE_MCP_POLICY_ENFORCED:-false}"

function _csv_contains()
{
  local values="$1"
  local candidate="$2"

  case ",${values}," in
    *",${candidate},"*) return 0 ;;
    *) return 1 ;;
  esac
}

function _load_mcp_policy()
{
  local policy_env

  if [ ! -f "$RUNTIME_CONTRACT_PATH" ]; then
    return 0
  fi

  if ! policy_env=$(node - "$RUNTIME_CONTRACT_PATH" <<'EOF'
const fs = require("node:fs");

const contractPath = process.argv[2];
const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
const policy = contract?.policy?.mcpServers;
const allow = Array.isArray(policy?.allow) ? policy.allow.join(",") : "";
const deny = Array.isArray(policy?.deny) ? policy.deny.join(",") : "";
const enforced = contract?.capabilities?.mcpPolicyEnforced === true || policy !== undefined;

process.stdout.write(`OPENCRANE_ALLOWED_MCP_SERVERS=${allow}\n`);
process.stdout.write(`OPENCRANE_DENIED_MCP_SERVERS=${deny}\n`);
process.stdout.write(`OPENCRANE_MCP_POLICY_ENFORCED=${enforced ? "true" : "false"}\n`);
EOF
  ); then
    echo "[opencrane] Failed to parse managed runtime contract at $RUNTIME_CONTRACT_PATH; continuing without MCP policy enforcement" >&2
    return 0
  fi

  while IFS='=' read -r key value; do
    case "$key" in
      OPENCRANE_ALLOWED_MCP_SERVERS)
        OPENCRANE_ALLOWED_MCP_SERVERS="$value"
        ;;
      OPENCRANE_DENIED_MCP_SERVERS)
        OPENCRANE_DENIED_MCP_SERVERS="$value"
        ;;
      OPENCRANE_MCP_POLICY_ENFORCED)
        OPENCRANE_MCP_POLICY_ENFORCED="$value"
        ;;
    esac
  done <<< "$policy_env"
}

function _mcp_server_is_enabled()
{
  local server_name="$1"

  if [ "$OPENCRANE_MCP_POLICY_ENFORCED" != "true" ]; then
    return 0
  fi

  if [ -n "$OPENCRANE_DENIED_MCP_SERVERS" ] && _csv_contains "$OPENCRANE_DENIED_MCP_SERVERS" "$server_name"; then
    return 1
  fi

  if [ -n "$OPENCRANE_ALLOWED_MCP_SERVERS" ] && ! _csv_contains "$OPENCRANE_ALLOWED_MCP_SERVERS" "$server_name"; then
    return 1
  fi

  return 0
}

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

function _link_shared_skills()
{
  local source_dir="$1"
  local success_message="$2"
  local block_message="$3"
  local skill_dir
  local skill_name
  local target

  if ! _mcp_server_is_enabled "skills"; then
    echo "$block_message"
    return 0
  fi

  if [ ! -d "$source_dir" ]; then
    return 0
  fi

  for skill_dir in "$source_dir"/*/; do
    skill_name=$(basename "$skill_dir")
    if ! _skill_is_enabled "$skill_name"; then
      continue
    fi
    target="$SKILLS_DIR/$skill_name"
    if [ ! -e "$target" ]; then
      ln -sf "$skill_dir" "$target"
    fi
  done

  echo "$success_message"
}

function _main()
{
  _load_mcp_policy

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
  _link_shared_skills \
    "$SHARED_SKILLS/org" \
    "[opencrane] Linked org skills" \
    "[opencrane] Skipping org skills; MCP policy blocks the 'skills' server"

  # Symlink shared team skills (OPENCRANE_TEAM env var selects the team)
  if [ -n "${OPENCRANE_TEAM:-}" ]; then
    _link_shared_skills \
      "$SHARED_SKILLS/teams/$OPENCRANE_TEAM" \
      "[opencrane] Linked team skills for $OPENCRANE_TEAM" \
      "[opencrane] Skipping team skills for $OPENCRANE_TEAM; MCP policy blocks the 'skills' server"
  fi

  echo "[opencrane] Starting OpenClaw gateway"
  exec openclaw gateway run --bind lan --port "${OPENCLAW_GATEWAY_PORT:-18789}"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  _main "$@"
fi
