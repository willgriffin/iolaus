#!/usr/bin/env node
/**
 * Iolaus stdio MCP bridge — proxies the app's HTTP MCP
 * surface (`/api/mcp/tools` + `/api/mcp/call`) to a local stdio MCP server.
 * Now backed by `@happyvertical/smrt-app-cli`'s bridge instead of a
 * hand-rolled server.
 */
import { createAppCli } from '@happyvertical/smrt-app-cli';
import { getCliAppId, getCliConfigDirectory } from './app-config.js';

const appId = getCliAppId();

await createAppCli({
  configDir: getCliConfigDirectory(),
  defaultServerUrl: 'http://localhost:5173',
  envPrefix: 'IOLAUS',
  name: appId,
}).startMcpBridge({
  name: `${appId}-agent-employment-search`,
  version: '0.1.0',
});
