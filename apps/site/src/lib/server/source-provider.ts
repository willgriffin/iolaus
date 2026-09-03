import type { resolveDatabase } from '@happyvertical/smrt-core';
import {
  isSourceProviderId,
  sourceProviderIds,
} from '../source-provider-ids.js';
import { detectJobBoard } from './opportunity-source-crawler.js';
import { getCollection } from './smrt.js';

type SmrtDatabase = Awaited<ReturnType<typeof resolveDatabase>>;

const MAX_PROVIDER_BACKFILL = 500;
export const SOURCE_PROVIDER_CHECK = 'sources_provider_check';
const persistedSourceProviderValues = [
  'unknown',
  ...sourceProviderIds,
] as const;

type MutableSource = Record<string, unknown> & {
  save: () => Promise<unknown>;
};

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function persistedSourceProvider(value: unknown): string {
  const provider = stringValue(value).toLowerCase();
  return isSourceProviderId(provider) ? provider : 'unknown';
}

export interface SourceProviderSchemaStatus {
  constraintDefinitionMatches: boolean;
  constraintPresent: boolean;
  constraintValidated: boolean;
  invalidProviders: number;
  providerRequired: boolean;
}

function normalizeProviderConstraint(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replaceAll('"', '')
    .replace(/::(?:text|character varying)/g, '')
    .replace(/[\s()]+/g, '');
}

function providerConstraintDefinitionMatches(value: unknown): boolean {
  const expected = normalizeProviderConstraint(
    `CHECK ((provider = ANY (ARRAY[${persistedSourceProviderValues
      .map((provider) => `'${provider}'::text`)
      .join(', ')}])))`,
  );
  return normalizeProviderConstraint(value) === expected;
}

export async function getSourceProviderSchemaStatus(
  db: SmrtDatabase,
): Promise<SourceProviderSchemaStatus> {
  const result = await db.query(
    `SELECT
       EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname = ? AND conrelid = 'sources'::regclass
       ) AS constraint_present,
       COALESCE((
         SELECT convalidated FROM pg_constraint
         WHERE conname = ? AND conrelid = 'sources'::regclass
       ), FALSE) AS constraint_validated,
       COALESCE((
         SELECT contype FROM pg_constraint
         WHERE conname = ? AND conrelid = 'sources'::regclass
       ), '') AS constraint_type,
       COALESCE((
         SELECT pg_get_constraintdef(oid) FROM pg_constraint
         WHERE conname = ? AND conrelid = 'sources'::regclass
       ), '') AS constraint_definition,
       COALESCE((
         SELECT attnotnull FROM pg_attribute
         WHERE attrelid = 'sources'::regclass AND attname = 'provider'
       ), FALSE) AS provider_required,
       (SELECT COUNT(*) FROM sources
        WHERE provider IS NULL OR provider NOT IN (${persistedSourceProviderValues.map(() => '?').join(', ')})) AS invalid_providers`,
    [
      SOURCE_PROVIDER_CHECK,
      SOURCE_PROVIDER_CHECK,
      SOURCE_PROVIDER_CHECK,
      SOURCE_PROVIDER_CHECK,
      ...persistedSourceProviderValues,
    ],
  );
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  return {
    constraintDefinitionMatches:
      row.constraint_type === 'c' &&
      providerConstraintDefinitionMatches(row.constraint_definition),
    constraintPresent: row.constraint_present === true,
    constraintValidated: row.constraint_validated === true,
    invalidProviders: Number(row.invalid_providers ?? 0),
    providerRequired: row.provider_required === true,
  };
}

export function sourceProviderSchemaIsReady(
  status: SourceProviderSchemaStatus,
): boolean {
  return (
    status.constraintPresent &&
    status.constraintValidated &&
    status.constraintDefinitionMatches &&
    status.providerRequired &&
    status.invalidProviders === 0
  );
}

/**
 * Persist adapter-declared identities for bounded legacy roots. Provider health
 * never re-detects from a URL or name at request time.
 */
export async function backfillSourceProviders(
  db: SmrtDatabase,
): Promise<{ classified: number; truncated: boolean; unknown: number }> {
  if (typeof db.transaction !== 'function') {
    throw new Error(
      'Source provider migration requires database transactions.',
    );
  }
  return await db.transaction(async (transaction) => {
    await transaction.query(
      `UPDATE sources
     SET provider = LOWER(BTRIM(provider)), updated_at = CURRENT_TIMESTAMP
     WHERE LOWER(BTRIM(provider)) IN (${sourceProviderIds.map(() => '?').join(', ')})
       AND provider IS DISTINCT FROM LOWER(BTRIM(provider))`,
      [...sourceProviderIds],
    );
    await transaction.query(
      `UPDATE sources
     SET provider = 'unknown', updated_at = CURRENT_TIMESTAMP
     WHERE provider IS NULL OR provider NOT IN (${persistedSourceProviderValues.map(() => '?').join(', ')})`,
      [...persistedSourceProviderValues],
    );
    const sources = await getCollection('Source', { db: transaction });
    const rows = (await sources.list({
      limit: MAX_PROVIDER_BACKFILL + 1,
      orderBy: 'created_at ASC',
      where: { sourceRole: 'root' },
    })) as unknown as MutableSource[];
    const truncated = rows.length > MAX_PROVIDER_BACKFILL;
    let classified = 0;
    let unknown = 0;

    for (const source of rows.slice(0, MAX_PROVIDER_BACKFILL)) {
      if (persistedSourceProvider(source.provider) !== 'unknown') continue;
      const detection = await detectJobBoard(source.url, {
        includeGeneric: true,
      }).catch(() => null);
      const provider = persistedSourceProvider(detection?.type);
      if (provider === 'unknown') {
        unknown += 1;
        continue;
      }
      source.provider = provider;
      await source.save();
      classified += 1;
    }
    await transaction.query(
      "ALTER TABLE sources ALTER COLUMN provider SET DEFAULT 'unknown'",
    );
    await transaction.query(
      'ALTER TABLE sources ALTER COLUMN provider SET NOT NULL',
    );
    await transaction.query(
      `ALTER TABLE sources DROP CONSTRAINT IF EXISTS ${SOURCE_PROVIDER_CHECK}`,
    );
    await transaction.query(
      `ALTER TABLE sources
       ADD CONSTRAINT ${SOURCE_PROVIDER_CHECK}
       CHECK (provider IN (${persistedSourceProviderValues.map((provider) => `'${provider}'`).join(', ')}))`,
    );
    const status = await getSourceProviderSchemaStatus(transaction);
    if (!sourceProviderSchemaIsReady(status)) {
      throw new Error('Source provider allowlist constraint is not ready.');
    }
    return { classified, truncated, unknown };
  });
}
