import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptFactCandidate, createFactIntakeFromText } from './fact-workflow';

type MockRecord = Record<string, unknown> & {
  id: string;
  save: () => Promise<void>;
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
    get: vi.fn(
      async (id: string) => records.find((item) => item.id === id) ?? null,
    ),
    list: vi.fn(async () => records),
    records,
  };
}

const mocks = vi.hoisted(() => ({
  collections: new Map<string, ReturnType<typeof collection>>(),
  evidenceCreated: [] as MockRecord[],
  subjectsCreated: [] as MockRecord[],
}));

vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(async (className: string) => {
    const found = mocks.collections.get(className);
    if (!found) throw new Error(`Missing collection ${className}`);
    return found;
  }),
  getRequestScopedSmrtOptions: vi.fn(() => ({})),
}));

vi.mock('@happyvertical/smrt-facts', () => ({
  createFactEvidenceKey: vi.fn(() => 'evidence-key'),
  FactCollection: {
    create: vi.fn(async () => ({
      extractCandidatesFromText: vi.fn(async () => {
        throw new Error('no ai');
      }),
      reconcile: vi.fn(async ({ rawInput }: { rawInput: string }) => ({
        fact: { id: 'fact-1', textRefined: rawInput },
      })),
    })),
  },
  FactEvidenceCollection: {
    create: vi.fn(async () => ({
      create: vi.fn(async (payload: Record<string, unknown>) => {
        const created = record({ id: 'evidence-1', ...payload });
        mocks.evidenceCreated.push(created);
        return created;
      }),
    })),
  },
  FactSubjectCollection: {
    create: vi.fn(async () => ({
      create: vi.fn(async (payload: Record<string, unknown>) => {
        const created = record({ id: 'subject-1', ...payload });
        mocks.subjectsCreated.push(created);
        return created;
      }),
    })),
  },
}));

describe('fact intake workflow', () => {
  beforeEach(() => {
    mocks.collections.clear();
    mocks.evidenceCreated = [];
    mocks.subjectsCreated = [];
    mocks.collections.set('FactIntake', collection());
    mocks.collections.set('FactCandidate', collection());
  });

  it('stores raw snippets and fallback fact candidates for Will review', async () => {
    const result = await createFactIntakeFromText({
      rawText:
        'Built a multi-agent job search system. Integrated Kubernetes GitOps.',
      targetEntityId: 'opp-1',
      targetEntityType: 'Opportunity',
      user: { id: 'user-1' },
    });

    expect(result.intake).toMatchObject({
      createdByUserId: 'user-1',
      notes: JSON.stringify({
        extractionError: 'no ai',
        extractionMode: 'fallback',
      }),
      status: 'extracted',
      targetEntityId: 'opp-1',
    });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({
      reviewStatus: 'pending',
      targetEntityType: 'Opportunity',
    });
  });

  it('accepts a reviewed candidate into smrt-facts with evidence and subject links', async () => {
    mocks.collections.set(
      'FactIntake',
      collection([record({ id: 'intake-1', sourceKind: 'story' })]),
    );
    mocks.collections.set(
      'FactCandidate',
      collection([
        record({
          confidence: 0.8,
          factIntakeId: 'intake-1',
          id: 'candidate-1',
          reviewStatus: 'pending',
          sourceExcerpt: 'Built a multi-agent job search system.',
          statement: 'Will built a multi-agent job search system.',
          targetEntityId: 'opp-1',
          targetEntityType: 'Opportunity',
        }),
      ]),
    );

    const result = await acceptFactCandidate({
      candidateId: 'candidate-1',
      user: { id: 'user-1' },
    });

    expect(result.candidate).toMatchObject({
      createdFactId: 'fact-1',
      reviewedByUserId: 'user-1',
      reviewStatus: 'accepted',
    });
    expect(mocks.evidenceCreated[0]).toMatchObject({
      factId: 'fact-1',
      sourceKind: 'fact_intake',
      status: 'supports',
    });
    expect(mocks.subjectsCreated[0]).toMatchObject({
      entityId: 'opp-1',
      entityType: 'Opportunity',
      factId: 'fact-1',
    });
  });

  it('falls back to the candidate as evidence source when there is no fact intake', async () => {
    // FactCandidate without a factIntakeId (the model allows it): evidence must
    // not be written with an empty sourceId / misleading 'fact_intake' kind.
    mocks.collections.set('FactIntake', collection([]));
    mocks.collections.set(
      'FactCandidate',
      collection([
        record({
          confidence: 0.8,
          id: 'candidate-2',
          reviewStatus: 'pending',
          sourceExcerpt: 'Shipped a reusable CLI package.',
          statement: 'Will shipped a reusable CLI package.',
          targetEntityId: 'opp-2',
          targetEntityType: 'Opportunity',
        }),
      ]),
    );

    await acceptFactCandidate({
      candidateId: 'candidate-2',
      user: { id: 'user-1' },
    });

    expect(mocks.evidenceCreated[0]).toMatchObject({
      factId: 'fact-1',
      sourceId: 'candidate-2',
      sourceKind: 'fact_candidate',
    });
  });
});
