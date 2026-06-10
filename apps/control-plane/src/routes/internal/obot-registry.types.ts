/**
 * Data shapes for the Obot /v0.1/servers registry wire format.
 *
 * Obot is configured via `OBOT_SERVER_PROVIDER_REGISTRIES` to poll the
 * control-plane and sync available MCP servers into its own catalog.
 *
 * @see https://docs.obot.ai/configuration/mcp-servers for the upstream spec.
 */

/**
 * A single MCP server entry in the Obot registry response.
 *
 * Obot uses this shape to populate its internal server catalog.
 * Only `Active` McpServer rows are emitted; draft/inactive servers are
 * excluded so tenants cannot reference unavailable endpoints.
 */
export interface ObotRegistryItem
{
  /** Stable identifier that Obot uses to deduplicate catalog entries across polls. */
  id: string;

  /** Human-readable display name shown in the Obot UI. */
  name: string;

  /** Short description surfaced to users browsing available MCP servers. */
  description: string;

  /**
   * Remote transport definitions for this server.
   * Each entry maps a label to the reachable MCP endpoint URL.
   * Omit when the server is not yet published or has no routable endpoint.
   */
  remotes?: Array<{
    /** Label shown in Obot for this transport (typically matches `name`). */
    name: string;
    /** Fully-qualified URL of the MCP server endpoint. */
    url: string;
  }>;

  /**
   * When true, Obot prompts the user to supply configuration before the
   * server can be used (e.g. API keys or workspace identifiers).
   */
  configurationRequired?: boolean;

  /** Instructional text shown to the user when `configurationRequired` is true. */
  configurationMessage?: string;
}

/**
 * Top-level envelope returned by `GET /v0.1/servers`.
 *
 * Obot expects cursor-based pagination.  The control-plane currently returns
 * all active servers in a single page (`cursor: null`); pagination can be
 * added later without breaking the contract because Obot stops when it sees
 * a null cursor.
 */
export interface ObotRegistryResponse
{
  /** The full list of available MCP server entries for this page. */
  items: ObotRegistryItem[];

  /**
   * Opaque pagination cursor for the next page.
   * Null signals that all entries have been returned.
   */
  cursor: string | null;
}
