#!/usr/bin/env bash
#
# Bootstrap the openerrata CI deploy permissions on the cunningham cluster.
#
# The GitHub Actions deploy job holds no Kubernetes credential of its own: it
# assumes the IAM role openerrata-github-actions-deploy through GitHub OIDC,
# and that role's EKS access entry (created by src/aws/ci-iam/setup.sh) maps
# it to the Kubernetes group `openerrata-ci`.  This script gives that group
# its permissions.
#
# Run it with cluster-admin access (e.g. your personal kubeconfig for the
# cunningham cluster, over the tailnet).  It is idempotent.  It:
#
#   1. Creates the openerrata-main and openerrata-staging namespaces
#   2. Applies the RBAC manifests (Roles and Bindings for the openerrata-ci
#      group)
#   3. Deletes the retired openerrata-ci ServiceAccount and its long-lived
#      token Secret from kube-system, which revokes the static kubeconfig the
#      old KUBE_CONFIG_DATA GitHub secret held
#
# Usage:
#   ./setup.sh
#
# Prerequisites:
#   - kubectl on PATH, with the current context pointing at the cunningham
#     cluster as a cluster admin

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAMESPACES=("openerrata-main" "openerrata-staging")
RETIRED_SA_NAMESPACE="kube-system"
RETIRED_SA_NAME="openerrata-ci"
RETIRED_SA_TOKEN_SECRET="openerrata-ci-token"

# ── 1. Prerequisites ─────────────────────────────────────────────────────
if ! command -v kubectl &>/dev/null; then
  echo "ERROR: kubectl not found. Install it first: https://kubernetes.io/docs/tasks/tools/" >&2
  exit 1
fi

echo "Using kube context: $(kubectl config current-context)" >&2

# ── 2. Create target namespaces ──────────────────────────────────────────
for ns in "${NAMESPACES[@]}"; do
  if kubectl get namespace "$ns" &>/dev/null; then
    echo "Namespace $ns already exists." >&2
  else
    echo "Creating namespace $ns ..." >&2
    kubectl create namespace "$ns"
  fi
done

# ── 3. Apply RBAC manifests ──────────────────────────────────────────────
echo "Applying RBAC manifests ..." >&2
kubectl apply -f "$SCRIPT_DIR/rbac.yaml"

# ── 4. Revoke the retired ServiceAccount credential ──────────────────────
echo "Deleting retired ServiceAccount token and ServiceAccount (if present) ..." >&2
kubectl delete secret "$RETIRED_SA_TOKEN_SECRET" \
  --namespace "$RETIRED_SA_NAMESPACE" --ignore-not-found
kubectl delete serviceaccount "$RETIRED_SA_NAME" \
  --namespace "$RETIRED_SA_NAMESPACE" --ignore-not-found

echo "" >&2
echo "CI RBAC ready: Kubernetes group openerrata-ci may deploy to ${NAMESPACES[*]}." >&2
echo "Delete the KUBE_CONFIG_DATA GitHub secret; its token no longer works." >&2
