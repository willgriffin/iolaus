import {
  CANONICAL_TAILORING_NAME,
  CANONICAL_TAILORING_SLUG,
  canonicalResumeTailoringConfig,
} from '@willgriffin/iolaus-resume';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureCanonicalResumeTailoringConfig,
  LEGACY_CANONICAL_TAILORING_DEFAULT,
  resetCanonicalResumeTailoringConfig,
} from './resume-tailoring-configs';

type MockRecord = Record<string, unknown> & {
  id: string;
  save: ReturnType<typeof vi.fn>;
};

function record(data: Record<string, unknown>): MockRecord {
  return {
    id: String(data.id ?? 'record-1'),
    save: vi.fn(async () => {}),
    ...data,
  } as MockRecord;
}

function collection(records: MockRecord[] = []) {
  return {
    create: vi.fn(async (payload: Record<string, unknown>) => {
      const created = record({
        id: `created-${records.length + 1}`,
        ...payload,
      });
      records.push(created);
      return created;
    }),
    list: vi.fn(async () => records),
    records,
  };
}

const mocks = vi.hoisted(() => ({
  collections: new Map<string, ReturnType<typeof collection>>(),
}));

vi.mock('./resume-data.js', () => ({
  parseTailoringConfigRecord: vi.fn((record: Record<string, unknown>) => ({
    ...record,
    config: JSON.parse(String(record.configJson ?? '{}')),
  })),
}));

vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(async (className: string) => {
    const found = mocks.collections.get(className);
    if (!found) throw new Error(`Missing collection ${className}`);
    return found;
  }),
}));

function editedCanonicalRecord() {
  return record({
    active: false,
    company: 'Acme',
    configJson: JSON.stringify({
      ...canonicalResumeTailoringConfig,
      excludeSkillIds: ['cobol'],
      maxProjectsPerPosition: 4,
    }),
    configSlug: CANONICAL_TAILORING_SLUG,
    id: 'canonical-1',
    name: 'My canonical',
  });
}

beforeEach(() => {
  mocks.collections.clear();
});

describe('ensureCanonicalResumeTailoringConfig', () => {
  it('seeds the canonical row from the code defaults when none exists', async () => {
    const configs = collection([
      record({ configSlug: 'backend', id: 'backend-1', name: 'Backend' }),
    ]);
    mocks.collections.set('ResumeTailoringConfig', configs);

    const result = await ensureCanonicalResumeTailoringConfig();

    expect(configs.create).toHaveBeenCalledTimes(1);
    expect(configs.create).toHaveBeenCalledWith({
      active: true,
      company: '',
      configJson: JSON.stringify(canonicalResumeTailoringConfig),
      configSlug: CANONICAL_TAILORING_SLUG,
      name: CANONICAL_TAILORING_NAME,
    });
    expect(result).toMatchObject({
      config: canonicalResumeTailoringConfig,
      configSlug: CANONICAL_TAILORING_SLUG,
      id: 'created-2',
    });
  });

  it('returns an existing canonical row unmodified', async () => {
    const existing = editedCanonicalRecord();
    const storedJson = existing.configJson;
    const configs = collection([existing]);
    mocks.collections.set('ResumeTailoringConfig', configs);

    const result = await ensureCanonicalResumeTailoringConfig();

    expect(configs.create).not.toHaveBeenCalled();
    expect(existing.save).not.toHaveBeenCalled();
    expect(existing).toMatchObject({
      active: false,
      company: 'Acme',
      configJson: storedJson,
      name: 'My canonical',
    });
    expect(result).toMatchObject({
      config: expect.objectContaining({
        excludeSkillIds: ['cobol'],
        maxProjectsPerPosition: 4,
      }),
      id: 'canonical-1',
      name: 'My canonical',
    });
  });
});

