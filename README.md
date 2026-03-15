# OpenCrane Platform

Multi-tenant [OpenClaw](https://github.com/openclaw/openclaw) platform on Kubernetes. Each tenant (team member) gets an isolated OpenClaw instance behind a subdomain (`jente.opencrane.ai`).

## Architecture

```
                    ┌──────────────────────────┐
                    │   Control Plane (1x)      │
                    │   admin.opencrane.ai      │
                    └────────────┬─────────────┘
                                 │
                  ┌──────────────┼──────────────┐
                  │              │              │
            ┌─────▼─────┐ ┌─────▼─────┐ ┌─────▼─────┐
            │ jente.oc   │ │ sarah.oc   │ │ mike.oc   │
            │ OpenClaw   │ │ OpenClaw   │ │ OpenClaw   │
            │ (isolated) │ │ (isolated) │ │ (isolated) │
            └────────────┘ └────────────┘ └────────────┘
                Pod             Pod             Pod
```

- **Tenant isolation**: Each user runs in their own pod with dedicated storage
- **Credentials**: Per-tenant secrets on PVC + org-wide secrets from Kubernetes/Vault
- **Skills**: Developed individually, promoted to team/org via shared volume
- **Access control**: Network-level domain allowlisting via CiliumNetworkPolicy
- **Control plane**: Fleet management, skill registry, policy engine, audit logs

## Components

| Component | Path | Description |
|-----------|------|-------------|
| Helm chart | `helm/opencrane/` | Kubernetes manifests, CRDs, operator + control plane deployments |
| Operator | `operator/` | Watches Tenant/AccessPolicy CRDs, reconciles per-tenant resources |
| Control Plane | `control-plane/` | REST API for tenant, skill, and policy management |
| Docker | `docker/` | Container images for tenant pods, operator, and control plane |
| Skills | `skills/shared/` | Org/team shared skill library |

## Quick Start

### Prerequisites

- Kubernetes cluster (1.28+)
- Helm 3
- pnpm 10+
- Node 22+

### Development

```bash
pnpm install
pnpm build
pnpm test
```

### Deploy

```bash
# Install CRDs and platform components
helm install opencrane helm/opencrane \
  --set ingress.domain=opencrane.ai \
  --set ingress.tls.enabled=true

# Create a tenant
kubectl apply -f - <<EOF
apiVersion: opencrane.io/v1alpha1
kind: Tenant
metadata:
  name: jente
spec:
  displayName: Jente
  email: jente@example.com
EOF
```

The operator automatically creates the pod, service, PVC, and ingress rule. Access at `https://jente.opencrane.ai`.

## License

MIT
