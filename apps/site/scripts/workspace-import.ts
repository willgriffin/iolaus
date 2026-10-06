// Import an exported private workspace into a hosted account, preserving
// ownership ids. Dry-run first; apply must present the reviewed plan digest.
// See docs/data-export-import.md. Output carries counts only, never content.
import '../src/lib/server/manifest-preload.js';
import '../src/lib/server/smrt.js';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDbConfig } from '../src/lib/server/db.js';
import { getResumeFilesystem } from '../src/lib/server/resume-files.js';
import {
  importWorkspace,
  rollbackWorkspaceImport,
} from '../src/lib/server/workspace-import.js';
import {
  driverCode,
  type TransferDatabase,
  WorkspaceTransferError,
} from '../src/lib/server/workspace-transfer.js';

const usage = `Usage: pnpm --filter @willgriffin/iolaus-site workspace:import -- --bundle DIR --email ADDRESS --dry-run
       pnpm --filter @willgriffin/iolaus-site workspace:import -- --bundle DIR --email ADDRESS --apply --expected-plan-sha256 DIGEST --receipt FILE
       pnpm --filter @willgriffin/iolaus-site workspace:import -- --rollback RECEIPT [--confirm-committed]

Options: --confirm-committed lets --rollback treat a receipt as committed when the
process died between the commit and the receipt marker; first confirm with
--dry-run that the bundle shows 0 inserts. --receipt must be a new file outside the bundle directory (the bundle is
deleted after the import; the receipt is what --rollback needs).
--deactivate-sources imports every source inactive (default keeps its
active state). The address must NOT already have an account with different ids;
keep it un-invited until the import is done, then run invite:add.`;

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const flags = new Set([
  '--apply',
  '--confirm-committed',
  '--deactivate-sources',
  '--dry-run',
]);
const values = new Set([
  '--bundle',
  '--email',
  '--expected-plan-sha256',
  '--receipt',
  '--rollback',
]);
for (const arg of args) {
  if (arg.startsWith('--') && !flags.has(arg) && !values.has(arg)) {
    console.error(`Unknown argument: ${arg}\n${usage}`);
    process.exit(2);
  }
}
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

try {
  const config = getDbConfig();
  const database = (await resolveDatabase(config)) as unknown as TransferDatabase;
  const dialect = config.type;
  const rollback = option('--rollback');
  if (rollback) {
    const result = await rollbackWorkspaceImport({
      confirmCommitted: args.includes('--confirm-committed'),
      database,
      dialect,
      filesystem: await getResumeFilesystem(),
      receiptPath: rollback,
    });
    console.log(JSON.stringify({ mode: result.databaseRolledBack ? 'rolled-back' : 'assets-only', ...result }, null, 2));
    process.exit(0);
  }
  const bundleDir = option('--bundle');
  const email = option('--email');
  const apply = args.includes('--apply');
  if (!bundleDir || !email || apply === args.includes('--dry-run')) {
    console.error(usage);
    process.exit(2);
  }
  const result = await importWorkspace({
    bundleDir,
    database,
    deactivateSources: args.includes('--deactivate-sources'),
    dialect,
    email,
    expectedPlanSha256: option('--expected-plan-sha256'),
    filesystem: await getResumeFilesystem(),
    mode: apply ? 'apply' : 'dry-run',
    receiptPath: option('--receipt'),
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.plan.eligible ? 0 : 2);
} catch (error) {
  console.error(
    error instanceof WorkspaceTransferError
      ? `${error.code}: ${error.message}`
      : `import failed (${driverCode(error)})`,
  );
  process.exit(1);
}
