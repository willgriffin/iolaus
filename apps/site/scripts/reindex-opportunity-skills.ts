import '../src/lib/server/manifest-preload.js';
import '../src/lib/server/smrt.js';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDbConfig } from '../src/lib/server/db.js';
import {
  reindexOpportunitySkills,
  skillIndexCoverageHealthy,
} from '../src/lib/server/opportunity-skill-index.js';

const usage =
  'Usage: opportunities:reindex-skills --max N [--cursor TOKEN] [--apply] [--check]';
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const flags = new Set<string>();
const values = new Map<string, string>();
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--apply' || arg === '--check') {
    if (flags.has(arg)) throw new Error(usage);
    flags.add(arg);
  } else if (arg === '--max' || arg === '--cursor') {
    const value = args[++index];
    if (!value || value.startsWith('--') || values.has(arg)) throw new Error(usage);
    values.set(arg, value);
  } else throw new Error(usage);
}
if (!values.has('--max') || (flags.has('--apply') && flags.has('--check')))
  throw new Error(usage);

const database = await resolveDatabase(getDbConfig());
try {
  const result = await reindexOpportunitySkills(database, {
    max: Number(values.get('--max')),
    cursor: values.get('--cursor'),
    apply: flags.has('--apply'),
  });
  // Aggregate counts and opaque cursors only: no posting text, source payload, or IDs.
  console.log(JSON.stringify(result, null, 2));
  if (result.failed > 0) process.exitCode = 1;
  else if (flags.has('--check') && !skillIndexCoverageHealthy(result)) process.exitCode = 2;
} finally {
  await database.close?.();
}
