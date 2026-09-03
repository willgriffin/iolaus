import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCPGenerator } from '@happyvertical/smrt-core/generators/mcp';
import '../src/lib/objects/index.js';
import { getDbConfig } from '../src/lib/server/db.js';

const appDir = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(appDir, '..', '.smrt', 'mcp-server', 'index.js');

const generator = new MCPGenerator(
  {
    name: 'iolaus-employment-search',
    version: '0.1.0',
    description: 'SMRT MCP server for iolaus.localhost employment-search data.',
  },
  {
    db: getDbConfig(),
  },
);

await generator.generateServer({
  outputPath,
  serverName: 'iolaus-employment-search',
  serverVersion: '0.1.0',
  generateReadme: true,
});

console.log(`Generated MCP server at ${outputPath}`);
