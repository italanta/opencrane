/** A single entitled tool (MCP server or skill) rendered into `TOOLS.md`. */
export interface ToolEntry
{
  /** Stable catalog identifier (the grant payload id). */
  id: string;

  /** Human-readable name shown to the agent. */
  name: string;

  /** Short description of what the tool provides (may be empty). */
  description: string;
}
