/**
 * OpenCrane Control Plane — OpenAPI 3.1 specification.
 *
 * This is the single source of truth for the HTTP API contract.
 * Edit this file when you add or change routes, then run:
 *   pnpm --filter @opencrane/control-plane emit-openapi
 * and commit the regenerated openapi.json alongside the code change.
 *
 * The CI drift gate runs `emit-openapi` and fails if openapi.json is stale.
 */

// ---------------------------------------------------------------------------
// Reusable schema components
// ---------------------------------------------------------------------------

const ErrorEnvelope = {
  type: "object" as const,
  required: ["error", "code"],
  properties: {
    error: { type: "string", description: "Human-readable error description." },
    code: { type: "string", description: "Machine-readable error code." },
    detail: { type: "string", description: "Optional extra context." },
  },
};

const Pagination = {
  type: "object" as const,
  required: ["limit", "hasMore"],
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 1000 },
    nextCursor: { type: "string", description: "Opaque cursor for the next page. Absent when hasMore is false." },
    hasMore: { type: "boolean" },
  },
};

// Common response helpers
function notFound(description: string)
{
  return {
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  };
}

function badRequest(description: string)
{
  return {
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  };
}

function conflict(description: string)
{
  return {
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  };
}

function unprocessable(description: string)
{
  return {
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  };
}

function upstreamError()
{
  return {
    description: "Upstream dependency (Kubernetes, database, Cognee, LiteLLM) returned an error.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  };
}

function ok(description: string, schema: object)
{
  return {
    description,
    content: { "application/json": { schema } },
  };
}

function created(description: string, schema: object)
{
  return {
    description,
    content: { "application/json": { schema } },
  };
}

// ---------------------------------------------------------------------------
// Shared schema references
// ---------------------------------------------------------------------------

const TenantSchema = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
    displayName: { type: "string" },
    email: { type: "string", format: "email" },
    team: { type: "string" },
    phase: { type: "string" },
    ingressHost: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
  },
};

const PolicySchema = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
    namespace: { type: "string" },
    tenantSelector: { type: "object" },
    domains: { type: "array", items: { type: "string" } },
    egressRules: { type: "array", items: { type: "object" } },
    mcpServers: { type: "object" },
    createdAt: { type: "string", format: "date-time" },
  },
};

const McpServerCredentialSchema = {
  type: "object" as const,
  properties: {
    id: { type: "string", description: "Stable credential identifier." },
    displayName: { type: "string", description: "Operator-facing label." },
    brokeringMode: {
      type: "string",
      enum: ["static", "obo"],
      description: "Brokering strategy: 'static' (per-tenant/per-server secret fallback) or 'obo' (per-user RFC 8693 exchange brokered server-side; no static secret).",
    },
    secretRef: {
      type: ["string", "null"],
      description: "Secret reference for 'static' brokering; null for 'obo'.",
    },
  },
};

const McpServerCredentialInputSchema = {
  type: "object" as const,
  required: ["displayName"],
  properties: {
    displayName: { type: "string", description: "Operator-facing label." },
    brokeringMode: {
      type: "string",
      enum: ["static", "obo"],
      description: "Defaults to 'static'. 'static' requires secretRef; 'obo' must omit it.",
    },
    secretRef: { type: "string", description: "Required for 'static' brokering; omit for 'obo'." },
  },
};

const McpServerSchema = {
  type: "object" as const,
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    endpoint: { type: "string" },
    transport: { type: "string", enum: ["streamable-http", "sse", "websocket"] },
    grants: { type: "array", items: { type: "object" } },
    credentials: { type: "array", items: { $ref: "#/components/schemas/McpServerCredential" } },
  },
};

const ClusterTenantResourceQuotaSchema = {
  type: "object" as const,
  properties: {
    cpu: { type: "string", description: "Total CPU the customer may request (e.g. '4', '500m')." },
    memory: { type: "string", description: "Total memory the customer may request (e.g. '8Gi')." },
    pods: { type: "integer", description: "Maximum number of pods the customer may run." },
    storage: { type: "string", description: "Total persistent storage the customer may claim (e.g. '100Gi')." },
    gpu: { type: "integer", description: "Total GPUs the customer may request." },
  },
};

const ClusterTenantSchema = {
  type: "object" as const,
  required: ["name", "displayName", "isolationTier", "compute", "resources"],
  properties: {
    name: { type: "string", description: "Stable cluster-scoped identifier (the customer key)." },
    displayName: { type: "string", description: "Human-readable customer name." },
    isolationTier: { type: "string", enum: ["shared", "dedicatedNodes", "dedicatedCluster"], description: "Isolation strength chosen for this customer." },
    compute: {
      type: "object",
      required: ["mode"],
      properties: {
        mode: { type: "string", enum: ["shared", "dedicated"] },
        nodePool: { type: "string", description: "Dedicated node pool name; required when mode is 'dedicated'." },
      },
    },
    resources: {
      type: "object",
      required: ["quota"],
      properties: { quota: { $ref: "#/components/schemas/ClusterTenantResourceQuota" } },
    },
    status: {
      type: "object",
      properties: {
        phase: { type: "string", enum: ["pending", "provisioning", "ready", "failed"] },
        message: { type: "string" },
        boundNamespace: { type: "string" },
        provisioner: { type: "string" },
      },
    },
  },
};

const ClusterTenantWriteSchema = {
  type: "object" as const,
  required: ["name", "displayName", "isolationTier", "compute", "resources"],
  properties: {
    name: { type: "string", description: "Stable cluster-scoped identifier (the customer key)." },
    displayName: { type: "string", description: "Human-readable customer name." },
    isolationTier: { type: "string", enum: ["shared", "dedicatedNodes", "dedicatedCluster"] },
    compute: {
      type: "object",
      required: ["mode"],
      properties: {
        mode: { type: "string", enum: ["shared", "dedicated"] },
        nodePool: { type: "string" },
      },
    },
    resources: {
      type: "object",
      required: ["quota"],
      properties: { quota: { $ref: "#/components/schemas/ClusterTenantResourceQuota" } },
    },
  },
};

const GroupSchema = {
  type: "object" as const,
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    memberCount: { type: "integer" },
    awarenessGrants: { type: "array", items: { type: "object" } },
  },
};

const SkillBundleSchema = {
  type: "object" as const,
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    version: { type: "string" },
    digest: { type: "string" },
    scope: { type: "string", enum: ["org", "team", "project", "personal"] },
    status: { type: "string", enum: ["draft", "published", "deprecated"] },
    tags: { type: "array", items: { type: "string" } },
    sourceName: { type: "string" },
    publishedAt: { type: "string", format: "date-time" },
    grants: { type: "array", items: { type: "object" } },
    promotions: { type: "array", items: { type: "object" } },
  },
};

