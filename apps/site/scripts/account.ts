// Operator tool: finish or run a hosted account deletion, and list deletions
// that were started but did not complete. Idempotent; safe to re-run.
import '../src/lib/server/manifest-preload.js';
import '../src/lib/server/smrt.js';
import { detectEngine, resolveDatabase } from '@happyvertical/smrt-core';
import {
  AccountDeletionError,
  type AccountDeletionDatabase,
  deleteAccount,
  listIncompleteAccountDeletions,
} from '../src/lib/server/account-deletion.js';
import { getDbConfig } from '../src/lib/server/db.js';
import { getResumeFilesystem } from '../src/lib/server/resume-files.js';

const usage = `Usage: pnpm --filter @willgriffin/iolaus-site account:deletions
       pnpm --filter @willgriffin/iolaus-site account:delete -- --tenant-id ID --user-id ID
       pnpm --filter @willgriffin/iolaus-site account:delete -- --email ADDRESS
       pnpm --filter @willgriffin/iolaus-site account:delete -- --resume-all

account:delete is shared-hosted only and irreversible. It revokes the user's
invite, deletes their data and files, anonymizes their AI spend ledger rows and
records a non-PII audit row. Re-run it with the same ids to finish a deletion
that was interrupted (see account:deletions).`;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

const [command, ...rest] = process.argv.slice(2).filter((arg) => arg !== '--');
const database = (await resolveDatabase(
  getDbConfig(),
)) as unknown as AccountDeletionDatabase & { url?: string };
const dialect =
  database.url && detectEngine(database.url) === 'sqlite'
    ? 'sqlite'
    : 'postgres';

async function remove(tenantId: string, userId: string) {
  const result = await deleteAccount(
    { tenantId, userId },
    {
      database,
      dialect,
      filesystem: await getResumeFilesystem(),
      initiatedBy: 'operator',
    },
  );
  console.log(
    JSON.stringify({
      deletionId: result.deletionId,
      status: result.status,
      summary: result.summary,
    }),
  );
}

try {
  if (command === 'deletions' && rest.length === 0) {
    console.log(
      JSON.stringify(await listIncompleteAccountDeletions(database), null, 2),
    );
  } else if (command === 'delete') {
    if (rest.includes('--resume-all')) {
      for (const pending of await listIncompleteAccountDeletions(database)) {
        await remove(pending.tenantId, pending.userId);
      }
    } else {
      let tenantId = option(rest, '--tenant-id');
      let userId = option(rest, '--user-id');
      const email = option(rest, '--email');
      if (email && !(tenantId && userId)) {
        const found = (
          await database.query(
            `SELECT m.tenant_id AS "tenantId", u.id AS "userId"
               FROM users u JOIN memberships m ON m.user_id = u.id
              WHERE lower(u.email) = lower(?)`,
            [email],
          )
        ) as { rows?: Array<Record<string, unknown>> };
        const matches = found.rows ?? [];
        if (matches.length !== 1) {
          throw new Error(
            matches.length === 0
              ? 'No user found for that email.'
              : 'That email maps to several tenants; pass --tenant-id and --user-id.',
          );
        }
        tenantId = String(matches[0].tenantId);
        userId = String(matches[0].userId);
      }
      if (!tenantId || !userId) {
        console.error(usage);
        process.exitCode = 2;
      } else {
        await remove(tenantId, userId);
      }
    }
  } else {
    console.error(usage);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(
    error instanceof AccountDeletionError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error),
  );
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
