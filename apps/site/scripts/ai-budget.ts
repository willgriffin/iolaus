// Operator tool: inspect or adjust per-user hosted-AI caps and usage.
import '../src/lib/server/manifest-preload.js';
import '../src/lib/server/smrt.js';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { runAiBudgetCommand } from '../src/lib/server/ai-budget-admin.js';
import {
  createAiUserSpendStore,
  resolveAiUsagePolicy,
} from '../src/lib/server/ai-usage-guard.js';
import { getDbConfig } from '../src/lib/server/db.js';

const database = await resolveDatabase(getDbConfig());
const policy = resolveAiUsagePolicy();
try {
  const lines = await runAiBudgetCommand(process.argv.slice(2), {
    defaults: {
      lifetimeCapMicros: policy.defaultLifetimeCapMicros,
      monthlyCapMicros: policy.defaultMonthlyCapMicros,
    },
    resolveEmail: async (email) => {
      const result = await database.query(
        `SELECT m.tenant_id AS "tenantId", u.id AS "userId"
         FROM users u JOIN memberships m ON m.user_id = u.id
         WHERE lower(u.email) = lower(?)`,
        [email],
      );
      return (result.rows as Array<Record<string, unknown>>).map((row) => ({
        tenantId: String(row.tenantId),
        userId: String(row.userId),
      }));
    },
    store: createAiUserSpendStore(database),
  });
  for (const line of lines) console.log(line);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
