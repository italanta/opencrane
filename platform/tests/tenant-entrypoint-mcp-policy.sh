#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
STATE_DIR="$TMP_DIR/state"
SHARED_DIR="$TMP_DIR/shared-skills"
CONFIG_DIR="$TMP_DIR/config"

function _cleanup()
{
  rm -rf "$TMP_DIR"
}

function _assert_equals()
{
  local actual="$1"
  local expected="$2"
  local message="$3"

  if [[ "$actual" != "$expected" ]]; then
    echo "[tenant-entrypoint] $message"
    echo "[tenant-entrypoint] Expected: $expected"
    echo "[tenant-entrypoint] Actual:   $actual"
    exit 1
  fi
}

trap _cleanup EXIT

# 1. Fixture setup — create an isolated tenant runtime filesystem so the test can
#    exercise the entrypoint without mutating any real workspace state.
mkdir -p \
  "$STATE_DIR/runtime/node_modules/.bin" \
  "$STATE_DIR/agents/main/skills" \
  "$SHARED_DIR/org/company-policy" \
  "$SHARED_DIR/teams/engineering/deploy-helper" \
  "$CONFIG_DIR"
printf '#!/bin/sh\necho mocked openclaw\n' > "$STATE_DIR/runtime/node_modules/.bin/openclaw"
chmod +x "$STATE_DIR/runtime/node_modules/.bin/openclaw"
printf '{}' > "$CONFIG_DIR/openclaw.json"
cat > "$CONFIG_DIR/opencrane-managed-runtime.json" <<'EOF'
{
  "policy": {
    "mcpServers": {
      "allow": ["other-server"],
      "deny": ["skills"]
    }
  },
  "capabilities": {
    "mcpPolicyEnforced": true
  }
}
EOF

# 2. Runtime contract load — source the tenant entrypoint helpers and load the
#    managed-runtime contract so the MCP policy becomes shell-visible state.
export OPENCLAW_STATE_DIR="$STATE_DIR"
export OPENCRANE_SHARED_SKILLS_DIR="$SHARED_DIR"
export OPENCRANE_CONFIG_SOURCE_PATH="$CONFIG_DIR/openclaw.json"
export OPENCRANE_RUNTIME_CONTRACT_PATH="$CONFIG_DIR/opencrane-managed-runtime.json"
export OPENCRANE_TEAM="engineering"
source "$ROOT_DIR/apps/tenant/deploy/entrypoint.sh"
set +e
_load_mcp_policy
_mcp_server_is_enabled "skills"
MCP_STATUS="$?"
ORG_OUTPUT="$(_link_shared_skills "$OPENCRANE_SHARED_SKILLS_DIR/org" ok blocked)"
TEAM_OUTPUT="$(_link_shared_skills "$OPENCRANE_SHARED_SKILLS_DIR/teams/$OPENCRANE_TEAM" ok-team blocked-team)"
LINK_COUNT="$(find "$OPENCLAW_STATE_DIR/agents/main/skills" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')"
set -e

# 3. Enforcement assertions — confirm a denied MCP server prevents shared skill
#    linking so tenant runtime behavior now follows the resolved AccessPolicy.
_assert_equals "$OPENCRANE_ALLOWED_MCP_SERVERS" "other-server" "Managed runtime contract allowlist was not loaded"
_assert_equals "$OPENCRANE_DENIED_MCP_SERVERS" "skills" "Managed runtime contract denylist was not loaded"
_assert_equals "$OPENCRANE_MCP_POLICY_ENFORCED" "true" "Managed runtime contract enforcement flag was not loaded"
_assert_equals "$MCP_STATUS" "1" "skills MCP server should be blocked by policy"
_assert_equals "$ORG_OUTPUT" "blocked" "org skills should not be linked when skills MCP server is denied"
_assert_equals "$TEAM_OUTPUT" "blocked-team" "team skills should not be linked when skills MCP server is denied"
_assert_equals "$LINK_COUNT" "0" "no shared skills should be linked when skills MCP server is denied"

echo "[tenant-entrypoint] PASS: managed runtime MCP policy blocks shared skill linking"
