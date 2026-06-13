import type { ToolEntry } from "./tools-markdown.types.js";

/**
 * Header re-stamped at the top of every generated `TOOLS.md`. States that the
 * file is platform-managed so neither the tenant nor the agent treats their own
 * edits as durable — the contract re-pull loop overwrites it when entitlements change.
 */
const _PREAMBLE = [
  "# TOOLS",
  "",
  "> Managed by OpenCrane — generated from this tenant's effective contract.",
  "> Edits are overwritten whenever entitlements change. Do not hand-edit.",
].join("\n");

/**
 * Render one tool list section (`## <title>`) as a markdown bullet list, sorted by
 * name for deterministic output. Falls back to an explicit "none" line when empty so
 * the agent can tell "nothing entitled" apart from "section missing".
 *
 * @param title   - Section heading (without the `##`).
 * @param entries - Entitled tools to list.
 * @param emptyNote - Italic line emitted when `entries` is empty.
 * @returns The rendered section as a markdown string.
 */
function _renderSection(title: string, entries: ToolEntry[], emptyNote: string): string
{
  // 1. Empty section — emit the heading plus an explicit "none" note so the absence
  //    is unambiguous to the agent rather than looking like a truncated file.
  if (entries.length === 0)
  {
    return `## ${title}\n\n_${emptyNote}_`;
  }

  // 2. Sort by name so the same entitlement set always renders byte-identically —
  //    the entrypoint diffs TOOLS.md by content, so non-deterministic order would
  //    cause spurious rewrites + SIGHUP reloads.
  const sorted = [...entries].sort(function _byName(a, b) { return a.name.localeCompare(b.name); });

  // 3. One bullet per tool; append the description only when present.
  const lines = sorted.map(function _bullet(entry)
  {
    const description = entry.description.trim();
    return description.length > 0 ? `- **${entry.name}** — ${description}` : `- **${entry.name}**`;
  });

  return `## ${title}\n\n${lines.join("\n")}`;
}

/**
 * Render the tenant's `TOOLS.md` workspace doc from its entitled MCP servers and
 * skills. Pure and deterministic: identical inputs always produce identical output
 * so the in-pod content diff only fires on a real entitlement change.
 *
 * @param servers - Entitled MCP servers (allow-decided by the grant compiler).
 * @param skills  - Entitled skill bundles (allow-decided by the grant compiler).
 * @returns The full `TOOLS.md` markdown document.
 */
export function _RenderToolsMarkdown(servers: ToolEntry[], skills: ToolEntry[]): string
{
  // 1. MCP servers the agent may reach through the Obot gateway (allow-decided).
  const mcpSection = _renderSection("MCP servers", servers, "No MCP servers are currently entitled.");

  // 2. Skills mounted into the agent workspace.
  const skillsSection = _renderSection("Skills", skills, "No skills are currently entitled.");

  // 3. Assemble with a trailing newline so POSIX tools (and git) treat it as a text file.
  return `${_PREAMBLE}\n\n${mcpSection}\n\n${skillsSection}\n`;
}