const AuditEntrySchema = {
  type: "object" as const,
  properties: {
    timestamp: { type: "string", format: "date-time" },
    tenant: { type: "string" },
    action: { type: "string" },
    resource: { type: "string" },
    message: { type: "string" },
  },
};

const AccessTokenSchema = {
  type: "object" as const,
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    owner: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
    expiresAt: { type: "string", format: "date-time" },
    lastUsedAt: { type: "string", format: "date-time" },
  },
};

const ProviderKeySchema = {
  type: "object" as const,
  properties: {
    provider: { type: "string" },
    configured: { type: "boolean" },
    updatedAt: { type: "string", format: "date-time" },
  },
};

const DeviceGrantSchema = {
  type: "object" as const,
  required: ["deviceCode", "userCode", "verificationUri", "expiresIn", "interval"],
  properties: {
    deviceCode: { type: "string", description: "Secret code used by the CLI to poll for the token." },
    userCode: { type: "string", description: "Short code (XXXX-XXXX) the operator sees." },
    verificationUri: { type: "string", description: "Relative URL the operator should open in a browser." },
    expiresIn: { type: "integer", description: "Seconds until the grant expires (300)." },
    interval: { type: "integer", description: "Minimum polling interval in seconds (5)." },
  },
};

const DatasetMembershipSchema = {
  type: "object" as const,
  required: ["org", "team", "project", "personal"],
  properties: {
    org: { type: "array", items: { type: "string" } },
    team: { type: "array", items: { type: "string" } },
    project: { type: "array", items: { type: "string" } },
    personal: { type: "array", items: { type: "string" } },
  },
};

const EffectiveContractSchema = {
  type: "object" as const,
  properties: {
    contractId: { type: "string" },
    contractVersion: { type: "string" },
    tenant: { type: "object" },
    awareness: { type: "object" },
    mcp: { type: "object" },
    skills: { type: "object" },
  },
};

const ProjectionDriftSchema = {
  type: "object" as const,
  properties: {
    tenant: { type: "object" },
    accessPolicy: { type: "object" },
    evaluatedAt: { type: "string", format: "date-time" },
    alertFired: { type: "boolean" },
  },
};

const BudgetSchema = {
  type: "object" as const,
  properties: {
    monthlyLimitUsd: { type: "number" },
    currentSpendUsd: { type: "number" },
    budgetAlertState: { type: "string", enum: ["ok", "warning", "exceeded"] },
  },
};

const ThirdPartySourceSchema = {
  type: "object" as const,
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    type: { type: "string" },
    url: { type: "string" },
    syncStatus: { type: "string" },
    lastSyncedAt: { type: "string", format: "date-time" },
  },
};

const TokenUsageSchema = {
  type: "object" as const,
  properties: {
    tenant: { type: "string" },
    model: { type: "string" },
    inputTokens: { type: "integer" },
    outputTokens: { type: "integer" },
    totalCostUsd: { type: "number" },
    recordedAt: { type: "string", format: "date-time" },
  },
};

// ---------------------------------------------------------------------------
// Cursor-paginated response wrapper
// ---------------------------------------------------------------------------

function paginated(itemSchema: object)
{
  return {
    type: "object" as const,
    required: ["data", "pagination"],
    properties: {
      data: { type: "array", items: itemSchema },
      pagination: { $ref: "#/components/schemas/Pagination" },
    },
  };
}

// ---------------------------------------------------------------------------
// Spec document
// ---------------------------------------------------------------------------

