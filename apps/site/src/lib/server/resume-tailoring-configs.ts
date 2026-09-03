import { isDeepStrictEqual } from 'node:util';
import {
  CANONICAL_TAILORING_NAME,
  CANONICAL_TAILORING_SLUG,
  canonicalResumeTailoringConfig,
} from '@willgriffin/iolaus-resume';
import {
  parseTailoringConfigRecord,
  type ResumeRecord,
  type ResumeTailoringRecord,
} from './resume-data.js';
import { getCollection } from './smrt.js';

type MutableRecord = ResumeRecord & {
  save?: () => Promise<void>;
};

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The canonical `configJson` every database seeded before the seed-once
 * accessor (#417) holds: the old sync re-wrote the row from the code default
 * on every run, so it is byte-equal to that default as it stood before
 * `maxProjectsPerPosition` was raised from 2 to 5. Seed-once then stopped
 * touching existing rows, which means those databases never received the
 * raise. A stored config that deep-equals exactly this payload was never
 * edited by the owner and is upgraded to the current defaults once; anything
 * else is an owner edit and is left untouched.
 */
export const LEGACY_CANONICAL_TAILORING_DEFAULT = {
  excludeEducationTitles: ['Example Secondary School'],
  excludeSkillIds: ['vba'],
  maxAchievementsPerPosition: 2,
  maxProjectsPerPosition: 2,
  name: 'Canonical resume',
  outputSlug: 'canonical',
} as const;

function parseStoredConfig(record: MutableRecord): unknown {
  const raw = stringValue(record.configJson);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Idempotent one-time upgrade: replace the stored config with the current code
 * default only when it still equals {@link LEGACY_CANONICAL_TAILORING_DEFAULT}.
 * Returns whether the row was rewritten. `name`, `company`, and `active` are
 * never touched.
 */
async function migrateLegacyCanonicalDefault(
  record: MutableRecord,
): Promise<boolean> {
  const stored = parseStoredConfig(record);
  if (!isDeepStrictEqual(stored, LEGACY_CANONICAL_TAILORING_DEFAULT)) {
    return false;
  }
  record.configJson = JSON.stringify(canonicalResumeTailoringConfig);
  if (typeof record.save === 'function') await record.save();
  return true;
}

function canonicalTailoringPayload() {
  return {
    active: true,
    company: '',
    configJson: JSON.stringify(canonicalResumeTailoringConfig),
    configSlug: CANONICAL_TAILORING_SLUG,
    name: CANONICAL_TAILORING_NAME,
  };
}

async function findCanonicalRecord(): Promise<{
  collection: Awaited<ReturnType<typeof getCollection>>;
  existing: MutableRecord | undefined;
}> {
  const collection = await getCollection('ResumeTailoringConfig');
  const records = (await collection.list({
    limit: 1000,
  })) as unknown as MutableRecord[];
  const existing = records.find(
    (record) => stringValue(record.configSlug) === CANONICAL_TAILORING_SLUG,
  );
  return { collection, existing };
}

function toTailoringRecord(record: MutableRecord): ResumeTailoringRecord {
  return parseTailoringConfigRecord(
    JSON.parse(JSON.stringify(record)) as ResumeRecord,
  );
}

/**
 * Seed-once accessor for the canonical tailoring config.
 *
 * Creates the `canonical` row from the code defaults in
 * `@willgriffin/iolaus-resume` only when no such row exists. An existing row is
 * returned as stored — generating a resume must never overwrite the owner's
 * edits to `configJson`, `name`, `company`, or `active` — except for the
 * one-time upgrade of a row still holding the exact pre-seed-once default
 * (see {@link LEGACY_CANONICAL_TAILORING_DEFAULT}). Use
 * {@link resetCanonicalResumeTailoringConfig} to re-assert the defaults.
 */
export async function ensureCanonicalResumeTailoringConfig(): Promise<ResumeTailoringRecord> {
  const { collection, existing } = await findCanonicalRecord();
  if (existing) {
    await migrateLegacyCanonicalDefault(existing);
    return toTailoringRecord(existing);
  }

  const created = (await collection.create(
    canonicalTailoringPayload(),
  )) as unknown as MutableRecord;
  return toTailoringRecord(created);
}

/**
 * Re-asserts the code defaults onto the canonical tailoring config,
 * overwriting any stored edits. Creates the row when it is missing. Intended
 * for an explicit "reset to defaults" action, never as a side effect of
 * generating a resume.
 */
export async function resetCanonicalResumeTailoringConfig(): Promise<ResumeTailoringRecord> {
  const { collection, existing } = await findCanonicalRecord();
  const payload = canonicalTailoringPayload();
  const record =
    existing ??
    ((await collection.create(payload)) as unknown as MutableRecord);

  Object.assign(record, payload);
  if (typeof record.save === 'function') await record.save();

  return toTailoringRecord(record);
}
