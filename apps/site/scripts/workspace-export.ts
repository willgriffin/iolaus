// Read-only export of one private workspace into a checksummed bundle.
// See docs/data-export-import.md. Output carries counts only, never content.
import { detectEngine, resolveDatabase } from '@happyvertical/smrt-core';
import { getResumeFilesystem } from '../src/lib/server/resume-files.js';
import { exportWorkspace } from '../src/lib/server/workspace-export.js';
import {
  type TransferDatabase,
  WorkspaceTransferError,
} from '../src/lib/server/workspace-transfer.js';

const usage = `Usage: pnpm --filter @willgriffin/iolaus-site workspace:export -- --out DIR [--tenant-id ID --user-id ID] [--no-assets]

The source database URL is read from WORKSPACE_EXPORT_DATABASE_URL (preferred,
keeps credentials out of the process list) or --database-url. The source asset
store comes from RESUME_FILES_CONFIG_JSON. The bundle contains private data:
keep it outside git in a 0700 directory and delete it after the import.`;

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const allowed = new Set([
  '--database-url',
  '--no-assets',
  '--out',
  '--tenant-id',
  '--user-id',
]);
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
for (const arg of args) {
  if (arg.startsWith('--') && !allowed.has(arg)) {
    console.error(`Unknown argument: ${arg}\n${usage}`);
    process.exit(2);
  }
}
const out = option('--out');
const url = process.env.WORKSPACE_EXPORT_DATABASE_URL ?? option('--database-url');
if (!out || !url) {
  console.error(usage);
  process.exit(2);
}

try {
  const dialect = detectEngine(url) === 'sqlite' ? 'sqlite' : 'postgres';
  const database = (await resolveDatabase({
    type: dialect,
    url,
  } as never)) as unknown as TransferDatabase;
  const result = await exportWorkspace({
    database,
    dialect,
    filesystem: args.includes('--no-assets')
      ? undefined
      : await getResumeFilesystem(),
    outDir: out,
    tenantId: option('--tenant-id'),
    userId: option('--user-id'),
  });
  console.log(JSON.stringify({ mode: 'exported', ...result }, null, 2));
  process.exit(0);
} catch (error) {
  console.error(
    error instanceof WorkspaceTransferError
      ? `${error.code}: ${error.message}`
      : 'export failed',
  );
  process.exit(1);
}
