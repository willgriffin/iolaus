import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCPGenerator } from '@happyvertical/smrt-core/generators/mcp';
import '../src/lib/objects/index.js';
import {
  getAppConfig,
  getConfiguredMcpServerName,
} from '../src/lib/server/app-config.js';
import { getDbConfig } from '../src/lib/server/db.js';

const appDir = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(appDir, '..', '.smrt', 'mcp-server', 'index.js');
const serverName = getConfiguredMcpServerName();

const generator = new MCPGenerator(
  {
    name: serverName,
    version: '0.1.0',
    description: `SMRT MCP server for ${getAppConfig().appName} employment-search data.`,
  },
  {
    db: getDbConfig(),
  },
);

await generator.generateServer({
  outputPath,
  serverName,
  serverVersion: '0.1.0',
  generateReadme: true,
});

console.log(`Generated MCP server at ${outputPath}`);