export const spec = {
  openapi: "3.1.0",
  info: {
    title: "OpenCrane Control Plane API",
    version: "1.0.0",
    description: "Multi-tenant AI agent platform management API.\n\n**Authentication**\n\n- *Human operators* — OIDC browser flow via `GET /auth/login` → `/auth/callback`. Session cookie is set server-side.\n- *CLI operators* — Device authorization grant via `POST /auth/device`. The CLI opens the returned `verificationUri` in the operator's browser, polls `GET /auth/device/token`, and persists the issued token in `~/.config/opencrane/credentials.json`.\n- *Automation / CI* — Bearer token via the `OPENCRANE_TOKEN` environment variable, validated against the `OPENCRANE_API_TOKEN` server-side env var.\n- Endpoints tagged *Auth* and *Meta* (`/auth/*`, `/openapi.json`) require no credentials.",
  },
  servers: [
    { url: "/api/v1", description: "Versioned API prefix" },
  ],
  components: {
    schemas: {
      Error: ErrorEnvelope,
      Pagination,
      Tenant: TenantSchema,
      Policy: PolicySchema,
      McpServer: McpServerSchema,
      McpServerCredential: McpServerCredentialSchema,
      ClusterTenant: ClusterTenantSchema,
      ClusterTenantWrite: ClusterTenantWriteSchema,
      ClusterTenantResourceQuota: ClusterTenantResourceQuotaSchema,
      Group: GroupSchema,
      SkillBundle: SkillBundleSchema,
      AuditEntry: AuditEntrySchema,
      AccessToken: AccessTokenSchema,
      ProviderKey: ProviderKeySchema,
      AwarenessRollout: {
        type: "object",
        properties: {
          targetVersion: { type: "string" },
          stableVersion: { type: "string" },
          waves: { type: "array", items: { type: "string" } },
          promotedWaves: { type: "array", items: { type: "string" } },
          shadowMode: { type: "boolean" },
          nextWave: { type: "string", nullable: true },
        },
      },
      ScopeSelector: {
        type: "object",
        required: ["scope", "payloadId"],
        properties: {
          scope: { type: "string", enum: ["org", "department", "project", "personal"] },
          payloadId: { type: "string" },
        },
      },
      SessionScope: {
        type: "object",
        properties: {
          sessionKey: { type: "string" },
          principal: { type: "string" },
          scopes: { type: "array", items: { $ref: "#/components/schemas/ScopeSelector" } },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      DatasetMembership: DatasetMembershipSchema,
      EffectiveContract: EffectiveContractSchema,
      ProjectionDrift: ProjectionDriftSchema,
      Budget: BudgetSchema,
      ThirdPartySource: ThirdPartySourceSchema,
      TokenUsage: TokenUsageSchema,
      DeviceGrant: DeviceGrantSchema,
    },
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "Static bearer token. Pass as Authorization: Bearer <token>.",
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {

    // ------------------------------------------------------------------
    // Platform DNS / TLS issuance (CONN.8a)
    // ------------------------------------------------------------------

    "/platform/dns": {
      get: {
        operationId: "getPlatformDns",
        summary: "Show the configured platform DNS-01 issuer (ClusterIssuer or namespaced Issuer)",
        tags: ["Platform DNS"],
        parameters: [{ name: "issuerName", in: "query", required: false, schema: { type: "string" } }],
        responses: {
          200: ok("Current issuer status.", {
            type: "object",
            properties: {
              configured: { type: "boolean" },
              issuerName: { type: "string" },
              issuerKind: { type: "string", enum: ["ClusterIssuer", "Issuer"] },
              issuerNamespace: { type: "string", nullable: true },
              provider: { type: "string", nullable: true },
              email: { type: "string", nullable: true },
              server: { type: "string", nullable: true },
            },
          }),
        },
      },
      put: {
        operationId: "setPlatformDns",
        summary: "Configure the platform DNS-01 issuer for wildcard TLS (ClusterIssuer or namespaced Issuer)",
        tags: ["Platform DNS"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["provider", "zone", "email"],
                properties: {
                  provider: { type: "string" },
                  zone: { type: "string" },
                  email: { type: "string" },
                  server: { type: "string" },
                  issuerName: { type: "string" },
                  apiToken: { type: "string" },
                  solverConfig: { type: "object", additionalProperties: true },
                },
              },
            },
          },
        },
        responses: {
          200: ok("Issuer configured.", {
            type: "object",
            properties: {
              status: { type: "string" },
              issuerName: { type: "string" },
              issuerKind: { type: "string", enum: ["ClusterIssuer", "Issuer"] },
              issuerNamespace: { type: "string", nullable: true },
              provider: { type: "string" },
              zone: { type: "string" },
              secretName: { type: "string", nullable: true },
            },
          }),
        },
      },
    },

    // Awareness contract rollout (P4B.3)
    // ------------------------------------------------------------------

    "/awareness/rollout": {
      get: {
        operationId: "getAwarenessRollout",
        summary: "Show the fleet awareness contract rollout state",
        tags: ["Awareness Rollout"],
        responses: {
          200: ok("Current rollout state.", { $ref: "#/components/schemas/AwarenessRollout" }),
        },
      },
      put: {
        operationId: "setAwarenessRollout",
        summary: "Define (or redefine) the awareness rollout; resets the frontier",
        tags: ["Awareness Rollout"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["targetVersion"],
                properties: {
                  targetVersion: { type: "string" },
                  stableVersion: { type: "string" },
                  waves: { type: "array", items: { type: "string" } },
                  shadowMode: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          200: ok("Rollout defined.", { $ref: "#/components/schemas/AwarenessRollout" }),
        },
      },
    },
    "/awareness/rollout/promote": {
      post: {
        operationId: "promoteAwarenessRollout",
        summary: "Advance the rollout frontier (one wave, or up to a named wave)",
        tags: ["Awareness Rollout"],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: { type: "object", properties: { wave: { type: "string" } } },
            },
          },
        },
        responses: {
          200: ok("Frontier advanced.", { $ref: "#/components/schemas/AwarenessRollout" }),
        },
      },
    },
    "/awareness/rollout/rollback": {
      post: {
        operationId: "rollbackAwarenessRollout",
        summary: "One-step rollback: return every wave to the stable version",
        tags: ["Awareness Rollout"],
        responses: {
          200: ok("Rolled back.", { $ref: "#/components/schemas/AwarenessRollout" }),
        },
      },
    },
    "/awareness/rollout/resolve/{tenant}": {
      get: {
        operationId: "resolveAwarenessVersion",
        summary: "Resolve the awareness contract version a tenant runs",
        tags: ["Awareness Rollout"],
        parameters: [{ name: "tenant", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: ok("Resolved version.", {
            type: "object",
            properties: {
              tenant: { type: "string" },
              version: { type: "string" },
              promoted: { type: "boolean" },
              shadow: { type: "boolean" },
              wave: { type: "string" },
            },
          }),
          404: notFound("Tenant not found."),
        },
      },
    },

    "/awareness/participation": {
      get: {
        operationId: "getFleetParticipation",
        summary: "Fleet participation, drift, and policy-violation monitoring",
        tags: ["Awareness Rollout"],
        parameters: [{ name: "severity", in: "query", required: false, schema: { type: "string", enum: ["critical", "warning"] } }],
        responses: {
          200: ok("Fleet participation report.", {
            type: "object",
            properties: {
              total: { type: "integer" },
              participating: { type: "integer" },
              drifted: { type: "integer" },
              critical: { type: "integer" },
              warning: { type: "integer" },
              tenants: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    tenant: { type: "string" },
                    lastSeenAt: { type: "string", nullable: true },
                    runningContractVersion: { type: "string", nullable: true },
                    expectedContractVersion: { type: "string" },
                    participating: { type: "boolean" },
                    drifted: { type: "boolean" },
                    policyViolations: { type: "integer" },
                    severity: { type: "string", enum: ["ok", "warning", "critical"] },
                  },
                },
              },
            },
          }),
        },
      },
    },

    // Sessions (scope binding — anti-spill, P4B.7)
    // ------------------------------------------------------------------

    "/sessions/{sessionKey}/scope": {
      get: {
        operationId: "getSessionScope",
        summary: "Inspect a chat-window session's awareness scope binding",
        tags: ["Sessions"],
        parameters: [{ name: "sessionKey", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: ok("Current session scope binding.", { $ref: "#/components/schemas/SessionScope" }),
          404: notFound("Session scope not found."),
        },
      },
      put: {
        operationId: "setSessionScope",
        summary: "Bind a session scope (CP intersects with the principal's entitlements)",
        tags: ["Sessions"],
        parameters: [{ name: "sessionKey", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["principal", "scopes"],
                properties: {
                  principal: { type: "string" },
                  scopes: { type: "array", items: { $ref: "#/components/schemas/ScopeSelector" } },
                },
              },
            },
          },
        },
        responses: {
          200: ok("Authorised binding; `rejected` lists any over-scope dropped.", {
            allOf: [
              { $ref: "#/components/schemas/SessionScope" },
              { type: "object", properties: { rejected: { type: "array", items: { $ref: "#/components/schemas/ScopeSelector" } } } },
            ],
          }),
          400: badRequest("Missing principal or empty scopes."),
          403: { description: "None of the requested scopes are entitled (over-scope).", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        operationId: "clearSessionScope",
        summary: "Clear a session's scope binding",
        tags: ["Sessions"],
        parameters: [{ name: "sessionKey", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: ok("Binding cleared.", { type: "object", properties: { sessionKey: { type: "string" }, cleared: { type: "boolean" } } }),
          404: notFound("Session scope not found."),
        },
      },
    },

    // Tenants
    // ------------------------------------------------------------------

    "/tenants": {
      get: {
        operationId: "listTenants",
        summary: "List all tenants",
        tags: ["Tenants"],
        responses: {
          200: ok("Tenant list.", { type: "array", items: { $ref: "#/components/schemas/Tenant" } }),
        },
      },
      post: {
        operationId: "createTenant",
        summary: "Create a new tenant (dual-write: K8s CRD + database)",
        tags: ["Tenants"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "displayName", "email"],
                properties: {
                  name: { type: "string" },
                  displayName: { type: "string" },
                  email: { type: "string", format: "email" },
                  team: { type: "string" },
                  monthlyBudgetUsd: { type: "number" },
                  resources: { type: "object" },
                  skillAllowlist: { type: "array", items: { type: "string" } },
                  policyRef: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          201: created("Tenant created.", { type: "object", properties: { name: { type: "string" }, status: { type: "string" } } }),
          502: upstreamError(),
          504: { description: "Tenant CR did not appear in Kubernetes within the SLO window.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    "/tenants/drift": {
      get: {
        operationId: "getTenantProjectionDrift",
        summary: "Detect drift between Tenant CRDs and PostgreSQL projection rows",
        tags: ["Tenants"],
        responses: {
          200: ok("Drift report.", { type: "object" }),
        },
      },
    },

    "/tenants/repair": {
      post: {
        operationId: "repairTenantProjection",
        summary: "Repair Tenant projection rows from CRD source of truth",
        tags: ["Tenants"],
        parameters: [
          { name: "dryRun", in: "query", schema: { type: "boolean", default: true }, description: "When true (default), report planned changes without applying them." },
        ],
        responses: {
          200: ok("Repair report.", { type: "object" }),
        },
      },
    },

    "/tenants/{name}": {
      get: {
        operationId: "getTenant",
        summary: "Get a single tenant by name",
        tags: ["Tenants"],
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: ok("Tenant detail.", { $ref: "#/components/schemas/Tenant" }),
          404: notFound("Tenant not found."),
        },
      },
      put: {
        operationId: "updateTenant",
        summary: "Update a tenant (dual-write: K8s CRD + database)",
        tags: ["Tenants"],
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  displayName: { type: "string" },
                  email: { type: "string", format: "email" },
                  team: { type: "string" },
                  monthlyBudgetUsd: { type: "number" },
                  resources: { type: "object" },
                  skillAllowlist: { type: "array", items: { type: "string" } },
                  policyRef: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          200: ok("Tenant updated.", { type: "object", properties: { name: { type: "string" }, status: { type: "string" } } }),
        },
      },
      delete: {
        operationId: "deleteTenant",
        summary: "Delete a tenant (dual-write: K8s CRD + database)",
        tags: ["Tenants"],
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: ok("Tenant deleted.", { type: "object", properties: { name: { type: "string" }, status: { type: "string" } } }),
        },
      },
    },

    "/tenants/{name}/suspend": {
      post: {
        operationId: "suspendTenant",
        summary: "Suspend a tenant (scale deployment to zero)",
        tags: ["Tenants"],
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: ok("Tenant suspended.", { type: "object", properties: { name: { type: "string" }, status: { type: "string" } } }),
        },
      },
    },

    "/tenants/{name}/resume": {
      post: {
        operationId: "resumeTenant",
        summary: "Resume a suspended tenant",
        tags: ["Tenants"],
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: ok("Tenant resumed.", { type: "object", properties: { name: { type: "string" }, status: { type: "string" } } }),
        },
      },
    },

    "/tenants/{name}/datasets": {
      get: {
        operationId: "getTenantDatasets",
        summary: "Get dataset memberships for a tenant",
        tags: ["Tenants"],
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: ok("Dataset memberships.", { $ref: "#/components/schemas/DatasetMembership" }),
          404: notFound("Tenant not found."),
          502: upstreamError(),
        },
      },
      put: {
        operationId: "updateTenantDatasets",
        summary: "Update dataset memberships for a tenant",
        tags: ["Tenants"],
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/DatasetMembership" } } },
        },
        responses: {
          200: ok("Dataset memberships updated.", { $ref: "#/components/schemas/DatasetMembership" }),
          400: badRequest("Invalid membership payload."),
          404: notFound("Tenant not found."),
          502: upstreamError(),
        },
      },
    },

    "/tenants/{name}/effective-contract": {
      get: {
        operationId: "getTenantEffectiveContract",
        summary: "Compile the effective awareness, MCP, and skill contract for a tenant",
        tags: ["Tenants"],
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: ok("Effective contract.", { $ref: "#/components/schemas/EffectiveContract" }),
          404: notFound("Tenant not found."),
        },
      },
    },

    // ------------------------------------------------------------------
    // Policies
    // ------------------------------------------------------------------

    "/policies": {
      get: {
        operationId: "listPolicies",
        summary: "List all access policies",
        tags: ["Policies"],
        responses: {
          200: ok("Policy list.", { type: "array", items: { $ref: "#/components/schemas/Policy" } }),
        },
      },
      post: {
        operationId: "createPolicy",
        summary: "Create an access policy (dual-write: K8s CRD + database)",
        tags: ["Policies"],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: {
          201: created("Policy created.", { type: "object", properties: { name: { type: "string" }, status: { type: "string" } } }),
        },
      },
    },

    "/policies/drift": {
      get: {
        operationId: "getPolicyProjectionDrift",
        summary: "Detect drift between AccessPolicy CRDs and PostgreSQL projection rows",
        tags: ["Policies"],
        responses: {
          200: ok("Drift report.", { type: "object" }),
        },
      },
    },

    "/policies/repair": {
      post: {
        operationId: "repairPolicyProjection",
        summary: "Repair AccessPolicy projection rows from CRD source of truth",
        tags: ["Policies"],
        parameters: [
          { name: "dryRun", in: "query", schema: { type: "boolean", default: true } },
        ],
        responses: {
          200: ok("Repair report.", { type: "object" }),
        },
      },
    },

    "/policies/{name}": {
      get: {
        operationId: "getPolicy",
        summary: "Get a single access policy by name",
        tags: ["Policies"],
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: ok("Policy detail.", { $ref: "#/components/schemas/Policy" }),
          404: notFound("Policy not found."),
        },
      },
      put: {
        operationId: "updatePolicy",
        summary: "Update an access policy",
        tags: ["Policies"],
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: {
          200: ok("Policy updated.", { type: "object" }),
        },
      },
      delete: {
        operationId: "deletePolicy",
        summary: "Delete an access policy",
        tags: ["Policies"],
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: ok("Policy deleted.", { type: "object", properties: { name: { type: "string" }, status: { type: "string" } } }),
        },
      },
    },

    // ------------------------------------------------------------------
    // Cluster Tenants (CT.2) — first-class customer / isolation unit
    // ------------------------------------------------------------------

    "/cluster-tenants": {
      get: {
        operationId: "listClusterTenants",
        summary: "List all cluster tenants",
        tags: ["Cluster Tenants"],
        responses: {
          200: ok("Cluster tenant list.", { type: "array", items: { $ref: "#/components/schemas/ClusterTenant" } }),
        },
      },
      post: {
        operationId: "createClusterTenant",
        summary: "Create a cluster tenant (rejects an isolation tier no provisioner can serve)",
        tags: ["Cluster Tenants"],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/ClusterTenantWrite" } } },
        },
        responses: {
          201: created("Cluster tenant created.", { $ref: "#/components/schemas/ClusterTenant" }),
          400: badRequest("Request body failed validation."),
          422: unprocessable("Requested isolation tier is not served by any registered provisioner (code TIER_UNAVAILABLE)."),
        },
      },
    },

    "/cluster-tenants/{name}": {
      get: {
        operationId: "getClusterTenant",
        summary: "Get a single cluster tenant by name",
        tags: ["Cluster Tenants"],
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: ok("Cluster tenant detail.", { $ref: "#/components/schemas/ClusterTenant" }),
          404: notFound("Cluster tenant not found."),
        },
      },
      put: {
        operationId: "updateClusterTenant",
        summary: "Update a cluster tenant (re-gates the isolation tier when it changes)",
        tags: ["Cluster Tenants"],
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: {
          200: ok("Cluster tenant updated.", { $ref: "#/components/schemas/ClusterTenant" }),
          400: badRequest("Request body failed validation."),
          404: notFound("Cluster tenant not found."),
          422: unprocessable("Requested isolation tier is not served by any registered provisioner (code TIER_UNAVAILABLE)."),
        },
      },
      delete: {
        operationId: "deleteClusterTenant",
        summary: "Delete a cluster tenant",
        tags: ["Cluster Tenants"],
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: ok("Cluster tenant deleted.", { type: "object", properties: { name: { type: "string" }, status: { type: "string" } } }),
          404: notFound("Cluster tenant not found."),
        },
      },
    },

    "/cluster-tenants/{name}/status": {
      get: {
        operationId: "getClusterTenantStatus",
        summary: "Get the observed status of a cluster tenant",
        tags: ["Cluster Tenants"],
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: ok("Cluster tenant status.", {
            type: "object",
            properties: {
              phase: { type: "string", enum: ["pending", "provisioning", "ready", "failed"] },
              message: { type: "string" },
              boundNamespace: { type: "string" },
              provisioner: { type: "string" },
            },
          }),
          404: notFound("Cluster tenant not found."),
        },
      },
    },

    // ------------------------------------------------------------------
    // MCP Servers
    // ------------------------------------------------------------------

    "/mcp-servers": {
      get: {
        operationId: "listMcpServers",
        summary: "List all MCP servers with grants and credentials",
        tags: ["MCP Servers"],
        responses: {
          200: ok("MCP server list.", { type: "array", items: { $ref: "#/components/schemas/McpServer" } }),
        },
      },
      post: {
        operationId: "createMcpServer",
        summary: "Create a new MCP server",
        tags: ["MCP Servers"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "endpoint", "transport"],
                properties: {
                  name: { type: "string" },
                  endpoint: { type: "string" },
                  transport: { type: "string" },
                  grants: { type: "array", items: { type: "object" } },
                  credentials: { type: "array", items: { type: "object" } },
                },
              },
            },
          },
        },
        responses: {
          201: created("MCP server created.", { $ref: "#/components/schemas/McpServer" }),
        },
      },
    },

    "/mcp-servers/{id}": {
      get: {
        operationId: "getMcpServer",
        summary: "Get a single MCP server by identifier",
        tags: ["MCP Servers"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: ok("MCP server detail.", { $ref: "#/components/schemas/McpServer" }),
          404: notFound("MCP server not found."),
        },
      },
      put: {
        operationId: "updateMcpServer",
        summary: "Update an MCP server and fully replace grants and credentials",
        tags: ["MCP Servers"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: {
          200: ok("MCP server updated.", { $ref: "#/components/schemas/McpServer" }),
        },
      },
      delete: {
        operationId: "deleteMcpServer",
        summary: "Delete an MCP server and its linked grant rows",
        tags: ["MCP Servers"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: ok("MCP server deleted.", { type: "object", properties: { id: { type: "string" }, status: { type: "string" } } }),
        },
      },
    },

    "/mcp-servers/{id}/credentials": {
      get: {
        operationId: "listMcpServerCredentials",
        summary: "List the brokered credentials of an MCP server",
        tags: ["MCP Servers"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: ok("Credential list.", { type: "array", items: { $ref: "#/components/schemas/McpServerCredential" } }),
          404: notFound("MCP server not found."),
        },
      },
      post: {
        operationId: "addMcpServerCredential",
        summary: "Add a brokered credential to an MCP server (does not touch grants)",
        tags: ["MCP Servers"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: McpServerCredentialInputSchema } },
        },
        responses: {
          201: created("Credential added.", { $ref: "#/components/schemas/McpServerCredential" }),
          400: badRequest("Credential payload violates brokering-mode custody rules."),
          404: notFound("MCP server not found."),
        },
      },
    },

    "/mcp-servers/{id}/credentials/{credentialId}": {
      delete: {
        operationId: "deleteMcpServerCredential",
        summary: "Remove a single brokered credential from an MCP server",
        tags: ["MCP Servers"],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "credentialId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: ok("Credential deleted.", { type: "object", properties: { id: { type: "string" }, status: { type: "string" } } }),
          404: notFound("MCP server or credential not found."),
        },
      },
    },

    // ------------------------------------------------------------------
    // Groups
    // ------------------------------------------------------------------

    "/groups": {
      get: {
        operationId: "listGroups",
        summary: "List all groups with member counts and awareness grants",
        tags: ["Groups"],
        responses: {
          200: ok("Group list.", { type: "array", items: { $ref: "#/components/schemas/Group" } }),
        },
      },
      post: {
        operationId: "createGroup",
        summary: "Create a new group and optional awareness grants",
        tags: ["Groups"],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, description: { type: "string" } } } } },
        },
        responses: {
          201: created("Group created.", { $ref: "#/components/schemas/Group" }),
        },
      },
    },

    "/groups/{id}": {
      get: {
        operationId: "getGroup",
        summary: "Get a single group by identifier",
        tags: ["Groups"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: ok("Group detail.", { $ref: "#/components/schemas/Group" }),
          404: notFound("Group not found."),
        },
      },
      put: {
        operationId: "updateGroup",
        summary: "Update a group and replace awareness grants",
        tags: ["Groups"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: {
          200: ok("Group updated.", { $ref: "#/components/schemas/Group" }),
        },
      },
      delete: {
        operationId: "deleteGroup",
        summary: "Delete a group and its awareness grants",
        tags: ["Groups"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: ok("Group deleted.", { type: "object", properties: { id: { type: "string" }, status: { type: "string" } } }),
        },
      },
    },

    // ------------------------------------------------------------------
    // Skill catalog
    // ------------------------------------------------------------------

    "/skills/catalog": {
      get: {
        operationId: "listSkillBundles",
        summary: "List all skill bundles with entitlements and promotion history",
        tags: ["Skills"],
        responses: {
          200: ok("Skill bundle list.", { type: "array", items: { $ref: "#/components/schemas/SkillBundle" } }),
        },
      },
      post: {
        operationId: "createSkillBundle",
        summary: "Create a new skill bundle",
        tags: ["Skills"],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["name", "version", "digest", "scope"] } } },
        },
        responses: {
          201: created("Skill bundle created.", { type: "object", properties: { id: { type: "string" }, status: { type: "string" } } }),
        },
      },
    },

    "/skills/catalog/backfill": {
      post: {
        operationId: "backfillSkillBundlesToOci",
        summary: "Backfill all published bundles' content into the OCI store (P4D.2)",
        tags: ["Skills"],
        responses: {
          200: ok("Backfill summary with per-bundle outcomes.", {
            type: "object",
            required: ["total", "pushed", "skipped", "failed", "results"],
            properties: {
              total: { type: "integer", description: "Published bundles considered." },
              pushed: { type: "integer", description: "Count pushed to the registry." },
              skipped: { type: "integer", description: "Count skipped (no DB content)." },
              failed: { type: "integer", description: "Count failed (push error or digest mismatch)." },
              results: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id", "name", "digest", "outcome"],
                  properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    digest: { type: "string" },
                    outcome: { type: "string", enum: ["pushed", "skipped", "failed"] },
                    reason: { type: "string", description: "Failure detail when outcome is failed." },
                  },
                },
              },
            },
          }),
          409: conflict("OCI store not configured (SKILL_OCI_REGISTRY_URL unset)."),
        },
      },
    },

    "/skills/catalog/{id}": {
      get: {
        operationId: "getSkillBundle",
        summary: "Get a single skill bundle by identifier",
        tags: ["Skills"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: ok("Skill bundle detail.", { $ref: "#/components/schemas/SkillBundle" }),
          404: notFound("Skill bundle not found."),
        },
      },
      put: {
        operationId: "updateSkillBundle",
        summary: "Update a skill bundle and fully replace entitlements and promotions",
        tags: ["Skills"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: {
          200: ok("Skill bundle updated.", { type: "object", properties: { id: { type: "string" }, status: { type: "string" } } }),
        },
      },
      delete: {
        operationId: "deleteSkillBundle",
        summary: "Delete a skill bundle and its linked entitlement grants",
        tags: ["Skills"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: ok("Skill bundle deleted.", { type: "object", properties: { id: { type: "string" }, status: { type: "string" } } }),
        },
      },
    },

    // ------------------------------------------------------------------
    // Third-party sources
    // ------------------------------------------------------------------

    "/third-party-sources": {
      get: {
        operationId: "listThirdPartySources",
        summary: "List all third-party sources",
        tags: ["Third-party Sources"],
        responses: {
          200: ok("Third-party source list.", { type: "array", items: { $ref: "#/components/schemas/ThirdPartySource" } }),
        },
      },
      post: {
        operationId: "createThirdPartySource",
        summary: "Register a new third-party source",
        tags: ["Third-party Sources"],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["name", "type", "url"] } } },
        },
        responses: {
          201: created("Source registered.", { type: "object" }),
        },
      },
    },

    "/third-party-sources/{id}": {
      get: {
        operationId: "getThirdPartySource",
        summary: "Get a single third-party source",
        tags: ["Third-party Sources"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: ok("Source detail.", { $ref: "#/components/schemas/ThirdPartySource" }),
          404: notFound("Source not found."),
        },
      },
      put: {
        operationId: "updateThirdPartySource",
        summary: "Update a third-party source",
        tags: ["Third-party Sources"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: {
          200: ok("Source updated.", { type: "object" }),
        },
      },
      delete: {
        operationId: "deleteThirdPartySource",
        summary: "Delete a third-party source and its linked items",
        tags: ["Third-party Sources"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: ok("Source deleted.", { type: "object" }),
        },
      },
    },

    // ------------------------------------------------------------------
    // Access tokens
    // ------------------------------------------------------------------

    "/access-tokens": {
      get: {
        operationId: "listAccessTokens",
        summary: "List all issued access tokens (hashes only, never plaintext)",
        tags: ["Access Tokens"],
        responses: {
          200: ok("Token list.", { type: "array", items: { $ref: "#/components/schemas/AccessToken" } }),
        },
      },
      post: {
        operationId: "createAccessToken",
        summary: "Create a new access token. Returns plaintext token once — store it securely.",
        tags: ["Access Tokens"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  owner: { type: "string" },
                  expiresAt: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
        responses: {
          201: created("Token created. The plainTextToken field will not be returned again.", {
            type: "object",
            required: ["id", "plainTextToken"],
            properties: { id: { type: "string" }, plainTextToken: { type: "string" } },
          }),
        },
      },
    },

    "/access-tokens/{id}": {
      delete: {
        operationId: "deleteAccessToken",
        summary: "Revoke and delete an access token",
        tags: ["Access Tokens"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          204: { description: "Token deleted." },
          404: notFound("Token not found."),
        },
      },
    },

    // ------------------------------------------------------------------
    // Provider keys
    // ------------------------------------------------------------------

    "/providers/keys": {
      get: {
        operationId: "listProviderKeys",
        summary: "List configured provider API keys (configured status only, never the key value)",
        tags: ["Provider Keys"],
        responses: {
          200: ok("Provider key status list.", { type: "array", items: { $ref: "#/components/schemas/ProviderKey" } }),
        },
      },
    },

    // @see https://datatracker.ietf.org/doc/html/rfc9110#name-put
    // The RFC spec which specifies that PUT requires the full resource representation, which in this case is just the provider name 
    "/providers/keys/{provider}": {
      put: {
        operationId: "upsertProviderKey",
        summary: "Create or update a provider API key",
        tags: ["Provider Keys"],
        parameters: [{ name: "provider", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["apiKey"],
                properties: { apiKey: { type: "string" } },
              },
            },
          },
        },
        responses: {
          200: ok("Key updated.", { $ref: "#/components/schemas/ProviderKey" }),
        },
      },
      delete: {
        operationId: "deleteProviderKey",
        summary: "Delete a configured provider API key",
        tags: ["Provider Keys"],
        parameters: [{ name: "provider", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          204: { description: "Key deleted." },
          404: notFound("Provider key not found."),
        },
      },
    },

    // ------------------------------------------------------------------
    // AI budget & spend
    // ------------------------------------------------------------------

    "/ai-budget/global": {
      get: {
        operationId: "getGlobalBudget",
        summary: "Get global monthly spend ceiling",
        tags: ["AI Budget"],
        responses: {
          200: ok("Global budget.", { $ref: "#/components/schemas/Budget" }),
        },
      },
      put: {
        operationId: "updateGlobalBudget",
        summary: "Update the global monthly spend ceiling",
        tags: ["AI Budget"],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["monthlyLimitUsd"], properties: { monthlyLimitUsd: { type: "number" } } } } },
        },
        responses: {
          200: ok("Global budget updated.", { $ref: "#/components/schemas/Budget" }),
        },
      },
    },

    "/ai-budget/accounts": {
      get: {
        operationId: "listAccountBudgets",
        summary: "List all per-account monthly spend ceilings",
        tags: ["AI Budget"],
        responses: {
          200: ok("Account budgets.", { type: "array", items: { $ref: "#/components/schemas/Budget" } }),
        },
      },
    },

    "/ai-budget/accounts/{userId}": {
      put: {
        operationId: "upsertAccountBudget",
        summary: "Create or update the budget ceiling for a specific account",
        tags: ["AI Budget"],
        parameters: [{ name: "userId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["monthlyLimitUsd"], properties: { monthlyLimitUsd: { type: "number" } } } } },
        },
        responses: {
          200: ok("Account budget updated.", { $ref: "#/components/schemas/Budget" }),
        },
      },
      delete: {
        operationId: "deleteAccountBudget",
        summary: "Remove the per-account budget ceiling",
        tags: ["AI Budget"],
        parameters: [{ name: "userId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: ok("Budget removed.", { type: "object" }),
        },
      },
    },

    "/ai-budget/{tenantName}/spend": {
      get: {
        operationId: "getTenantSpend",
        summary: "Get current spend and budget state for a tenant",
        tags: ["AI Budget"],
        parameters: [{ name: "tenantName", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: ok("Spend data.", { $ref: "#/components/schemas/Budget" }),
          502: upstreamError(),
        },
      },
    },

    "/ai-budget/{tenantName}/litellm-key": {
      get: {
        operationId: "getTenantLiteLlmKey",
        summary: "Get LiteLLM virtual key metadata for a tenant (never the key value)",
        tags: ["AI Budget"],
        parameters: [{ name: "tenantName", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: ok("LiteLLM key metadata.", { type: "object" }),
          404: notFound("No LiteLLM key for this tenant."),
        },
      },
    },

    "/ai-budget/{tenantName}/litellm-key/revoke": {
      post: {
        operationId: "revokeTenantLiteLlmKey",
        summary: "Revoke the LiteLLM virtual key for a tenant",
        tags: ["AI Budget"],
        parameters: [{ name: "tenantName", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: ok("Key revoked.", { type: "object" }),
          502: upstreamError(),
        },
      },
    },

    // ------------------------------------------------------------------
    // Audit log
    // ------------------------------------------------------------------

    "/audit": {
      get: {
        operationId: "listAuditEntries",
        summary: "Query audit log entries with optional tenant filter and cursor pagination",
        tags: ["Audit"],
        parameters: [
          { name: "tenant", in: "query", schema: { type: "string" }, description: "Filter to a specific tenant." },
          { name: "limit", in: "query", schema: { type: "integer", default: 100, minimum: 1, maximum: 1000 }, description: "Maximum entries to return." },
          { name: "cursor", in: "query", schema: { type: "string" }, description: "Opaque cursor from a previous response for keyset pagination." },
        ],
        responses: {
          200: ok("Paginated audit entries.", paginated({ $ref: "#/components/schemas/AuditEntry" })),
        },
      },
    },

    // ------------------------------------------------------------------
    // Token usage
    // ------------------------------------------------------------------

    "/token-usage": {
      get: {
        operationId: "listTokenUsage",
        summary: "List token usage records",
        tags: ["Token Usage"],
        parameters: [
          { name: "tenant", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", default: 100 } },
        ],
        responses: {
          200: ok("Token usage records.", { type: "array", items: { $ref: "#/components/schemas/TokenUsage" } }),
        },
      },
    },

    // ------------------------------------------------------------------
    // Metrics
    // ------------------------------------------------------------------

    "/metrics/server": {
      get: {
        operationId: "getServerMetrics",
        summary: "Get latest server utilisation snapshot (CPU, memory, storage, active tenants)",
        tags: ["Metrics"],
        responses: {
          200: ok("Server utilisation snapshot.", {
            type: "object",
            required: ["cpuPercent", "memoryUsedBytes", "memoryTotalBytes", "storageUsedBytes", "storageTotalBytes", "activeTenants", "sampledAt"],
            properties: {
              cpuPercent: { type: "number", description: "CPU utilisation percentage (0–100)." },
              memoryUsedBytes: { type: "integer", format: "int64" },
              memoryTotalBytes: { type: "integer", format: "int64" },
              storageUsedBytes: { type: "integer", format: "int64" },
              storageTotalBytes: { type: "integer", format: "int64" },
              activeTenants: { type: "integer" },
              sampledAt: { type: "string", format: "date-time" },
            },
          }),
        },
      },
    },

    "/metrics/projection-drift": {
      get: {
        operationId: "getProjectionDriftMetrics",
        summary: "Get projection drift metrics with threshold evaluation and alert state",
        tags: ["Metrics"],
        responses: {
          200: ok("Projection drift metrics.", { $ref: "#/components/schemas/ProjectionDrift" }),
        },
      },
    },

    // ------------------------------------------------------------------
    // Auth — OIDC browser flow, device authorization grant, session introspection
    // Human operators: OIDC browser flow.
    // CLI operators: device authorization grant (oc auth login).
    // CI / automation: OPENCRANE_TOKEN env var (static bearer, no UI needed).
    // ------------------------------------------------------------------

    "/auth/me": {
      get: {
        operationId: "getAuthStatus",
        summary: "Return current auth mode and authenticated user identity (if any)",
        description: "No authentication required. Returns 200 with the current session or an anonymous identity when no session is established.",
        tags: ["Auth"],
        security: [],
        responses: {
          200: ok("Auth status.", {
            type: "object",
            required: ["mode", "authenticated"],
            properties: {
              mode: { type: "string", enum: ["oidc", "none"], description: "Active authentication mode for this instance." },
              authenticated: { type: "boolean" },
              user: {
                type: "object",
                nullable: true,
                properties: {
                  sub: { type: "string" },
                  email: { type: "string" },
                  name: { type: "string" },
                },
              },
            },
          }),
        },
      },
    },

    "/auth/pod-token": {
      post: {
        operationId: "exchangePodToken",
        summary: "Exchange the current OIDC session for a short-lived token to the caller's OpenClaw pod",
        description: "Single sign-on across the control plane and the tenant pod: requires an established OIDC session (cookie) and returns a short-lived, audience-bound token minted via the Kubernetes TokenRequest API for the caller's tenant. The token targets the OpenClaw pod's session audience (reachable at `ingressHost`) — it is NOT an `obot-gateway` token; Obot is called only from inside the pod. The tenant is resolved solely from the session's verified email, so a caller cannot obtain a token for another user's pod. Re-call before `expiresAt`; re-login only when the session itself expires. Returns 401 without a session, 403 when no tenant matches the session email, 409 when the pod has no ingress host yet or when the email maps to more than one tenant.",
        tags: ["Auth"],
        security: [],
        responses: {
          200: ok("Short-lived pod access token.", {
            type: "object",
            required: ["token", "expiresAt", "tenant", "ingressHost", "audience"],
            properties: {
              token: { type: "string", description: "Short-lived bearer token bound to the OpenClaw pod session audience." },
              expiresAt: { type: "string", format: "date-time", description: "ISO-8601 expiry reported by the API server." },
              tenant: { type: "string", description: "Resolved tenant (pod) name." },
              ingressHost: { type: "string", description: "Host to reach the tenant's OpenClaw pod session API." },
              audience: { type: "string", description: "Audience the token is bound to (the OpenClaw pod session, not obot-gateway)." },
            },
          }),
          401: ok("No authenticated session.", {
            type: "object",
            properties: { error: { type: "string" }, code: { type: "string" } },
          }),
          403: ok("Session has no email claim, or no tenant is provisioned for it.", {
            type: "object",
            properties: { error: { type: "string" }, code: { type: "string" } },
          }),
          409: ok("The tenant pod has no ingress host yet.", {
            type: "object",
            properties: { error: { type: "string" }, code: { type: "string" } },
          }),
        },
      },
    },

    "/auth/login": {
      get: {
        operationId: "startOidcLogin",
        summary: "Redirect the browser to the configured OIDC identity provider to start login",
        description: "Browser redirect — not intended for programmatic use. Returns 503 when OIDC is not configured.",
        tags: ["Auth"],
        security: [],
        parameters: [
          { name: "returnTo", in: "query", schema: { type: "string" }, description: "Path to redirect back to after a successful login." },
        ],
        responses: {
          302: { description: "Redirect to identity provider." },
          503: { description: "OIDC not configured.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    "/auth/callback": {
      get: {
        operationId: "completeOidcLogin",
        summary: "OIDC authorization callback — validates the response and establishes a session",
        description: "Called by the identity provider after a successful login. Redirects back to the SPA.",
        tags: ["Auth"],
        security: [],
        parameters: [
          { name: "code", in: "query", schema: { type: "string" } },
          { name: "state", in: "query", schema: { type: "string" } },
        ],
        responses: {
          302: { description: "Redirect back into the application." },
          503: { description: "OIDC not configured.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    "/auth/logout": {
      post: {
        operationId: "logout",
        summary: "Destroy the current session",
        description: "Invalidates the server-side session. Does not perform IdP-side logout (RP-initiated logout is out of scope for Phase 5).",
        tags: ["Auth"],
        security: [],
        responses: {
          204: { description: "Session destroyed." },
        },
      },
    },

    // ------------------------------------------------------------------
    // Device authorization grant (CLI login — RFC 8628-style)
    // ------------------------------------------------------------------

    "/auth/device": {
      post: {
        operationId: "requestDeviceCode",
        summary: "Initiate a CLI device authorization grant",
        description: "Returns a device code and short user code. The CLI prints the verificationUri for the operator to open in a browser. No credentials required.",
        tags: ["Auth"],
        security: [],
        responses: {
          200: ok("Device grant created.", { $ref: "#/components/schemas/DeviceGrant" }),
        },
      },
    },

    "/auth/device/activate": {
      get: {
        operationId: "activateDeviceCode",
        summary: "Activate a device grant in the browser (requires OIDC session)",
        description: "The operator opens this URL after a CLI login prompt. If no OIDC session is present the user is redirected to the identity provider first. On success an access token is created and the CLI poll endpoint unblocks.",
        tags: ["Auth"],
        security: [],
        parameters: [
          { name: "userCode", in: "query", required: true, schema: { type: "string" }, description: "Short user code from the CLI prompt (e.g. ABCD-1234)." },
        ],
        responses: {
          200: { description: "Grant activated. HTML confirmation page returned." },
          302: { description: "Redirect to OIDC login (no active session)." },
          404: { description: "User code not found or expired.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          503: { description: "OIDC not configured.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    "/auth/device/token": {
      get: {
        operationId: "pollDeviceToken",
        summary: "Poll for the access token after browser activation",
        description: "Returns 202 while pending, 200 with token when authorized, 410 when the grant has expired. The token is delivered exactly once.",
        tags: ["Auth"],
        security: [],
        parameters: [
          { name: "deviceCode", in: "query", required: true, schema: { type: "string" }, description: "Secret device code returned by POST /auth/device." },
        ],
        responses: {
          200: ok("Grant authorized — token ready.", {
            type: "object",
            required: ["status", "token"],
            properties: {
              status: { type: "string", enum: ["authorized"] },
              token: { type: "string", description: "Plain-text access token. Store in ~/.config/opencrane/credentials.json." },
            },
          }),
          202: ok("Grant still pending — continue polling.", {
            type: "object",
            required: ["status"],
            properties: { status: { type: "string", enum: ["pending"] } },
          }),
          410: { description: "Grant expired. Run `oc auth login` again.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    // ------------------------------------------------------------------
    // OpenAPI contract
    // ------------------------------------------------------------------

    "/openapi.json": {
      get: {
        operationId: "getOpenApiSpec",
        summary: "Retrieve the OpenAPI 3.1 specification for this API",
        tags: ["Meta"],
        security: [],
        responses: {
          200: {
            description: "OpenAPI 3.1 document.",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
  },
};
