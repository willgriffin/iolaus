import type { DatabaseInterface } from '@happyvertical/sql';
import {
  ensureMatchingProjectionSchema,
  matchingProjectionSchemaReady,
} from './matching-projection-schema.js';

/** Explicit local setup only, after native schema migration, under its writer lease. */
export async function prepareLocalApplicationSchema(
  db: DatabaseInterface,
): Promise<void> {
  await ensureMatchingProjectionSchema(db, 'sqlite');
  await assertLocalApplicationSchemaReady(db);
}

/** Ordinary runtime startup is read-only: missing projections require explicit setup. */
export async function assertLocalApplicationSchemaReady(
  db: DatabaseInterface,
): Promise<void> {
  if (!(await matchingProjectionSchemaReady(db, 'sqlite'))) {
    throw new Error(
      'Local matching projection schema requires migration. Stop Iolaus and run pnpm app:setup before restarting.',
    );
  }
}