describe('ensureCanonicalResumeTailoringConfig legacy default migration', () => {
  it('upgrades a row still holding the exact pre-seed-once default to the current defaults', async () => {
    const legacy = record({
      active: true,
      company: '',
      // Key order differs from the constant on purpose: equality is structural.
      configJson: JSON.stringify({
        outputSlug: 'canonical',
        name: 'Canonical resume',
        maxProjectsPerPosition: 2,
        maxAchievementsPerPosition: 2,
        excludeSkillIds: ['vba'],
        excludeEducationTitles: ['Example Secondary School'],
      }),
      configSlug: CANONICAL_TAILORING_SLUG,
      id: 'canonical-legacy',
      name: 'Canonical resume',
    });
    const configs = collection([legacy]);
    mocks.collections.set('ResumeTailoringConfig', configs);

    const result = await ensureCanonicalResumeTailoringConfig();

    expect(LEGACY_CANONICAL_TAILORING_DEFAULT.maxProjectsPerPosition).toBe(2);
    expect(canonicalResumeTailoringConfig.maxProjectsPerPosition).not.toBe(
      LEGACY_CANONICAL_TAILORING_DEFAULT.maxProjectsPerPosition,
    );
    expect(configs.create).not.toHaveBeenCalled();
    expect(legacy.save).toHaveBeenCalledTimes(1);
    expect(legacy.configJson).toBe(
      JSON.stringify(canonicalResumeTailoringConfig),
    );
    expect(result.config).toEqual(canonicalResumeTailoringConfig);

    // Idempotent: a second call finds the current default and does nothing.
    await ensureCanonicalResumeTailoringConfig();
    expect(legacy.save).toHaveBeenCalledTimes(1);
  });

  it('leaves an owner-edited row untouched even when it differs only by the project cap', async () => {
    const edited = record({
      active: true,
      company: '',
      configJson: JSON.stringify({
        ...LEGACY_CANONICAL_TAILORING_DEFAULT,
        maxProjectsPerPosition: 4,
      }),
      configSlug: CANONICAL_TAILORING_SLUG,
      id: 'canonical-edited',
      name: 'Canonical resume',
    });
    const storedJson = edited.configJson;
    mocks.collections.set('ResumeTailoringConfig', collection([edited]));

    const result = await ensureCanonicalResumeTailoringConfig();

    expect(edited.save).not.toHaveBeenCalled();
    expect(edited.configJson).toBe(storedJson);
    expect(result.config).toMatchObject({ maxProjectsPerPosition: 4 });
  });

  it('does not save a row that already holds the current defaults', async () => {
    const current = record({
      active: true,
      company: '',
      configJson: JSON.stringify(canonicalResumeTailoringConfig),
      configSlug: CANONICAL_TAILORING_SLUG,
      id: 'canonical-current',
      name: CANONICAL_TAILORING_NAME,
    });
    mocks.collections.set('ResumeTailoringConfig', collection([current]));

    await ensureCanonicalResumeTailoringConfig();

    expect(current.save).not.toHaveBeenCalled();
  });

  it('ignores unparseable stored config instead of rewriting it', async () => {
    const broken = record({
      configJson: '{not json',
      configSlug: CANONICAL_TAILORING_SLUG,
      id: 'canonical-broken',
      name: CANONICAL_TAILORING_NAME,
    });
    mocks.collections.set('ResumeTailoringConfig', collection([broken]));

    await ensureCanonicalResumeTailoringConfig().catch(() => undefined);

    expect(broken.save).not.toHaveBeenCalled();
    expect(broken.configJson).toBe('{not json');
  });
});

describe('resetCanonicalResumeTailoringConfig', () => {
  it('re-asserts the code defaults onto an edited canonical row', async () => {
    const existing = editedCanonicalRecord();
    const configs = collection([existing]);
    mocks.collections.set('ResumeTailoringConfig', configs);

    const result = await resetCanonicalResumeTailoringConfig();

    expect(configs.create).not.toHaveBeenCalled();
    expect(existing.save).toHaveBeenCalledTimes(1);
    expect(existing).toMatchObject({
      active: true,
      company: '',
      configJson: JSON.stringify(canonicalResumeTailoringConfig),
      name: CANONICAL_TAILORING_NAME,
    });
    expect(result).toMatchObject({
      config: canonicalResumeTailoringConfig,
      id: 'canonical-1',
    });
  });

  it('creates the canonical row when it is missing', async () => {
    const configs = collection();
    mocks.collections.set('ResumeTailoringConfig', configs);

    const result = await resetCanonicalResumeTailoringConfig();

    expect(configs.create).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      config: canonicalResumeTailoringConfig,
      configSlug: CANONICAL_TAILORING_SLUG,
    });
  });
});
