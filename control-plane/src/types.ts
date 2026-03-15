// API request/response types

export interface CreateTenantRequest {
  name: string;
  displayName: string;
  email: string;
  team?: string;
  resources?: {
    cpu?: string;
    memory?: string;
  };
  skills?: string[];
  policyRef?: string;
}

export interface TenantResponse {
  name: string;
  displayName: string;
  email: string;
  team?: string;
  phase: string;
  ingressHost?: string;
  createdAt?: string;
}

export interface SkillEntry {
  name: string;
  scope: "org" | "team" | "tenant";
  path: string;
  author?: string;
}

export interface CreatePolicyRequest {
  name: string;
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

export interface AuditEntry {
  timestamp: string;
  tenant?: string;
  action: string;
  resource: string;
  message: string;
}
