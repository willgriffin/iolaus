import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  const subject = { tenantId: 'demo-tenant', userId: 'demo-owner' };
  const resumePath =
    'generated-resumes/iolaus-demo-fictional/resume-demo-tenant-demo-owner-fixture-1';
  let rows: Record<string, Row[]>;
  let fixtureFiles: Map<string, string | Buffer>;

  beforeEach(() => {
    fixtureFiles = new Map();
    rows = Object.fromEntries(
      [
        'agentRuns',
        'applicationMaterialComments',
        'applications',
        'candidateAnswers',
        'candidateProfiles',
        'companies',
        'decisions',
        'opportunities',
        'resumeAssets',
        'sourceCrawlItems',
        'sourceCrawls',
        'sources',
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

  function fixtureFilesystem() {
    return {
      write: vi.fn(async (path: string, content: string | Buffer) => {
        fixtureFiles.set(path, content);
      }),
    };
  }

  it('fails closed without explicit local-demo opt-in and outside local runtime', () => {
    expect(() =>
      assertSyntheticDemoFixtureEnabled({ NODE_ENV: 'development' }),
    ).toThrow(/IOLAUS_ENABLE_DEMO_FIXTURES/);
    expect(() =>
      assertSyntheticDemoFixtureEnabled(
        {
          IOLAUS_ENABLE_DEMO_FIXTURES: '1',
          NODE_ENV: 'production',
        },
        'cloud',
      ),
    ).toThrow(/outside the local runtime profile/);
    // NODE_ENV does not decide where records are written. A deployed runtime
    // must stay blocked even when a process is configured as development.
    expect(() =>
      assertSyntheticDemoFixtureEnabled(
        { IOLAUS_ENABLE_DEMO_FIXTURES: '1', NODE_ENV: 'development' },
        'cloud',
      ),
    ).toThrow(/outside the local runtime profile/);
  });

  it('rejects missing identity before touching storage', async () => {
    await expect(
      seedSyntheticDemoFixture(collections(), environment),
    ).rejects.toThrow(/tenant ID/);
    expect(Object.values(rows).flat()).toHaveLength(0);
  });

  it('never reuses private rows or resume files from another owner', async () => {
    const first = await seedSyntheticDemoFixture(collections(), environment, {
      subject,
      filesystem: fixtureFilesystem(),
    });
    const other = await seedSyntheticDemoFixture(collections(), environment, {
      subject: { tenantId: 'other-tenant', userId: 'other-owner' },
      filesystem: fixtureFilesystem(),
    });
    expect(other.profileId).not.toBe(first.profileId);
    expect(other.applicationId).not.toBe(first.applicationId);
    expect(rows.opportunities).toHaveLength(3);
    expect(rows.applications).toHaveLength(2);
    expect(
      new Set(rows.resumeAssets.map((row) => row.generatedPath)).size,
    ).toBe(2);
  });

  it('rejects a foreign profile selector before creating private records', async () => {
    const other = await seedSyntheticDemoFixture(collections(), environment, {
      subject: { tenantId: 'other-tenant', userId: 'other-owner' },
    });
    const before = Object.values(rows).flat().length;
    await expect(
      seedSyntheticDemoFixture(collections(), environment, {
        subject: { ...subject, profileId: other.profileId },
      }),
    ).rejects.toThrow(/selected demo profile/);
    expect(Object.values(rows).flat()).toHaveLength(before);
  });

  it('creates a complete fictional workflow exactly once', async () => {
    const filesystem = fixtureFilesystem();
    const first = await seedSyntheticDemoFixture(collections(), environment, {
      filesystem,
      subject,
    });
    const second = await seedSyntheticDemoFixture(collections(), environment, {
      filesystem,
      subject,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    for (const [name, records] of Object.entries(rows)) {
      expect(records, name).toHaveLength(
        ['opportunities', 'sourceCrawlItems'].includes(name) ? 3 : 1,
      );
    }
    expect(rows.sources[0]).toMatchObject({
      isActive: true,
      name: expect.stringContaining('fictional'),
      provider: 'ashby',
      sourceRole: 'root',
      url: 'https://example.invalid/iolaus-demo-ashby',
    });
    expect(rows.sourceCrawls[0]).toMatchObject({
      sourceId: rows.sources[0].id,
      status: 'completed',
      terminalCount: 3,
    });
    expect(rows.sourceCrawlItems).toHaveLength(3);
    expect(rows.sourceCrawlItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          opportunityId: rows.opportunities[0].id,
          sourceCrawlId: rows.sourceCrawls[0].id,
        }),
        expect.objectContaining({
          opportunityId: rows.opportunities[1].id,
          sourceCrawlId: rows.sourceCrawls[0].id,
        }),
        expect.objectContaining({
          opportunityId: rows.opportunities[2].id,
          sourceCrawlId: rows.sourceCrawls[0].id,
        }),
      ]),
    );
    expect(rows.opportunities[0]).toMatchObject({
      descriptionRaw: expect.stringContaining('Fictional'),
      descriptionSummary: expect.stringContaining('local-first employment'),
      employmentType: 'full_time',
      locations: 'Canada',
      postingUrl: expect.stringContaining('example.invalid'),
      preferredSkills: expect.stringContaining('WebMCP'),
      requiredSkills: expect.stringContaining('TypeScript'),
      seniority: 'principal',
      sourceId: rows.sources[0].id,
    });
    expect(rows.opportunities.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          freshness: 'fresh',
          requiredSkills: expect.stringContaining('TypeScript'),
          salaryMin: expect.any(Number),
        }),
      ]),
    );
    expect(rows.opportunities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          descriptionSummary: expect.stringContaining(
            'transparent agent controls',
          ),
          employmentType: 'full_time',
          locations: 'Canada\nUnited States',
          responsibilities: expect.stringContaining('user-reviewable'),
        }),
      ]),
    );
    expect(rows.applications[0]).toMatchObject({
      applicationUrl: expect.stringContaining('example.invalid'),
      sourceCrawlId: rows.sourceCrawls[0].id,
      sourceCrawlItemId: rows.sourceCrawlItems[0].id,
    });
    expect(rows.candidateAnswers[0]).toMatchObject({
      active: true,
      profileKey: 'iolaus-demo-fictional-candidate',
      value: expect.stringContaining('Fictional demo answer'),
    });
    expect(rows.resumeAssets[0]).toMatchObject({
      generatedPath: resumePath,
      markdownPath: `${resumePath}.md`,
      pdfPath: '',
      status: 'generated',
      textPath: `${resumePath}.txt`,
      title: 'Fictional demo resume — generated text',
    });
    expect(fixtureFiles.get(`${resumePath}.md`)).toContain(
      'Fictional Staff Software Engineer',
    );
    expect(fixtureFiles.get(`${resumePath}.txt`)).toContain(
      'must never be submitted to an employer',
    );
    expect(fixtureFiles.get(`${resumePath}.html`)).toContain('<pre>');
    expect(rows.opportunities[0].organizationProfileId).toBeFalsy();
    for (const name of [
      'agentRuns',
      'applicationMaterialComments',
      'applications',
      'candidateAnswers',
      'decisions',
      'resumeAssets',
      'tasks',
    ]) {
      for (const row of rows[name])
        expect(row).toMatchObject({
          tenantId: subject.tenantId,
          ownerUserId: subject.userId,
          candidateProfileId: rows.candidateProfiles[0].id,
        });
    }
    for (const row of rows.opportunities) {
      expect(row.humanReviewStatus).toBeUndefined();
      expect(row.ownerUserId).toBeUndefined();
      expect(row.candidateProfileId).toBeUndefined();
    }
    expect(rows.decisions[0].decision).toBe('accept_to_apply');
  });
});
