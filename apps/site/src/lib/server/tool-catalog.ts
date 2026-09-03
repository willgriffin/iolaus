import { webMcpToolDefinitions } from '@happyvertical/smrt-virt-web';
import { opportunityDataSurfaceToolNames } from '$lib/opportunity-bulk-workflows';
import {
  commandCenterWebMcpDefinitions,
  jobSearchWebMcpToolDefinitions,
} from '$lib/webmcp';
import { listMcpTools } from './mcp-tools.js';

/**
 * Every tool name the signed-in owner can reach through this application:
 * the authenticated generated server-MCP catalog (plus its bounded
 * source-read extensions), the browser command-center WebMCP surface, and the
 * data-surface bulk workflows.
 *
 * The bulk workflows are deliberately not MCP or WebMCP tools -- they are
 * reachable only through their authenticated route -- but the owner
 * principal's allow-list is fail-closed, so their capability names must be
 * declared here or the actions could never pass assertToolAllowed.
 *
 * Derived from the manifest-backed catalogs at runtime rather than
 * hand-maintained so the owner principal's fail-closed allow-list can never
 * drift from what the MCP, WebMCP, and admin surfaces expose.
 */
export async function listOwnerToolNames(): Promise<string[]> {
  const mcpTools = await listMcpTools({ authenticated: true });
  const webMcpTools = commandCenterWebMcpDefinitions([
    ...webMcpToolDefinitions,
    ...jobSearchWebMcpToolDefinitions,
  ]);

  const names = new Set<string>();
  for (const tool of mcpTools) names.add(tool.name);
  for (const name of opportunityDataSurfaceToolNames) names.add(name);
  for (const definition of webMcpTools) {
    if ('name' in definition && typeof definition.name === 'string') {
      names.add(definition.name);
    }
  }
  return Array.from(names).sort((left, right) => left.localeCompare(right));
}
