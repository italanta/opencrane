import type { KubernetesObject } from "@kubernetes/client-node";

// -- Tenant CRD --

export interface TenantSpec {
  displayName: string;
  email: string;
  team?: string;
  openclawImage?: string;
  resources?: {
    cpu?: string;
    memory?: string;
  };
  skills?: string[];
  configOverrides?: Record<string, unknown>;
  policyRef?: string;
  suspended?: boolean;
}

export interface TenantStatus {
  phase: "Pending" | "Running" | "Suspended" | "Error";
  podName?: string;
  ingressHost?: string;
  message?: string;
  lastReconciled?: string;
}

export interface Tenant extends KubernetesObject {
  spec: TenantSpec;
  status?: TenantStatus;
}

// -- AccessPolicy CRD --

export interface AccessPolicySpec {
  description?: string;
  tenantSelector?: {
    matchLabels?: Record<string, string>;
    matchTeam?: string;
  };
  domains?: {
    allow?: string[];
    deny?: string[];
    defaultDeny?: boolean;
  };
  egressRules?: Array<{
    cidr: string;
    ports?: number[];
    protocol?: "TCP" | "UDP";
  }>;
  mcpServers?: {
    allow?: string[];
    deny?: string[];
  };
}

export interface AccessPolicy extends KubernetesObject {
  spec: AccessPolicySpec;
}

// -- Operator config (from env) --

export interface OperatorConfig {
  watchNamespace: string;
  tenantDefaultImage: string;
  ingressDomain: string;
  ingressClassName: string;
  sharedSkillsPvcName: string;
  gatewayPort: number;
}

export function loadOperatorConfig(): OperatorConfig {
  return {
    watchNamespace: process.env.WATCH_NAMESPACE ?? "",
    tenantDefaultImage:
      process.env.TENANT_DEFAULT_IMAGE ?? "ghcr.io/opencrane/tenant:latest",
    ingressDomain: process.env.INGRESS_DOMAIN ?? "opencrane.local",
    ingressClassName: process.env.INGRESS_CLASS_NAME ?? "nginx",
    sharedSkillsPvcName:
      process.env.SHARED_SKILLS_PVC_NAME ?? "opencrane-shared-skills",
    gatewayPort: Number(process.env.GATEWAY_PORT ?? "18789"),
  };
}
