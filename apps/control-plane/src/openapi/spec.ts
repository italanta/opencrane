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

const McpServerSchema = {
  type: "object" as const,
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    endpoint: { type: "string" },
    transport: { type: "string", enum: ["streamable-http", "sse", "websocket"] },
    grants: { type: "array", items: { type: "object" } },
    credentials: { type: "array", items: { type: "object" } },
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
    description: "Multi-tenant AI agent platform management API. All resources require bearer-token authentication unless noted.",
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
      Group: GroupSchema,
      SkillBundle: SkillBundleSchema,
      AuditEntry: AuditEntrySchema,
      AccessToken: AccessTokenSchema,
      ProviderKey: ProviderKeySchema,
      DatasetMembership: DatasetMembershipSchema,
      EffectiveContract: EffectiveContractSchema,
      ProjectionDrift: ProjectionDriftSchema,
      Budget: BudgetSchema,
      ThirdPartySource: ThirdPartySourceSchema,
      TokenUsage: TokenUsageSchema,
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
                  skills: { type: "array", items: { type: "string" } },
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
                  skills: { type: "array", items: { type: "string" } },
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
      put: {
        operationId: "upsertProviderKey",
        summary: "Create or update a provider API key",
        tags: ["Provider Keys"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["provider", "apiKey"],
                properties: { provider: { type: "string" }, apiKey: { type: "string" } },
              },
            },
          },
        },
        responses: {
          200: ok("Key updated.", { $ref: "#/components/schemas/ProviderKey" }),
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
