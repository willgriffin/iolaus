import '../src/lib/server/manifest-preload.js';
import { createHash } from 'node:crypto';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDbConfig } from '../src/lib/server/db.js';
import { ELIGIBILITY_BUCKETS, getOpportunityEligibility } from '../src/lib/opportunity-eligibility.js';
import { eligibilityRefreshSelectSql, eligibilityRefreshUpdateSql, verifiedOpportunityEligibilityProjection } from '../src/lib/server/opportunity-eligibility-refresh.js';

// Dry run by default. Applying requires the exact preview hash and source CAS.
const args = process.argv.slice(2);
function argument(name: string) { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
const apply = args.includes('--apply');
const limit = Number(argument('--limit') ?? 500);
const after = argument('--after') ?? '';
if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error('--limit must be 1..10000.');
if (args.some((arg) => arg.startsWith('--') && !['--apply', '--limit', '--after', '--expected-plan'].includes(arg))) throw new Error('Unknown argument.');
const db = await resolveDatabase(getDbConfig());
const result = await db.query(eligibilityRefreshSelectSql, [after, limit]);
const rows = Array.isArray(result) ? result : result.rows ?? [];
const plans = rows.map((row: Record<string, unknown>) => {
  const record = { sourceContentJson: row.source_content_json, sourceContentFingerprint: row.source_content_fingerprint,
    sourceContentVersion: row.source_content_version };
  const projection = verifiedOpportunityEligibilityProjection(record);
  const current = { ...record, ...projection };
  return { id: String(row.id), sourceJson: row.source_content_json, sourceFingerprint: row.source_content_fingerprint,
    sourceVersion: row.source_content_version, projection, buckets: getOpportunityEligibility(current).buckets,
    changed: projection.postingEligibilityJson !== row.posting_eligibility_json
      || projection.eligibilityFlags !== Number(row.eligibility_flags)
      || projection.eligibilitySourceFingerprint !== row.eligibility_source_fingerprint
      || projection.eligibilitySourceVersion !== Number(row.eligibility_source_version) };
});
const planHash = createHash('sha256').update(JSON.stringify(plans)).digest('hex');
const counts = Object.fromEntries(ELIGIBILITY_BUCKETS.map((bucket) => [bucket, plans.filter((plan) => plan.buckets.includes(bucket)).length]));
let applied = 0;
let sourceChanged = 0;
if (apply) {
  if (argument('--expected-plan') !== planHash) throw new Error('Preview plan changed or --expected-plan missing; run a fresh dry run.');
  for (const plan of plans.filter((plan) => plan.changed)) {
    const p = plan.projection;
    const updated = await db.query(eligibilityRefreshUpdateSql,
    [p.postingEligibilityJson, p.eligibilityFlags, p.eligibilitySourceFingerprint, p.eligibilitySourceVersion,
      plan.id, plan.sourceFingerprint, plan.sourceFingerprint, plan.sourceVersion, plan.sourceVersion, plan.sourceJson, plan.sourceJson]);
    const changedRows = Array.isArray(updated) ? updated : updated.rows ?? [];
    if (changedRows.length) applied++; else sourceChanged++;
  }
}
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', planHash, scanned: plans.length,
  changed: plans.filter((plan) => plan.changed).length, counts, applied, sourceChanged,
  missingSourceIdentity: plans.filter((plan) => !plan.sourceFingerprint || !plan.sourceVersion || !plan.sourceJson).length,
  nextAfter: plans.at(-1)?.id ?? after, limitReached: plans.length === limit,
  humanDecisions: 'untouched', providerCalls: 0 }, null, 2));
