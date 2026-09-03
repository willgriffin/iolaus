import { resolveDatabase } from '@happyvertical/smrt-core';
import { resolveOpportunityIntelligenceAiProfileClient } from '../src/lib/server/ai-config.js';
import { getDbConfig } from '../src/lib/server/db.js';
import { processOpportunityIntelligence } from '../src/lib/server/opportunity-intelligence.js';
import '../src/lib/server/smrt.js';

// One-off re-extraction helper (modes=[extract]) over every opportunity with a
// posting. Uses the dedicated bounded opportunity-intelligence profile. Set
// REEXTRACT_ONLY_MISSING=1 to skip opps that already have responsibilities.
const intelligence = await resolveOpportunityIntelligenceAiProfileClient();
if (!intelligence) {
  console.error(
    'No opportunity intelligence client (missing BIFROST_OPPORTUNITY_INTELLIGENCE_API_KEY?).',
  );
  process.exit(2);
}
console.log(`profile model=${intelligence.model}`);
const onlyMissing = process.env.REEXTRACT_ONLY_MISSING === '1';
const db = await resolveDatabase(getDbConfig());
const rows = await db.query(
  `SELECT id, title FROM opportunities
    WHERE coalesce(description_raw,'') <> ''
      ${onlyMissing ? "AND coalesce(responsibilities,'') = ''" : ''}
    ORDER BY last_seen_at DESC NULLS LAST`,
);
const targets = rows.rows as Array<{ id: string; title: string }>;
console.log(`re-extracting ${targets.length} opportunities (modes=[extract])`);
let ok = 0;
let failed = 0;
for (const t of targets) {
  const started = Date.now();
  try {
    const res = await processOpportunityIntelligence({
      opportunityId: t.id,
      modes: ['extract'],
    });
    const bad = Number(res.failed ?? 0) > 0 || res.status !== 'processed';
    bad ? (failed += 1) : (ok += 1);
    console.log(
      `[${bad ? 'FAIL' : 'ok'}] "${(t.title || '').slice(0, 46)}" ${res.status} ${((Date.now() - started) / 1000).toFixed(0)}s`,
    );
  } catch (e) {
    failed += 1;
    console.log(`[ERR] ${t.id} ${e instanceof Error ? e.message : String(e)}`);
  }
}
console.log(`DONE ok=${ok} failed=${failed}`);
process.exit(0);
