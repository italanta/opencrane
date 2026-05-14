#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

function _usage()
{
  cat <<'EOF'
OpenCrane Phase 1 installer

Usage:
  ./platform/install.sh local [--keep-cluster] [--cluster-name NAME] [--namespace NS] [--profile PROFILE]
  ./platform/install.sh gcp [--project-id ID] [--region REGION] [--domain DOMAIN] [--environment ENV] [--yes]

Examples:
  ./platform/install.sh local --keep-cluster
  ./platform/install.sh local --profile strict
  ./platform/install.sh gcp --project-id my-gcp-project --domain opencrane.example.com --yes

Notes:
  - local mode uses k3d + Helm full-stack install and keeps cluster by default.
  - local profiles: `default` (fast dev) and `strict` (prod-like validation + explicit LiteLLM secret flow).
  - gcp mode delegates to ./platform/deploy.sh (interactive unless --yes with all required flags).
EOF
}

function _require_cmd()
{
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[install] Missing required command: $cmd"
    exit 1
  fi
}

function _run_interactive_setup()
{
  local mode_choice=""
  local mode=""

  echo "[install] No mode provided. Starting interactive setup."
  echo "[install] Choose install target:"
  echo "  1) local (k3d)"
  echo "  2) gcp (Google Cloud)"
  read -rp "[install] Select mode [1/2, default 1]: " mode_choice
  mode_choice="${mode_choice:-1}"

  case "$mode_choice" in
    1)
      mode="local"
      ;;
    2)
      mode="gcp"
      ;;
    *)
      echo "[install] Invalid choice: $mode_choice"
      exit 1
      ;;
  esac

  if [[ "$mode" == "local" ]]; then
    local cluster_name="opencrane-local"
    local namespace="opencrane-system"
    local profile="default"
    local keep_input="Y"
    local keep_flag="--keep-cluster"

    read -rp "[install] Cluster name [opencrane-local]: " cluster_name
    cluster_name="${cluster_name:-opencrane-local}"
    read -rp "[install] Namespace [opencrane-system]: " namespace
    namespace="${namespace:-opencrane-system}"
    read -rp "[install] Local profile [default/strict, default default]: " profile
    profile="${profile:-default}"
    read -rp "[install] Keep cluster after install? [Y/n]: " keep_input
    keep_input="${keep_input:-Y}"
    if [[ ! "$keep_input" =~ ^[Yy]$ ]]; then
      keep_flag="--destroy-cluster"
    fi

    _run_local "$keep_flag" --cluster-name "$cluster_name" --namespace "$namespace" --profile "$profile"
    return
  fi

  local project_id=""
  local region="europe-west1"
  local domain=""
  local environment="dev"

  # Only ask for GCP details when cloud mode is selected.
  read -rp "[install] GCP Project ID: " project_id
  read -rp "[install] Region [europe-west1]: " region
  region="${region:-europe-west1}"
  read -rp "[install] Base domain (e.g. opencrane.example.com): " domain
  read -rp "[install] Environment [dev]: " environment
  environment="${environment:-dev}"

  if [[ -z "$project_id" || -z "$domain" ]]; then
    echo "[install] GCP Project ID and domain are required for cloud mode."
    exit 1
  fi

  _run_gcp --project-id "$project_id" --region "$region" --domain "$domain" --environment "$environment" --yes
}

function _run_local()
{
  local keep_cluster="1"
  local cluster_name="opencrane-local"
  local namespace="opencrane-system"
  local profile="${LOCAL_PROFILE:-default}"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --keep-cluster)
        keep_cluster="1"
        shift
        ;;
      --destroy-cluster)
        keep_cluster="0"
        shift
        ;;
      --cluster-name)
        cluster_name="$2"
        shift 2
        ;;
      --namespace)
        namespace="$2"
        shift 2
        ;;
      --profile)
        profile="$2"
        shift 2
        ;;
      -h|--help)
        _usage
        exit 0
        ;;
      *)
        echo "[install] Unknown local option: $1"
        _usage
        exit 1
        ;;
    esac
  done

  _require_cmd docker
  _require_cmd kubectl
  _require_cmd helm
  _require_cmd k3d

  echo "[install] Running local full-stack install on k3d..."
  KEEP_CLUSTER="$keep_cluster" CLUSTER_NAME="$cluster_name" NAMESPACE="$namespace" LOCAL_PROFILE="$profile" "$ROOT_DIR/platform/tests/k3d-local.sh"
  echo "[install] Local install complete."
  echo "[install] Cluster: $cluster_name, Namespace: $namespace, Profile: $profile"
}

function _run_gcp()
{
  local project_id=""
  local region=""
  local domain=""
  local environment=""
  local auto_yes="0"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project-id)
        project_id="$2"
        shift 2
        ;;
      --region)
        region="$2"
        shift 2
        ;;
      --domain)
        domain="$2"
        shift 2
        ;;
      --environment)
        environment="$2"
        shift 2
        ;;
      --yes)
        auto_yes="1"
        shift
        ;;
      -h|--help)
        _usage
        exit 0
        ;;
      *)
        echo "[install] Unknown gcp option: $1"
        _usage
        exit 1
        ;;
    esac
  done

  # Default to interactive deploy script if required values are not provided.
  if [[ -z "$project_id" || -z "$domain" ]]; then
    echo "[install] Running interactive GCP deploy..."
    "$ROOT_DIR/platform/deploy.sh"
    return
  fi

  region="${region:-europe-west1}"
  environment="${environment:-dev}"

  if [[ "$auto_yes" != "1" ]]; then
    echo "[install] Missing --yes for non-interactive run."
    echo "[install] Re-run with --yes or use interactive mode (omit --project-id/--domain)."
    exit 1
  fi

  _require_cmd gcloud
  _require_cmd terraform
  _require_cmd docker
  _require_cmd pnpm

  echo "[install] Running non-interactive GCP deploy..."
  printf "%s\n%s\n%s\n%s\nY\n" "$project_id" "$region" "$domain" "$environment" | "$ROOT_DIR/platform/deploy.sh"
}

if [[ $# -lt 1 ]]; then
  _run_interactive_setup
  exit 0
fi

mode="$1"
shift

case "$mode" in
  local)
    _run_local "$@"
    ;;
  gcp)
    _run_gcp "$@"
    ;;
  -h|--help)
    _usage
    ;;
  *)
    echo "[install] Unknown mode: $mode"
    _usage
    exit 1
    ;;
esac
