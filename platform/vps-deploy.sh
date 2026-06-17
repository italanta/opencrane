#!/usr/bin/env bash
# =============================================================================
# OpenCrane — single machine (VM / VPS) deploy
#
# Stands up a one-node Kubernetes cluster on THIS Linux host using k3s, then
# installs OpenCrane onto it. Ideal for a VM, a VPS, or a single server.
#
# Usage:
#   sudo ./platform/vps-deploy.sh [--domain DOMAIN]
#
# Prereqs: a Linux host with curl + helm (this script installs k3s for you).
# For laptop/dev on macOS or Windows, use ./platform/install.sh local (k3d).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAIN=""
PASSTHROUGH=()

log()  { echo -e "\033[0;32m[vps-deploy]\033[0m $1"; }
err()  { echo -e "\033[0;31m[vps-deploy]\033[0m $1" >&2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) PASSTHROUGH+=("$1"); shift ;;
  esac
done

[[ "$(uname -s)" == "Linux" ]] || { err "k3s needs Linux. On a laptop use ./platform/install.sh local (k3d)."; exit 1; }
command -v helm >/dev/null 2>&1 || { err "Missing required command: helm (https://helm.sh/docs/intro/install/)"; exit 1; }

# 1. Install k3s (idempotent — skips if already present) → a one-node cluster.
if ! command -v k3s >/dev/null 2>&1; then
  log "Installing k3s…"
  curl -sfL https://get.k3s.io | sh -
fi
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
if [[ ! -r "$KUBECONFIG" ]]; then
  log "Waiting for $KUBECONFIG to be created and readable..."
  for i in {1..30}; do
    if [[ -r "$KUBECONFIG" ]]; then
      break
    fi
    sleep 2
  done
fi
[[ -r "$KUBECONFIG" ]] || { err "Cannot read $KUBECONFIG (run with sudo, or set KUBECONFIG)."; exit 1; }

log "Cluster ready. Installing OpenCrane…"
# k3s ships the 'local-path' default StorageClass and a Traefik ingress out of the box.
exec "$SCRIPT_DIR/k8s-deploy.sh" ${DOMAIN:+--domain "$DOMAIN"} --set ingress.className=traefik --set networkPolicy.ingressNamespace=kube-system "${PASSTHROUGH[@]}"
