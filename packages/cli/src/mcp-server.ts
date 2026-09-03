#!/usr/bin/env node
/**
 * iolaus.localhost stdio MCP bridge — proxies the deployed app's HTTP MCP
 * surface (`/api/mcp/tools` + `/api/mcp/call`) to a local stdio MCP server.
 * Now backed by `@happyvertical/smrt-app-cli`'s bridge instead of a
 * hand-rolled server.
 */
import { createAppCli } from '@happyvertical/smrt-app-cli';

await createAppCli({
  name: 'iolaus',
  configDir: 'iolaus.localhost',
  defaultServerUrl: 'http://localhost:5173',
}).startMcpBridge({
  name: 'iolaus-employment-search',
  version: '0.1.0',
});
