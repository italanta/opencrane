/** Effective-contract response returned to tenant runtimes. */
export interface EffectiveContractResponse
{
  /** Versioned awareness contract marker. */
  contractVersion: string;
  /** Stable hash of the compiled payload. */
  contractId: string;
  /** Tenant metadata included in the contract. */
  tenant: {
    /** Tenant name. */
    name: string;
    /** Tenant team, when configured. */
    team: string | null;
    /** Effective policy reference tracked by the operator. */
    policyRef: string | null;
  };
  /** Awareness compiler output and runtime hints. */
  awareness: {
    /** Citation format required by the runtime. */
    citationFormat: "inline" | "footnote";
    /** Dataset memberships available to the tenant. */
    memberships: {
      /** Organization dataset bindings. */
      org: string[];
      /** Department/team dataset bindings. */
      team: string[];
      /** Project dataset bindings. */
      project: string[];
      /** Personal dataset bindings. */
      personal: string[];
    };
    /** Compiled awareness decisions, when configured. */
    grants: Array<{
      /** Awareness payload identifier. */
      payloadId: string;
      /** Winning access result. */
      access: "allow" | "deny";
    }>;
  };
  /** Compiled MCP server access list. */
  mcp: {
    /** Endpoint used by runtimes to refresh effective contract state. */
    gateway: string;
    /** Allowed server inventory. */
    servers: Array<{
      /** Stable server identifier. */
      id: string;
      /** Display name. */
      name: string;
      /** Transport mode. */
      transport: string;
      /** Upstream endpoint. */
      endpoint: string;
    }>;
  };
  /** Compiled skill entitlement list. */
  skills: {
    /** Registry base URL used for runtime pulls. */
    registry: string;
    /** Allowed bundle metadata. */
    entitled: Array<{
      /** Stable bundle identifier. */
      id: string;
      /** Bundle name. */
      name: string;
      /** Bundle scope. */
      scope: string;
      /** Semantic version. */
      version: string;
      /** Digest pin. */
      digest: string;
    }>;
  };
}
