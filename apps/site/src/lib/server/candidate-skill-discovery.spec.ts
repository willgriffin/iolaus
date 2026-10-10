import type { DecisionResult } from '@happyvertical/ai';
import { getDatabase } from '@happyvertical/sql';
import { describe, expect, it, vi } from 'vitest';
import {
  type CandidateSkillDiscoveryDependencies,
  compareAndSwapSkillDiscovery,
  confirmCandidateSkillProposal,
  discoverCandidateSkills,
  dismissCandidateSkillProposal,
  loadCandidateSkillDiscovery,
} from './candidate-skill-discovery.js';
import {
  discoveryVocabulary,
  type PreparedSkillDiscovery,
  prepareSkillDiscovery,
  resolveSkillDiscovery,
} from './candidate-skill-discovery-engine.js';
import type { CandidateEvidenceSource } from './resume-data.js';

vi.mock('./application-workflow.js', () => ({
  withOpportunityLifecycleLock: async (
    _key: string,
    work: () => Promise<unknown>,
  ) => await work(),
  runOpportunityLifecycleTransaction: vi.fn(),
}));
vi.mock('./job-workspace-subject.js', () => ({
  JobWorkspaceSubjectError: class extends Error {},
  runAsRevalidatedJobWorkspaceSubject: vi.fn(),
}));
vi.mock('./private-workspace.js', () => ({
  requireWorkspaceSubject: (s: unknown) => s,
  getPrivateRecord: vi.fn(),
  listPrivateRecords: vi.fn(),
}));
vi.mock('./resume-data.js', () => ({
  loadWorkspaceCandidateEvidence: vi.fn(),
}));
vi.mock('./opportunity-intelligence-governance.js', () => ({
  startOpportunityIntelligenceAgentRun: vi.fn(),
  finishOpportunityIntelligenceAgentRun: vi.fn(),
  executeGovernedOpportunityIntelligenceRequest: vi.fn(),
  attachOpportunityIntelligenceInvocationMetadata: (e: unknown) => e,
}));
const subject = { tenantId: 't', userId: 'u', profileId: 'p' };
const evidence: CandidateEvidenceSource[] = [
  {
    id: 'project:ts',
    title: 'Shipped project',
    kind: 'project',
    text: 'I built a TypeScript and Node.js production application.',
  },
  {
    id: 'skill-experience:p',
    title: 'Private verified note',
    kind: 'candidate_profile',
    text: 'TypeScript and Node.js are my equal primary skills; Java and Python I only dabbled in.',
  },
];
function answers(
  prepared: PreparedSkillDiscovery,
  level: 0 | 1 | 2 = 2,
  none = false,
): DecisionResult {
  return {
    answers: Object.fromEntries(
      Object.entries(prepared.request.questions).map(([key, q]) => {
        if (q.type === 'score')
          return [
            key,
            {
              type: 'score',
              score: level,
              levels: q.criteria,
              confidence: 0.95,
              probabilities: Object.fromEntries(
                q.criteria.map((_, i) => [String(i), i === level ? 1 : 0]),
              ),
            },
          ];
        if (q.type !== 'choice') throw new Error('bad fixture');
        const choice = none ? 'none' : 'g0';
        return [
          key,
          {
            type: 'choice',
            choice,
            confidence: 0.95,
            probabilities: Object.fromEntries(
              Object.keys(q.criteria).map((id) => [id, id === choice ? 1 : 0]),
            ),
          },
        ];
      }),
    ),
  } as DecisionResult;
}
function fixture(labels = ['TypeScript', 'Node.js', 'Python']) {
  let profile: Record<string, unknown> = {
    id: 'p',
    tenantId: 't',
    ownerUserId: 'u',
    active: true,
    title: 'Engineer',
    summary: '',
    factsJson: JSON.stringify({
      version: 1,
      facts: {
        skillExperience: {
          value: evidence[1]!.text,
          provenance: 'user_verified',
        },
      },
    }),
    preferencesJson: JSON.stringify({ custom: true }),
  };
  let rows = [...evidence];
  const saved = new Map<string, ReturnType<typeof resolveSkillDiscovery>>();
  const evaluate = vi.fn(async (prepared: PreparedSkillDiscovery) => {
    const requestId = `request-${saved.size}`;
    const proposals = resolveSkillDiscovery(prepared, answers(prepared, 2));
    saved.set(requestId, proposals);
    return { requestId, proposals };
  });
  const deps: CandidateSkillDiscoveryDependencies = {
    runFresh: (async (s, _permission, work) =>
      await work(s, {
        assertOperation: async () => {},
      } as never)) as CandidateSkillDiscoveryDependencies['runFresh'],
    profile: async () => profile,
    evidence: async () => ({
      evidence: structuredClone(rows),
      candidate: {} as never,
      fingerprint: 'fixture',
      subject,
    }),
    postings: async () =>
      labels.map((label, id) => ({
        id: String(id),
        requiredSkills: JSON.stringify([label]),
        preferredSkills: '[]',
      })),
    acceptedFacts: async () => [],
    compareAndSwap: async (_s, prior, facts, preferences) => {
      if (
        prior.factsJson !== profile.factsJson ||
        prior.preferencesJson !== profile.preferencesJson
      )
        return false;
      profile = { ...profile, factsJson: facts, preferencesJson: preferences };
      return true;
    },
    evaluate: evaluate as never,
    startRun: async () => 'run',
    finishRun: async () => {},
    fits: () => ({ fits: true }) as never,
    verify: async (_s, _prepared, id) => saved.get(id) ?? [],
  };
  return {
    deps,
    evaluate,
    profile: () => profile,
    edit: (updates: Record<string, unknown>) => {
      profile = { ...profile, ...updates };
    },
    setEvidence: (next: CandidateEvidenceSource[]) => {
      rows = next;
    },
  };
}
describe('typed complete skill discovery', () => {
  it('canonicalizes aliases and prioritizes explicit career vocabulary over unfamiliar posting labels', () => {
    const labels = discoveryVocabulary(evidence, [
      'NodeJS',
      'unfamiliar requirement',
    ]);
    expect(
      labels.filter((label) => label.toLowerCase().includes('node')),
    ).toHaveLength(1);
    expect(labels.indexOf('unfamiliar requirement')).toBeGreaterThan(
      labels.indexOf('TypeScript'),
    );
  });
  it('retains every evidence fact in bounded groups without truncation', () => {
    const rows = Array.from({ length: 201 }, (_, i) => ({
      ...evidence[0]!,
      id: `p${i}`,
      text: `${i}: ${'complete '.repeat(100)}`,
    }));
    const prepared = prepareSkillDiscovery(rows, ['TypeScript'], 'fp');
    expect(prepared.evidence).toEqual(rows);
    expect(Object.values(prepared.groups).flat()).toEqual(
      rows.map((_, i) => i),
    );
    expect(Object.keys(prepared.groups)).toHaveLength(12);
  });
  it('requires native witnesses and .85 semantic confidence for direct experience', () => {
    const prepared = prepareSkillDiscovery(evidence, ['TypeScript'], 'fp');
    expect(
      resolveSkillDiscovery(prepared, answers(prepared))[0]?.classification,
    ).toBe('direct');
    expect(
      resolveSkillDiscovery(prepared, answers(prepared, 2, true))[0]
        ?.classification,
    ).toBe('unknown');
    const low = answers(prepared);
    const score = low.answers.s0!;
    if (score.type === 'score') score.confidence = 0.84;
    expect(resolveSkillDiscovery(prepared, low)[0]?.classification).toBe(
      'unknown',
    );
  });
  it('explicit private dabbling prevents direct Python or Java promotion while TypeScript/Node remain direct', () => {
    const prepared = prepareSkillDiscovery(
      evidence,
      ['TypeScript', 'Node.js', 'Python', 'Java'],
      'fp',
    );
    expect(
      resolveSkillDiscovery(prepared, answers(prepared)).map(
        (row) => row.classification,
      ),
    ).toEqual(['direct', 'direct', 'unknown', 'unknown']);
    expect(
      resolveSkillDiscovery(prepared, answers(prepared, 1)).map(
        (row) => row.classification,
      ),
    ).toEqual(['introductory', 'introductory', 'introductory', 'introductory']);
  });
  it('rejects unknown choices, missing answers, malformed distributions and inconsistent scores', () => {
    const prepared = prepareSkillDiscovery(evidence, ['TypeScript'], 'fp');
    const bad = answers(prepared);
    const witness = bad.answers.w0_0!;
    if (witness.type === 'choice') witness.choice = 'foreign';
    expect(() => resolveSkillDiscovery(prepared, bad)).toThrow();
    const missing = answers(prepared);
    delete missing.answers.s0;
    expect(() => resolveSkillDiscovery(prepared, missing)).toThrow();
    const inconsistent = answers(prepared);
    const score = inconsistent.answers.s0!;
    if (score.type === 'score') score.score = 0;
    expect(() => resolveSkillDiscovery(prepared, inconsistent)).toThrow(
      'inconsistent',
    );
  });
});
describe('private discovery workflow', () => {
  it('discovers privately, confirms exact evidence with native proof, keeps siblings current and retries idempotently', async () => {
    const f = fixture();
    const result = await discoverCandidateSkills(subject, f.deps);
    expect(result.status).toBe('complete');
    expect(
      JSON.parse(String(f.profile().factsJson)).facts.confirmedSkills,
    ).toBeUndefined();
    const ts = result.proposals.find(
      (row) => row.canonicalLabel === 'typescript',
    )!;
    const first = await confirmCandidateSkillProposal(
      subject,
      { id: ts.id, expectedRevision: result.revision },
      f.deps,
    );
    expect(first.status).toBe('complete');
    expect(first.proposals.find((row) => row.id === ts.id)?.status).toBe(
      'confirmed',
    );
    const retry = await confirmCandidateSkillProposal(
      subject,
      { id: ts.id, expectedRevision: result.revision },
      f.deps,
    );
    expect(retry).toEqual(first);
    expect(
      JSON.parse(String(f.profile().factsJson)).facts.confirmedSkills,
    ).toHaveLength(1);
    expect(JSON.parse(String(f.profile().preferencesJson)).custom).toBe(true);
    const node = first.proposals.find(
      (row) => row.canonicalLabel === 'nodejs',
    )!;
    await confirmCandidateSkillProposal(
      subject,
      { id: node.id, expectedRevision: result.revision },
      f.deps,
    );
    expect(
      JSON.parse(String(f.profile().factsJson)).facts.confirmedSkills,
    ).toHaveLength(2);
  });
  it('rejects unknown inference and allows dismiss without canonical change', async () => {
    const f = fixture();
    const result = await discoverCandidateSkills(subject, f.deps);
    const python = result.proposals.find(
      (row) => row.canonicalLabel === 'python',
    )!;
    await expect(
      confirmCandidateSkillProposal(
        subject,
        { id: python.id, expectedRevision: result.revision },
        f.deps,
      ),
    ).rejects.toMatchObject({ status: 409 });
    const dismissed = await dismissCandidateSkillProposal(
      subject,
      { id: python.id, expectedRevision: result.revision },
      f.deps,
    );
    expect(
      dismissed.proposals.find((row) => row.id === python.id)?.status,
    ).toBe('dismissed');
    expect(
      JSON.parse(String(f.profile().factsJson)).facts.confirmedSkills,
    ).toBeUndefined();
  });
  it('blocks stale, foreign-owned, revoked and concurrent edits before mutation', async () => {
    const f = fixture();
    const result = await discoverCandidateSkills(subject, f.deps);
    const ts = result.proposals.find(
      (row) => row.canonicalLabel === 'typescript',
    )!;
    f.edit({ title: 'Changed' });
    await expect(
      confirmCandidateSkillProposal(
        subject,
        { id: ts.id, expectedRevision: result.revision },
        f.deps,
      ),
    ).rejects.toMatchObject({ status: 409 });
    f.edit({ ownerUserId: 'foreign' });
    await expect(
      loadCandidateSkillDiscovery(subject, f.deps),
    ).rejects.toMatchObject({ status: 403 });
    const concurrent = fixture();
    concurrent.deps.compareAndSwap = async () => false;
    await expect(
      discoverCandidateSkills(subject, concurrent.deps),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('rejects tampered proposal metadata when exact native receipt resolves differently', async () => {
    const f = fixture();
    const result = await discoverCandidateSkills(subject, f.deps);
    const ts = result.proposals.find(
      (row) => row.canonicalLabel === 'typescript',
    )!;
    const preferences = JSON.parse(String(f.profile().preferencesJson));
    preferences.skillDiscovery.proposals.find(
      (row: { id: string }) => row.id === ts.id,
    ).evidence[0].text = 'invented';
    f.edit({ preferencesJson: JSON.stringify(preferences) });
    await expect(
      confirmCandidateSkillProposal(
        subject,
        { id: ts.id, expectedRevision: result.revision },
        f.deps,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('revoked native permission fails before catalog or provider work', async () => {
    const f = fixture();
    f.deps.runFresh = (async () => {
      throw new Error('revoked native permission');
    }) as CandidateSkillDiscoveryDependencies['runFresh'];
    await expect(discoverCandidateSkills(subject, f.deps)).rejects.toThrow(
      'revoked native permission',
    );
    expect(f.evaluate).not.toHaveBeenCalled();
  });
  it('re-enters fresh permission and source currentness after awaited native proof', async () => {
    for (const change of ['title', 'career', 'permission']) {
      const f = fixture();
      const result = await discoverCandidateSkills(subject, f.deps);
      const ts = result.proposals.find(
        (row) => row.canonicalLabel === 'typescript',
      )!;
      const verify = f.deps.verify!;
      f.deps.verify = async (...args) => {
        const proof = await verify(...args);
        if (change === 'title') f.edit({ title: 'Changed during proof' });
        if (change === 'career')
          f.setEvidence([
            { ...evidence[0]!, text: 'Changed project during proof' },
            evidence[1]!,
          ]);
        if (change === 'permission')
          f.deps.runFresh = (async () => {
            throw new Error('revoked during proof');
          }) as CandidateSkillDiscoveryDependencies['runFresh'];
        return proof;
      };
      await expect(
        confirmCandidateSkillProposal(
          subject,
          { id: ts.id, expectedRevision: result.revision },
          f.deps,
        ),
      ).rejects.toThrow();
      expect(
        JSON.parse(String(f.profile().factsJson)).facts.confirmedSkills,
      ).toBeUndefined();
    }
  });
  it('runs one adaptive batch per action then resumes all vocabulary with complete evidence', async () => {
    const f = fixture(
      Array.from({ length: 31 }, (_, i) => `Posting capability ${i}`),
    );
    const first = await discoverCandidateSkills(subject, f.deps);
    expect(first.status).toBe('partial');
    expect(f.evaluate).toHaveBeenCalledTimes(1);
    expect(first.scope.assessedCount).toBe(8);
    const second = await discoverCandidateSkills(subject, f.deps);
    expect(second.scope.assessedCount).toBe(16);
    expect(f.evaluate).toHaveBeenCalledTimes(2);
    expect(first.scope.remainingCount).toBeGreaterThan(0);
  });
  it('accepts complete 2606 owned posting catalog and only accepted CandidateProfile facts', async () => {
    const f = fixture();
    f.deps.postings = async () =>
      Array.from({ length: 2606 }, (_, i) => ({
        id: String(i),
        requiredSkills: '["TypeScript"]',
        preferredSkills: '[]',
      }));
    f.deps.acceptedFacts = async () => [
      {
        id: 'yes',
        tenantId: 't',
        ownerUserId: 'u',
        candidateProfileId: 'p',
        targetEntityType: 'CandidateProfile',
        targetEntityId: 'p',
        reviewStatus: 'accepted',
        statement: 'Shipped Rust.',
      },
      {
        id: 'no',
        tenantId: 't',
        ownerUserId: 'u',
        candidateProfileId: 'p',
        targetEntityType: 'Opportunity',
        targetEntityId: 'job',
        reviewStatus: 'accepted',
        statement: 'Requires Swift.',
      },
    ];
    const result = await discoverCandidateSkills(subject, f.deps);
    expect(result.proposals.some((row) => row.canonicalLabel === 'rust')).toBe(
      true,
    );
    expect(result.proposals.some((row) => row.canonicalLabel === 'swift')).toBe(
      false,
    );
    expect(
      f.evaluate.mock.calls[0]?.[0].evidence.some(
        (row) => row.id === 'accepted-fact:yes',
      ),
    ).toBe(true);
  });
});
describe('native SQLite compare-and-swap', () => {
  it('atomically changes both exact profile columns, preserves foreign rows and rejects stale/foreign/inactive retries', async () => {
    const db = await getDatabase({
      type: 'sqlite',
      url: ':memory:',
      cache: false,
    });
    await db.query(
      'CREATE TABLE candidate_profiles(id TEXT,tenant_id TEXT,owner_user_id TEXT,active BOOLEAN,facts_json TEXT,preferences_json TEXT,updated_at TEXT,title TEXT,summary TEXT,name TEXT)',
    );
    await db.query(
      'INSERT INTO candidate_profiles(id,tenant_id,owner_user_id,active,facts_json,preferences_json,updated_at) VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP)',
      'p',
      't',
      'u',
      true,
      '{}',
      '{"custom":true}',
    );
    const prior = { factsJson: '{}', preferencesJson: '{"custom":true}' };
    expect(
      await compareAndSwapSkillDiscovery(
        db as never,
        subject,
        prior,
        '{"facts":{}}',
        '{"custom":true,"skillDiscovery":{}}',
      ),
    ).toBe(true);
    expect(
      await compareAndSwapSkillDiscovery(
        db as never,
        subject,
        prior,
        'bad',
        'bad',
      ),
    ).toBe(false);
    expect(
      await compareAndSwapSkillDiscovery(
        db as never,
        { ...subject, userId: 'foreign' },
        {
          factsJson: '{"facts":{}}',
          preferencesJson: '{"custom":true,"skillDiscovery":{}}',
        },
        'bad',
        'bad',
      ),
    ).toBe(false);
    await db.query(
      'UPDATE candidate_profiles SET title = ? WHERE id = ?',
      'Edited after evidence read',
      'p',
    );
    expect(
      await compareAndSwapSkillDiscovery(
        db as never,
        subject,
        {
          factsJson: '{"facts":{}}',
          preferencesJson: '{"custom":true,"skillDiscovery":{}}',
          title: '',
          summary: '',
          name: '',
        },
        'bad',
        'bad',
      ),
    ).toBe(false);
    const result = await db.query(
      'SELECT facts_json,preferences_json FROM candidate_profiles',
    );
    expect(result.rows[0]).toMatchObject({
      facts_json: '{"facts":{}}',
      preferences_json: '{"custom":true,"skillDiscovery":{}}',
    });
  });
});

it('discovers skills from non-technology career evidence without adding unrelated catalog skills', () => {
  const vocabulary = discoveryVocabulary(
    [
      {
        id: 'care',
        title: 'Care work',
        kind: 'candidate_profile',
        text: 'Provided patient care and maintained clinical documentation.',
      },
      {
        id: 'trade',
        title: 'Workshop',
        kind: 'project',
        text: 'Performed welding and equipment maintenance.',
      },
      {
        id: 'office',
        title: 'Office work',
        kind: 'candidate_profile',
        text: 'Responsible for bookkeeping and payroll.',
      },
    ],
    [],
  );
  expect(vocabulary).toEqual(
    expect.arrayContaining([
      'Patient care',
      'Clinical documentation',
      'Welding',
      'Equipment maintenance',
      'Bookkeeping',
      'Payroll',
    ]),
  );
  expect(vocabulary).not.toContain('TypeScript');
  expect(vocabulary).not.toContain('Medication administration');
});
