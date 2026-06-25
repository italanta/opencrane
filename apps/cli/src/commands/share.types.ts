/** Options for `oc share grant`. */
export interface GrantOpts
{
  type: "mcp-server" | "skill-bundle";
  id: string;
  withUser?: string;
  withGroup?: string;
  scope?: "org" | "department" | "project" | "personal";
  note?: string;
  output: "table" | "json";
}

/** Options for `oc share list`. */
export interface ShareListOpts
{
  output: "table" | "json";
}
