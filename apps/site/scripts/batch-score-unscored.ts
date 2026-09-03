import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDbConfig } from '../src/lib/server/db.js';
import {
  OPPORTUNITY_INTELLIGENCE_ALLOWED_MODELS,
  resolveOpportunityIntelligenceAiProfileClient,
} from '../src/lib/server/ai-config.js';
import { processOpportunityIntelligence } from '../src/lib/server/opportunity-intelligence.js';
import '../src/lib/server/smrt.js';

const parsedLimit = Number.parseInt(process.env.BATCH_LIMIT ?? '', 10);
const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 25;
const modesEnv = process.env.BATCH_MODES ?? 'extract,score';
const modes =
  modesEnv === 'all'
    ? 'all'
    : modesEnv
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean);

// Pre-flight the same dedicated key/model gate used by queued intelligence.
const intelligence = await resolveOpportunityIntelligenceAiProfileClient();
console.log(
  `profile -> opportunity-intelligence=${intelligence?.model ?? 'NULL'}@${intelligence?.timeout ?? '?'}ms`,
);
if (!intelligence) {
  console.error(
    'AI client is null (missing BIFROST_OPPORTUNITY_INTELLIGENCE_API_KEY?). Aborting.',
  );
  process.exit(1);
}
if (
  !(OPPORTUNITY_INTELLIGENCE_ALLOWED_MODELS as readonly string[]).includes(
    intelligence.model,
  )
) {
  console.error(`Refusing unapproved model: ${intelligence.model}.`);
  process.exit(2);
}

const db = await resolveDatabase(getDbConfig());
const rows = await db.query(
  `SELECT o.id, o.title
     FROM opportunities o
    WHERE coalesce(o.description_raw,'') <> ''
      AND NOT EXISTS (SELECT 1 FROM evaluation_scores e WHERE e.opportunity_id = o.id)
    ORDER BY o.last_seen_at DESC NULLS LAST
    LIMIT ${limit}`,
);
const targets = rows.rows as Array<{ id: string; title: string }>;
console.log(`Processing ${targets.length} unscored opportunities (modes=${JSON.stringify(modes)})\n`);

let ok = 0;
let failed = 0;
for (const t of targets) {
  const started = Date.now();
  try {
    const res = await processOpportunityIntelligence({ opportunityId: t.id, modes });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const bad = Number(res.failed ?? 0) > 0 || res.status !== 'processed';
    bad ? failed++ : ok++;
    console.log(`[${bad ? 'FAIL' : 'ok'}] ${t.id} "${(t.title || '').slice(0, 50)}" -> ${res.status} (failed=${res.failed ?? 0}, ${secs}s) ${res.message}`);
  } catch (e) {
    failed++;
    console.log(`[ERR] ${t.id} -> ${e instanceof Error ? e.message : String(e)}`);
  }
}
console.log(`\nDone. ok=${ok} failed=${failed}`);
process.exit(0);
