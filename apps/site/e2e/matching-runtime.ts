import { basename, dirname, resolve } from 'node:path';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDbConfig } from '../src/lib/server/db.js';
import { ensureMatchingProjectionSchema } from '../src/lib/server/matching-projection-schema.js';
import { runMatchingTick } from '../src/lib/server/matching-projection-worker.js';
import { assertSyntheticDemoFixtureEnabled } from '../src/lib/server/synthetic-demo-fixture.js';

export async function refreshMatchingFixture() {
  assertSyntheticDemoFixtureEnabled();
  const config = getDbConfig();
  const directory = process.env.SMRT_DATA_DIR;
  if (
    process.env.SMRT_APP_ID !== 'iolaus-e2e' ||
    config.type !== 'sqlite' ||
    !directory ||
    !basename(dirname(directory)).startsWith('iolaus-mobile-e2e-') ||
    config.url !== resolve(directory, 'application.sqlite')
  )
    throw new Error(
      'The matching fixture requires a disposable SQLite runtime.',
    );
  const db = await resolveDatabase(config);
  await ensureMatchingProjectionSchema(db, 'sqlite');
  let idleTicks = 0;
  for (let tick = 0; tick < 100; tick += 1) {
    const result = await runMatchingTick(db, 'sqlite');
    if (
      result.sourceBacklog ||
      result.profileBacklog ||
      result.normalized ||
      result.evaluated
    )
      idleTicks = 0;
    // A tick can finish a keyset page or wrap its cursor before the next
    // profile becomes visible. There are two profiles in the browser fixture.
    else if (++idleTicks === 3) return;
  }
  throw new Error('Fictional matching backlog did not settle.');
}

if (process.argv.includes('--refresh')) await refreshMatchingFixture();
