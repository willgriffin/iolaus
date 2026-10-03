import { createHash } from 'node:crypto';
import type { DecisionResult } from '@happyvertical/ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OPPORTUNITY_SCREENING_V1_VERSION,
  type OpportunityScreeningVersion,
  type PreparedOpportunityScreening,
  prepareOpportunityScreening,
} from './opportunity-screening.js';
import {
  loadCurrentOpportunityScreeningProjections,
  OPPORTUNITY_SCREENING_RECEIPT_FEATURE,
  OPPORTUNITY_SCREENING_RECEIPT_PROFILE,
} from './opportunity-screening-projection.js';
import { fingerprintOpportunitySourceContent } from './opportunity-source-content.js';

vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(() => {
    throw new Error('Projection unit must inject native profile boundary.');
  }),
}));
vi.mock('./db.js', () => ({ getDbConfig: () => ({}) }));
const subject = { profileId: 'profile', tenantId: 'tenant', userId: 'user' };
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
function decision(
  prepared: PreparedOpportunityScreening,
  mismatch = true,
): DecisionResult {
  return {
    model: 'jev-test',
    provenance: { provider: 'typesafe', model: 'jev-test' },
    answers: Object.fromEntries(
      Object.entries(prepared.request.questions).map(([key, question]) => {
        const yes =
          key.replace('__evidence', '') ===
          (mismatch ? 'role_mismatch' : 'role_relevant');
        if (question.type === 'predicate')
          return [key, { type: 'predicate', probability: yes ? 0.99 : 0.01 }];
        if (question.type !== 'choice')
          throw new Error('Unexpected screening question.');
        const selected = yes ? prepared.witnesses[0]!.id : 'none';
        const keys = Object.keys(question.criteria);
        return [
          key,
          {
            type: 'choice',
            choice: selected,
            confidence: 0.9,
            probabilities: Object.fromEntries(
              keys.map((key) => [
                key,
                key === selected ? 0.9 : 0.1 / (keys.length - 1),
              ]),
            ),
          },
        ];
      }),
    ),
  };
}
function fixture(
  opportunityId = 'opportunity',
  version?: OpportunityScreeningVersion,
) {
  const source = {
    descriptionRaw: 'Prepare tax returns as an accountant.',
    title: 'Accountant',
    locationNotes: 'Canada',
    workMode: 'remote',
  };
  const profile = {
    id: subject.profileId,
    tenantId: subject.tenantId,
    ownerUserId: subject.userId,
    active: true,
    targetWorkCountryJson: JSON.stringify({ code: 'CA', label: 'Canada' }),
    authorizedWorkCountriesJson: '[]',
    sponsorshipRequired: false,
    preferencesJson: JSON.stringify({
      targetRoles: ['Software engineer'],
      workModes: ['remote'],
    }),
  };
  const opportunity = {
    id: opportunityId,
    sourceContentJson: JSON.stringify(source),
    sourceContentFingerprint: fingerprintOpportunitySourceContent(source),
    sourceContentVersion: 1,
  };
  const prepared = prepareOpportunityScreening(
    { ...opportunity, profile },
    version ? { version } : {},
  );
  const expectedInput = hash({
    version: prepared.version,
    opportunityId,
    subject,
    prepared: prepared.inputFingerprint,
  });
  const row: Record<string, unknown> = {
    owner_request_id: 'request',
    result_request_id: 'request',
    request_id: 'request',
    result_key: 'native-key',
    request_key: 'native-key',
    agent_run_id: 'run',
    opportunity_id: opportunityId,
    content_fingerprint: opportunity.sourceContentFingerprint,
    input_fingerprint: expectedInput,
    feature: OPPORTUNITY_SCREENING_RECEIPT_FEATURE,
    profile: OPPORTUNITY_SCREENING_RECEIPT_PROFILE,
    model: 'jev-test',
    prompt_version: prepared.version,
    output_schema_version: prepared.version,
    prepared_payload_version: prepared.version,
    result_status: 'completed',
    request_status: 'succeeded',
    accounting_basis: 'actual',
    actual_total_tokens: 99,
    reserved_input_tokens: prepared.requestBytes,
    requested_max_output_tokens: prepared.maxOutputTokens,
    reserved_spend_micros: 100,
    tenant_id: subject.tenantId,
    owner_user_id: subject.userId,
    candidate_profile_id: subject.profileId,
    request_tenant_id: subject.tenantId,
    request_owner_user_id: subject.userId,
    request_candidate_profile_id: subject.profileId,
    run_tenant_id: subject.tenantId,
    run_owner_user_id: subject.userId,
    run_candidate_profile_id: subject.profileId,
    run_opportunity_id: opportunityId,
    run_calls: 0,
    run_tokens: 0,
    run_spend: 0,
    run_actual_calls: 1,
    run_actual_tokens: 50,
    run_actual_output_tokens: 49,
    run_actual_spend: 99,
    run_call_limit: 4,
    run_token_limit: 80000,
    run_spend_limit: 100000,
    current_opportunity_id: opportunityId,
    current_source_content_json: opportunity.sourceContentJson,
    current_source_content_fingerprint: opportunity.sourceContentFingerprint,
    current_source_content_version: opportunity.sourceContentVersion,
    output_json: JSON.stringify(decision(prepared)),
  };
  const getProfile = vi.fn(async () => profile);
  const query = vi.fn(async (_sql: string, _params: unknown[]) => ({
    rows: [row],
  }));
  return {
    source,
    profile,
    opportunity,
    prepared,
    row,
    getProfile,
    query,
    deps: { getProfile, database: { query } },
  };
}
afterEach(() => vi.unstubAllEnvs());
describe('current owned coarse screening projections', () => {
  it('replays full native answers after reload with one profile read and one source/receipt join', async () => {
    vi.stubEnv('OPPORTUNITY_ASSESSMENT_DECISION_MODEL', 'jev-test');
    const f = fixture();
    const second = fixture('second');
    f.query.mockResolvedValue({ rows: [f.row, second.row] });
    const result = await loadCurrentOpportunityScreeningProjections(
      { opportunities: [f.opportunity, second.opportunity], subject },
      f.deps,
    );
    expect(result.size).toBe(2);
    expect(f.getProfile).toHaveBeenCalledTimes(1);
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(result.get('opportunity')).toMatchObject({
      mode: 'coarse_screen',
      status: 'clear_mismatch',
      excludeFromDefaultTriage: true,
      sourceStatus: 'current',
      evidence: [{ witness: { text: f.source.descriptionRaw } }],
    });
    expect(result.get('opportunity')).not.toHaveProperty('score');
    expect(result.get('opportunity')).not.toHaveProperty('fit');
    expect(f.query.mock.calls[0]?.[0]).toContain('JOIN agent_runs');
    expect(f.query.mock.calls[0]?.[0]).toContain('JOIN opportunities');
    for (const absent of [
      'q.prompt_version',
      'q.output_schema_version',
      'q.prepared_payload_version',
    ])
      expect(f.query.mock.calls[0]?.[0]).not.toContain(absent);
    expect(f.query.mock.calls[0]?.[0]).toContain(
      'r.prompt_version = r.output_schema_version',
    );
  });
  it('retains explicitly recorded V1 using its exact old request material', async () => {
    vi.stubEnv('OPPORTUNITY_ASSESSMENT_DECISION_MODEL', 'jev-test');
    const f = fixture('old', OPPORTUNITY_SCREENING_V1_VERSION);
    expect(
      (
        await loadCurrentOpportunityScreeningProjections(
          { opportunities: [f.opportunity], subject },
          f.deps,
        )
      ).get('old')?.requestId,
    ).toBe('request');
  });
  it('keeps source-relevant and materially uncertain outcomes visible without score or exclusion', async () => {
    vi.stubEnv('OPPORTUNITY_ASSESSMENT_DECISION_MODEL', 'jev-test');
    const f = fixture();
    f.row.output_json = JSON.stringify(decision(f.prepared, false));
    expect(
      (
        await loadCurrentOpportunityScreeningProjections(
          { opportunities: [f.opportunity], subject },
          f.deps,
        )
      ).get('opportunity'),
    ).toMatchObject({
      status: 'potentially_relevant',
      excludeFromDefaultTriage: false,
    });
    const uncertain = decision(f.prepared, false);
    uncertain.answers.unresolved_constraint = {
      type: 'predicate',
      probability: 0.99,
    };
    f.row.output_json = JSON.stringify(uncertain);
    expect(
      (
        await loadCurrentOpportunityScreeningProjections(
          { opportunities: [f.opportunity], subject },
          f.deps,
        )
      ).get('opportunity'),
    ).toMatchObject({ status: 'uncertain', excludeFromDefaultTriage: false });
  });
  it('denies every foreign, orphan, stale, failed, conservative, zero-usage or over-budget receipt', async () => {
    vi.stubEnv('OPPORTUNITY_ASSESSMENT_DECISION_MODEL', 'jev-test');
    const f = fixture();
    for (const patch of [
      { tenant_id: 'foreign' },
      { request_owner_user_id: 'foreign' },
      { run_candidate_profile_id: 'foreign' },
      { result_request_id: 'orphan' },
      { request_key: 'other' },
      { input_fingerprint: 'stale' },
      { current_source_content_version: 2 },
      { request_status: 'failed' },
      { result_status: 'failed' },
      { accounting_basis: 'conservative' },
      { actual_total_tokens: 0 },
      { run_actual_calls: 5 },
      { output_schema_version: 'invented' },
      { requested_max_output_tokens: 1 },
    ]) {
      f.query.mockResolvedValue({ rows: [{ ...f.row, ...patch }] });
      expect(
        (
          await loadCurrentOpportunityScreeningProjections(
            { opportunities: [f.opportunity], subject },
            f.deps,
          )
        ).size,
      ).toBe(0);
    }
  });
  it('fails profile material changes and rejects missing/malformed decision vectors rather than cached JSON claims', async () => {
    vi.stubEnv('OPPORTUNITY_ASSESSMENT_DECISION_MODEL', 'jev-test');
    const f = fixture();
    f.profile.preferencesJson = JSON.stringify({
      targetRoles: ['Accountant'],
      workModes: ['remote'],
    });
    expect(
      (
        await loadCurrentOpportunityScreeningProjections(
          {
            opportunities: [
              {
                ...f.opportunity,
                screeningProjection: { status: 'clear_mismatch' },
              },
            ],
            subject,
          },
          f.deps,
        )
      ).size,
    ).toBe(0);
    const original = fixture();
    const malformed = decision(original.prepared);
    delete malformed.answers.role_mismatch;
    original.row.output_json = JSON.stringify(malformed);
    expect(
      (
        await loadCurrentOpportunityScreeningProjections(
          { opportunities: [original.opportunity], subject },
          original.deps,
        )
      ).size,
    ).toBe(0);
    const invalid = decision(original.prepared);
    invalid.answers.role_mismatch__evidence = {
      type: 'choice',
      choice: 'invented',
      confidence: 0.99,
      probabilities: {},
    };
    original.row.output_json = JSON.stringify(invalid);
    expect(
      (
        await loadCurrentOpportunityScreeningProjections(
          { opportunities: [original.opportunity], subject },
          original.deps,
        )
      ).size,
    ).toBe(0);
  });
  it('holds inactive or foreign selected profiles before the receipt query', async () => {
    const f = fixture();
    f.profile.active = false;
    expect(
      (
        await loadCurrentOpportunityScreeningProjections(
          { opportunities: [f.opportunity], subject },
          f.deps,
        )
      ).size,
    ).toBe(0);
    expect(f.query).not.toHaveBeenCalled();
    f.profile.active = true;
    f.profile.ownerUserId = 'foreign';
    expect(
      (
        await loadCurrentOpportunityScreeningProjections(
          { opportunities: [f.opportunity], subject },
          f.deps,
        )
      ).size,
    ).toBe(0);
    expect(f.query).not.toHaveBeenCalled();
  });
  it('denies ambiguous duplicate current receipts and unexpected page IDs', async () => {
    vi.stubEnv('OPPORTUNITY_ASSESSMENT_DECISION_MODEL', 'jev-test');
    const f = fixture();
    f.query.mockResolvedValue({
      rows: [
        f.row,
        {
          ...f.row,
          request_id: 'second',
          owner_request_id: 'second',
          result_request_id: 'second',
        },
      ],
    });
    expect(
      (
        await loadCurrentOpportunityScreeningProjections(
          { opportunities: [f.opportunity], subject },
          f.deps,
        )
      ).size,
    ).toBe(0);
    f.query.mockResolvedValue({
      rows: [{ ...f.row, opportunity_id: 'unoffered' }],
    });
    expect(
      (
        await loadCurrentOpportunityScreeningProjections(
          { opportunities: [f.opportunity], subject },
          f.deps,
        )
      ).size,
    ).toBe(0);
  });
  it('bounds page queries without truncation or provider work', async () => {
    const f = fixture();
    await expect(
      loadCurrentOpportunityScreeningProjections(
        {
          opportunities: Array.from({ length: 101 }, (_, index) => ({
            id: `p${index}`,
          })),
          subject,
        },
        f.deps,
      ),
    ).rejects.toThrow('at most 100');
    expect(f.getProfile).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  });
});
