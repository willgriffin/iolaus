import { beforeEach, describe, expect, it } from 'vitest';
import {
  assertSyntheticDemoFixtureEnabled,
  seedSyntheticDemoFixture,
} from './synthetic-demo-fixture.js';

type Row = Record<string, unknown> & { id: string; save: () => Promise<void> };

function collection(rows: Row[]) {
  return {
    create: async (values: Record<string, unknown>) => {
      const record: Row = {
        ...values,
        id: `fixture-${rows.length + 1}`,
        save: async () => undefined,
      };
      rows.push(record);
      return record;
    },
    list: async (options: Record<string, unknown> = {}) => {
      const where = options.where as Record<string, unknown> | undefined;
      return rows.filter(
        (row) =>
          !where ||
          Object.entries(where).every(([key, value]) => row[key] === value),
      );
    },
  };
}

describe('synthetic demo fixture', () => {
  const environment = {
    IOLAUS_ENABLE_DEMO_FIXTURES: '1',
    NODE_ENV: 'development',
  };
  let rows: Record<string, Row[]>;

  beforeEach(() => {
    rows = Object.fromEntries(
      [
        'agentRuns',
        'applicationMaterialComments',
        'applications',
        'candidateProfiles',
        'companies',
        'decisions',
        'opportunities',
        'resumeAssets',
        'tasks',
      ].map((name) => [name, []]),
    );
  });

  function collections() {
    return Object.fromEntries(
      Object.entries(rows).map(([name, records]) => [
        name,
        collection(records),
      ]),
    ) as unknown as NonNullable<Parameters<typeof seedSyntheticDemoFixture>[0]>;
  }

  it('fails closed without explicit local-demo opt-in and always in production', () => {
    expect(() =>
      assertSyntheticDemoFixtureEnabled({ NODE_ENV: 'development' }),
    ).toThrow(/IOLAUS_ENABLE_DEMO_FIXTURES/);
    expect(() =>
      assertSyntheticDemoFixtureEnabled({
        IOLAUS_ENABLE_DEMO_FIXTURES: '1',
        NODE_ENV: 'production',
      }),
    ).toThrow(/production/);
  });

  it('creates a complete fictional workflow exactly once', async () => {
    const first = await seedSyntheticDemoFixture(collections(), environment);
    const second = await seedSyntheticDemoFixture(collections(), environment);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    for (const [name, records] of Object.entries(rows)) {
      expect(records, name).toHaveLength(1);
    }
    expect(rows.opportunities[0]).toMatchObject({
      descriptionRaw: expect.stringContaining('Fictional'),
      postingUrl: expect.stringContaining('example.invalid'),
    });
    expect(rows.applications[0].applicationUrl).toContain('example.invalid');
    expect(rows.resumeAssets[0].status).toBe('placeholder');
  });
});
