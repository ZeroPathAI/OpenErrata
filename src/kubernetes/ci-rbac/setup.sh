#!/usr/bin/env bash
#
# Bootstrap the openerrata CI ServiceAccount on a Kubernetes cluster.
#
# Run this ONCE with cluster-admin access (e.g. your personal kubeconfig for
# the cunningham cluster).  It:
#
#   1. Creates the openerrata-main and openerrata-staging namespaces
#   2. Applies the RBAC manifests (ServiceAccount, Roles, Bindings)
#   3. Waits for the SA token to be provisioned
#   4. Prints a self-contained kubeconfig to stdout
#
# Usage:
#   ./setup.sh                       # prints kubeconfig to stdout
#   ./setup.sh > ci-kubeconfig.yaml  # save to file
#
# Environment:
#   TARGET_NAMESPACE (optional, default: openerrata-staging)
#     The namespace encoded in the generated kubeconfig's context.
#
# The printed kubeconfig is the value you set as the KUBE_CONFIG_DATA GitHub
# secret (you can base64-encode it or paste it raw; the deploy workflow
# accepts either format).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SA_NAME="openerrata-ci"
SA_NAMESPACE="kube-system"
SECRET_NAME="openerrata-ci-token"
NAMESPACES=("openerrata-main" "openerrata-staging")
TARGET_NAMESPACE="${TARGET_NAMESPACE:-openerrata-staging}"

case "$TARGET_NAMESPACE" in
  openerrata-main|openerrata-staging) ;;
  *)
    echo "Unsupported TARGET_NAMESPACE: ${TARGET_NAMESPACE}" >&2
    echo "Expected one of: openerrata-main, openerrata-staging" >&2
    exit 1
    ;;
esac

# ── 1. Create target namespaces ──────────────────────────────────────────
for ns in "${NAMESPACES[@]}"; do
  if kubectl get namespace "$ns" &>/dev/null; then
    echo "Namespace $ns already exists." >&2
  else
    echo "Creating namespace $ns ..." >&2
    kubectl create namespace "$ns"
  fi
done

# ── 2. Apply RBAC manifests ──────────────────────────────────────────────
echo "Applying RBAC manifests ..." >&2
kubectl apply -f "$SCRIPT_DIR/rbac.yaml"

# ── 3. Wait for token secret to be populated ─────────────────────────────
echo "Waiting for ServiceAccount token ..." >&2
for i in $(seq 1 30); do
  TOKEN="$(kubectl get secret "$SECRET_NAME" \
    --namespace "$SA_NAMESPACE" \
    -o jsonpath='{.data.token}' 2>/dev/null || true)"
  if [ -n "$TOKEN" ]; then
    break
  fi
  sleep 1
done

if [ -z "${TOKEN:-}" ]; then
  echo "ERROR: timed out waiting for token secret to be populated." >&2
  exit 1
fi

CA_DATA="$(kubectl get secret "$SECRET_NAME" \
  --namespace "$SA_NAMESPACE" \
  -o jsonpath='{.data.ca\.crt}')"

CLUSTER_SERVER="$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
CLUSTER_NAME="$(kubectl config view --minify -o jsonpath='{.clusters[0].name}')"

# ── 4. Emit kubeconfig ──────────────────────────────────────────────────
cat <<EOF
apiVersion: v1
kind: Config
clusters:
  - name: ${CLUSTER_NAME}
    cluster:
      server: ${CLUSTER_SERVER}
      certificate-authority-data: ${CA_DATA}
contexts:
  - name: ${SA_NAME}@${CLUSTER_NAME}
    context:
      cluster: ${CLUSTER_NAME}
      user: ${SA_NAME}
      namespace: ${TARGET_NAMESPACE}
current-context: ${SA_NAME}@${CLUSTER_NAME}
users:
  - name: ${SA_NAME}
    user:
      token: $(echo "$TOKEN" | base64 --decode)
EOF

echo "" >&2
echo "Kubeconfig written to stdout." >&2
echo "Set it as the KUBE_CONFIG_DATA secret in your GitHub repo." >&2
