import type { DecisionResult } from '@happyvertical/ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import capturedPending from './fixtures/ats/wealthsimple-source-coverage-pending.json';
import {
  buildRequirementCoverage,
  buildRequirementCoverageSource,
  type CoverageLedger,
  normalizeRequirementCoverageForAudit,
  type RequirementCoverageContext,
  requirementCoverageContextForOpportunity,
  validateRequirementCoverage,
  validateRequirementCoverageAuditAdmission,
} from './opportunity-requirement-coverage.js';
import {
  hasRecordedRequirementCoverageAudit,
  preflightRequirementCoverageAudit,
  preflightRequirementCoverageLifecycle,
  prepareRequirementCoverageAudit,
  readRecordedRequirementCoverageOutcome,
  requirementCoverageAuditReservationCeiling,
  requirementCoverageClauseQuestionKey,
  requirementCoverageHasLosslessWireClauses,
  requirementCoverageSourceDependencyFingerprint,
  resolveRequirementCoverageAudit,
  validateVerifiedRequirementCoverage,
} from './opportunity-requirement-coverage-provider.js';

const publicPosting =
  "Build something people love\nWealthsimple is Canada’s leading financial innovator. The company offers a full suite of simple, sophisticated financial products across managed investing, do-it-yourself trading, cryptocurrency, tax filing, spending and saving. Wealthsimple currently serves more than 4 million Canadians and holds over $155 billion in assets under administration. The company was founded in 2014 by a team of financial experts and technology entrepreneurs, and is headquartered in Toronto, Canada.\n\nWe're proud of what we've built — and we're just getting started. Read our Culture Manual and learn more about how we work .\n\nAbout the team\nWe build the products and infrastructure that millions of Canadians trust with their financial lives. Data & Engineering at Wealthsimple spans everything from the client-facing apps to the systems running underneath them — and we hold ourselves to a high bar on both. We move fast, but we build thoughtfully: quality, security, and scalability aren’t trade-offs here, they’re the standard.\nThe Production Engineering team sits within Platform Experience, on the boundary between Platform and Product. Our mandate is to raise reliability across Wealthsimple’s most critical flows — reducing incidents, helping service teams ship safely, and turning individual fixes into platform-wide improvements. We measure ourselves against two targets: 99.9% uptime on critical flows, and fewer than 1% of weekly active users experiencing errors in the app. If you want to work on hard problems with people who care deeply about craft, you’ll fit right in.\n \nAbout the role\nThis is a new role — one that doesn’t yet exist at Wealthsimple — and it’s a meaningful one. As a Staff Software Developer on Production Engineering, you’ll bring senior technical leadership to the work of making Wealthsimple more reliable at scale. You’ll work across platform and product teams, identify the highest-leverage reliability problems, and build solutions that don’t just fix the immediate issue but raise the floor for everyone. This isn’t a role where you sit in one corner of the codebase. It’s a role where you shape how engineering gets done across the company.\n \nWhat you’ll do\n\n- Improve the platform to prevent incidents — designing and driving adoption of guardrails, sensible defaults, and engineering standards that reduce the likelihood of failures across services\n\n- Build tooling that reduces time to mitigation when incidents occur, including contributing to our in-house product on AI-assisted incident response\n\n- Own the investigation and follow-through on load test findings — translating results into concrete reliability improvements across critical flows\n\n- Work across platform and product engineering teams as a technical influencer — participating in architecture and readiness reviews, coaching service owners, and driving adoption of scalable reliability practices\n\n- Identify recurring failure patterns and design platform-level fixes that prevent them from showing up again in a different service\n\n- Contribute to the team’s reliability syncs with product engineering, helping align on incident themes, critical-flow risks, and the next highest-leverage initiatives\n\n \nSkills you bring\n\n- 8+ years of software engineering experience, with significant time in platform, infrastructure, or SRE work\n\n- Demonstrated track record of improving reliability at scale — reducing incidents, building guardrails, or driving operational standards across multiple teams\n\n- Strong proficiency in backend systems and distributed architecture; you can diagnose complex failure modes across a service mesh\n\n- Experience with load testing and capacity planning, and the ability to translate findings into concrete engineering improvements\n\n- Proven ability to work across engineering teams as a technical influencer — driving adoption of standards and practices without direct authority\n\n- Familiarity with Kubernetes, Helm, Argo and modern deployment tooling\n\n- Strong written and verbal communication — comfortable presenting findings and recommendations to both engineering teams and senior leadership\n\n \nWho you are\n\n- You think in systems — you’re not looking for the fix, you’re looking for what caused the problem and how to make sure it doesn’t happen elsewhere\n\n- You’re comfortable working without direct authority; you build credibility through the quality of your thinking and the clarity of your recommendations\n\n- You hold a high bar for operational excellence without making it someone else’s problem to catch up to — you bring people along\n\n- You’re energised by ambiguity, not slowed down by it; you know how to prioritise when everything feels urgent\n\n- You’re curious about where AI-assisted tooling is headed in reliability engineering, and you want to help shape how we use it — not just observe it from a distance\n\nWhy Wealthsimple?\n🌸 Top-tier health benefits and life insurance\n📈 Long-term group savings with employer match, through Wealthsimple for Business\n🌴 20 vacation days, 4 wellness days, and unlimited sick and mental health days per year*\n✈️ 90 days away: work outside Canada for up to 90 days per year*\n👥 Employee resource groups, including Rainbow (2SLGBTQ), Women of WS, and Black at WS\n🌎 We are a hybrid team with over 1,500 employees across North America. The people are one of the best parts of working here: you'll collaborate with incredibly talented, curious, and driven teammates who are deeply committed to doing great work.\n\n*Unlimited paid sick days, Wellness Days and the 90 day away program do not apply to certain roles.\n\nICYMI\nTechnology & Innovation at Wealthsimple: We move quickly and build thoughtfully. That means we're always looking for better ways to work — whether that's new tools, AI, or rethinking how we approach a problem. We don't expect you to have all the answers, but we do expect curiosity and a willingness to evolve alongside the products we're building.\n\nInclusion Statement: We're building products for a diverse world, and we need a diverse team to do it well. We strongly encourage applications from everyone, regardless of race, religion, colour, national origin, gender, sexual orientation, age, marital status, or disability status.\n\nAccessibility Statement: We're committed to an accessible hiring experience. If you need any accommodations throughout the interview process, please let us know — we'll work with you to make sure you have what you need. We also welcome any feedback on how we can better accommodate candidates with accessibility needs.\n\nAI in Hiring: We may use artificial intelligence (AI) tools to support parts of our hiring process, such as reviewing applications, analyzing resumes, or assessing responses. These tools assist our team but don't replace human judgment – all final hiring decisions are made by people. If you have questions about how your data is used, reach out to us.";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@happyvertical/smrt-core', () => ({
  resolveDatabase: async () => ({ query: mocks.query }),
}));
vi.mock('./db.js', () => ({ getDbConfig: () => ({}) }));
vi.mock('./opportunity-intelligence-governance.js', () => ({
  executeGovernedOpportunityIntelligenceRequest: vi.fn(),
}));

function fixture() {
  const context: RequirementCoverageContext = {
    sourceText:
      'About the role\nDiagnose complex failure modes across a service mesh and prevent recurrence.\nApply now',
    sourceFingerprint: 'source-1',
    sourceVersion: 1,
    extractionFingerprint: 'extraction-1',
  };
  const ledger = buildRequirementCoverageSource(context);
  const duty = ledger.clauses[1]!;
  ledger.requirements = [
    {
      id: 'duty-1',
      text: duty.text,
      clauseIds: [duty.id],
      importance: 'unknown',
    },
  ];
  ledger.dispositions = ledger.clauses.map((clause, index) =>
    index === 1
      ? { clauseId: clause.id, type: 'role_duty', requirementIds: ['duty-1'] }
      : {
          clauseId: clause.id,
          type: 'nonrequirement',
          requirementIds: [],
          exclusionRule: index === 0 ? 'section_heading' : 'navigation_label',
        },
  );
  const prepared = prepareRequirementCoverageAudit(context, ledger);
  const result = {
    answers: Object.fromEntries(
      Object.keys(prepared.request.questions).map((key) => [
        key,
        { type: 'predicate', probability: 0.9 },
      ]),
    ),
  } as DecisionResult;
  ledger.audit = resolveRequirementCoverageAudit(prepared, result, 'receipt-1');
  return { context, ledger, prepared, result };
}

describe('source requirement coverage audit', () => {
  beforeEach(() => vi.resetAllMocks());

  it('binds full literal clause and qualifiers in each question, including exclusion review', () => {
    const { prepared, ledger } = fixture();
    expect(
      prepared.request.questions[
        requirementCoverageClauseQuestionKey(1, 'mapped')
      ].instructions,
    ).toContain('state.clauses.c1.text');
    expect(
      prepared.request.questions[
        requirementCoverageClauseQuestionKey(1, 'mapped')
      ].instructions,
    ).toContain('state.auditPolicy.mapped');
    expect(prepared.deterministicHeadingClauseIds).toEqual([
      ledger.clauses[0]!.id,
    ]);
    expect(
      prepared.request.questions[
        requirementCoverageClauseQuestionKey(0, 'nonmaterial')
      ],
    ).toBeUndefined();
    expect(ledger.audit!.probabilities[ledger.clauses[0]!.id]).toBeUndefined();
    expect(
      requirementCoverageHasLosslessWireClauses(prepared.context, ledger),
    ).toBe(true);
    expect(prepared.request.state).toMatchObject({
      auditPolicy: {
        mapped: expect.stringContaining('every qualifier'),
        nonmaterial: expect.stringContaining('NO candidate criterion'),
      },
      sourceClauseOrder: ['c0', 'c1', 'c2'],
      clauses: Object.fromEntries(
        ledger.clauses.map((clause, index) => [
          `c${index}`,
          { text: clause.text, kind: clause.kind, section: clause.section },
        ]),
      ),
      requirements: {
        r0: { text: ledger.requirements[0]!.text, clauseKeys: ['c1'] },
      },
    });
    expect(
      prepared.request.questions[
        requirementCoverageClauseQuestionKey(1, 'mapped')
      ].instructions,
    ).toContain('["r0"]');
    const preflight = preflightRequirementCoverageAudit(prepared);
    expect(preflight.requestBytes).toBe(
      Buffer.byteLength(JSON.stringify(prepared.request), 'utf8'),
    );
    expect(preflight.requestBytes).toBeLessThanOrEqual(
      requirementCoverageAuditReservationCeiling(
        prepared.context.sourceText,
        ledger.clauses.length,
      ).requestBytes,
    );
    expect(preflight.fits).toBe(true);
  });

  it('bounds the captured 42-clause 50-row request from the serialized pre-repair skeleton', () => {
    const context: RequirementCoverageContext = {
      sourceText: publicPosting,
      sourceFingerprint: 'captured-public-source',
      sourceVersion: 1,
      extractionFingerprint: 'captured-public-extraction',
    };
    const ledger = normalizeRequirementCoverageForAudit(
      context,
      buildRequirementCoverage(context, [capturedPending.providerProposal]),
    );
    expect(ledger.clauses).toHaveLength(42);
    expect(ledger.requirements).toHaveLength(50);
    const exact = preflightRequirementCoverageAudit(
      prepareRequirementCoverageAudit(context, ledger),
    );
    const bound = requirementCoverageAuditReservationCeiling(publicPosting, 42);
    expect(exact.requestBytes).toBeLessThanOrEqual(bound.requestBytes);
    expect(exact.maxOutputTokens).toBeLessThanOrEqual(bound.maxOutputTokens);
    expect(exact.fits).toBe(true);
    expect(bound.reservedTokens + 2 * (6000 + 4096)).toBeLessThanOrEqual(80000);
    expect(() =>
      requirementCoverageAuditReservationCeiling(publicPosting, 41),
    ).toThrow('exact native clause count');
  });

  it('bounds maximum legal rows, concentrated mapped references and escaped literal text', () => {
    for (const sourceText of [
      Array.from(
        { length: 12 },
        (_, index) =>
          `Literal ${index}: Unicode 🌎, quote " and slash \\ plus tab\t and control\u0001.`,
      ).join('\n'),
      '<p data-proof="retain">Qualification with escaped "quotes" and \\slashes.</p>\n<p>Another full qualification.</p>',
      'Unicode 🌎, quote " and slash \\ with control\u0001.',
    ]) {
      const context: RequirementCoverageContext = {
        sourceText,
        sourceFingerprint: 'escaping-source',
        sourceVersion: 1,
        extractionFingerprint: 'escaping-extraction',
      };
      const ledger = buildRequirementCoverageSource(context);
      // Exercise the maximum row/reference structure independently of text
      // volume. The short source substring is only a structural stress fixture;
      // every complete escaped source clause remains in the request state.
      const first = ledger.clauses.reduce((shortest, clause) =>
        Buffer.byteLength(JSON.stringify(JSON.stringify(clause.text)), 'utf8') <
        Buffer.byteLength(JSON.stringify(JSON.stringify(shortest.text)), 'utf8')
          ? clause
          : shortest,
      );
      const rowCount = ledger.clauses.length * 2;
      ledger.requirements = Array.from({ length: rowCount }, (_, index) => ({
        id: `criterion-${index}`,
        text: first.text.match(/\p{L}+/u)![0],
        clauseIds: [first.id],
        importance: 'required',
      }));
      ledger.dispositions = ledger.clauses.map((clause) =>
        clause.id === first.id
          ? {
              clauseId: clause.id,
              type: 'material_requirement',
              requirementIds: ledger.requirements.map((row) => row.id),
            }
          : { clauseId: clause.id, type: 'source_context', requirementIds: [] },
      );
      const admission = validateRequirementCoverageAuditAdmission(
        context,
        ledger,
      );
      expect(admission.errors).toEqual([]);
      expect(admission.structuralComplete).toBe(true);
      const prepared = prepareRequirementCoverageAudit(context, ledger);
      const exact = preflightRequirementCoverageAudit(prepared);
      const bound = requirementCoverageAuditReservationCeiling(
        sourceText,
        ledger.clauses.length,
      );
      expect(exact.requestBytes).toBeLessThanOrEqual(bound.requestBytes);
      expect(exact.maxOutputTokens).toBeLessThanOrEqual(bound.maxOutputTokens);
    }
  });

  it('bounds legal escaped text near the validator ceiling independently of row count', () => {
    const sourceText = 'Unicode 🌎, quote " and slash \\ with control\u0001.';
    const context: RequirementCoverageContext = {
      sourceText,
      sourceFingerprint: 'text-cap-source',
      sourceVersion: 1,
      extractionFingerprint: 'text-cap-extraction',
    };
    const ledger = buildRequirementCoverageSource(context);
    const clause = ledger.clauses[0]!;
    expect(clause.text).toBe(sourceText);
    ledger.requirements = [
      {
        id: 'near-text-cap',
        text: sourceText.repeat(2),
        clauseIds: [clause.id],
        importance: 'unknown',
      },
    ];
    ledger.dispositions = [
      {
        clauseId: clause.id,
        type: 'material_requirement',
        requirementIds: ['near-text-cap'],
      },
    ];
    const allowance =
      2 * Buffer.byteLength(JSON.stringify(JSON.stringify(sourceText)), 'utf8');
    const mappedBytes = Buffer.byteLength(
      JSON.stringify(JSON.stringify(ledger.requirements[0]!.text)),
      'utf8',
    );
    expect(mappedBytes).toBeLessThanOrEqual(allowance);
    expect(allowance - mappedBytes).toBeLessThan(10);
    expect(
      validateRequirementCoverageAuditAdmission(context, ledger).errors,
    ).toEqual([]);
    const exact = preflightRequirementCoverageAudit(
      prepareRequirementCoverageAudit(context, ledger),
    );
    const bound = requirementCoverageAuditReservationCeiling(
      sourceText,
      ledger.clauses.length,
    );
    expect(exact.requestBytes).toBeLessThanOrEqual(bound.requestBytes);
    expect(exact.maxOutputTokens).toBeLessThanOrEqual(bound.maxOutputTokens);
  });

  it('keeps an explicit pending body context incomplete until its exact independent global audit affirms nonmateriality', async () => {
    const context: RequirementCoverageContext = {
      ...fixture().context,
      sourceText:
        'About the role\nOur people meet for social lunches.\nApply now',
    };
    const ledger = buildRequirementCoverageSource(context);
    ledger.dispositions[1] = {
      clauseId: ledger.clauses[1]!.id,
      type: 'role_context',
      requirementIds: [],
      auditPending: 'nonmaterial',
    };
    ledger.dispositions[2] = {
      clauseId: ledger.clauses[2]!.id,
      type: 'nonrequirement',
      requirementIds: [],
      exclusionRule: 'navigation_label',
    };
    expect(
      validateRequirementCoverage(context, ledger).structuralComplete,
    ).toBe(false);
    expect(validateVerifiedRequirementCoverage(context, ledger).complete).toBe(
      false,
    );
    const prepared = prepareRequirementCoverageAudit(context, ledger);
    const question =
      prepared.request.questions[
        requirementCoverageClauseQuestionKey(1, 'nonmaterial')
      ].instructions;
    expect(question).toContain('state.clauses.c1.text');
    expect(question).toContain('state.auditPolicy.nonmaterial');
    expect(prepared.request.state).toMatchObject({
      auditPolicy: {
        nonmaterial: expect.stringContaining(
          'presence in raw state proves nothing',
        ),
      },
    });
    const result: DecisionResult = {
      model: 'jev-test',
      provenance: { model: 'jev-test', provider: 'typesafe' },
      answers: Object.fromEntries(
        Object.keys(prepared.request.questions).map((key) => [
          key,
          { type: 'predicate', probability: 0.9 },
        ]),
      ),
    };
    result.answers[requirementCoverageClauseQuestionKey(1, 'nonmaterial')] = {
      type: 'predicate',
      probability: 0.84,
    };
    ledger.audit = resolveRequirementCoverageAudit(
      prepared,
      result,
      'pending-receipt',
    );
    expect(validateVerifiedRequirementCoverage(context, ledger).complete).toBe(
      false,
    );
    result.answers[requirementCoverageClauseQuestionKey(1, 'nonmaterial')] = {
      type: 'predicate',
      probability: 0.9,
    };
    ledger.audit = resolveRequirementCoverageAudit(
      prepared,
      result,
      'pending-receipt',
    );
    expect(validateVerifiedRequirementCoverage(context, ledger).complete).toBe(
      true,
    );
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(
      hasRecordedRequirementCoverageAudit('role-pending', context, ledger),
    ).resolves.toBe(false);
    mocks.query.mockResolvedValue({
      rows: [{ output_json: JSON.stringify(result) }],
    });
    await expect(
      hasRecordedRequirementCoverageAudit('role-pending', context, ledger),
    ).resolves.toBe(true);
    const unmarked = structuredClone(ledger);
    delete unmarked.dispositions[1]!.auditPending;
    expect(() => prepareRequirementCoverageAudit(context, unmarked)).toThrow(
      'admissible',
    );
    expect(
      validateVerifiedRequirementCoverage(context, unmarked).complete,
    ).toBe(false);
    expect(ledger.dispositions[1]!.type).toBe('role_context');
    expect(ledger.dispositions[1]!.requirementIds).toEqual([]);
    expect(ledger.requirements).toEqual([]);
  });

  it('retains descriptive source context while proving candidate criteria and refuses unsupported context labels', () => {
    const context: RequirementCoverageContext = {
      ...fixture().context,
      sourceText:
        'Founded in 2014; serves four million customers.\nDiagnose service-mesh failures and prevent recurrence.',
    };
    const ledger = buildRequirementCoverageSource(context);
    ledger.requirements = [
      {
        id: 'candidate-duty',
        text: ledger.clauses[1]!.text,
        clauseIds: [ledger.clauses[1]!.id],
        importance: 'unknown',
      },
    ];
    ledger.dispositions = [
      {
        clauseId: ledger.clauses[0]!.id,
        type: 'source_context',
        requirementIds: [],
      },
      {
        clauseId: ledger.clauses[1]!.id,
        type: 'role_duty',
        requirementIds: ['candidate-duty'],
      },
    ];
    const prepared = prepareRequirementCoverageAudit(context, ledger);
    const contextQuestion =
      prepared.request.questions[
        requirementCoverageClauseQuestionKey(0, 'nonmaterial')
      ].instructions;
    expect(contextQuestion).toContain('state.auditPolicy.nonmaterial');
    const mappedQuestion =
      prepared.request.questions[
        requirementCoverageClauseQuestionKey(1, 'mapped')
      ].instructions;
    expect(mappedQuestion).toContain('state.auditPolicy.mapped');
    expect(prepared.request.state).toMatchObject({
      auditPolicy: {
        candidateCriteria: expect.stringContaining(
          'employment or benefit program terms',
        ),
        mapped: expect.stringContaining(
          'EVERY mapped statement is itself a candidate criterion',
        ),
        nonmaterial: expect.stringContaining('NO candidate criterion'),
      },
    });
    const result: DecisionResult = {
      model: 'jev-test',
      provenance: { model: 'jev-test', provider: 'typesafe' },
      answers: Object.fromEntries(
        Object.keys(prepared.request.questions).map((key) => [
          key,
          { type: 'predicate', probability: 0.95 },
        ]),
      ),
    };
    ledger.audit = resolveRequirementCoverageAudit(
      prepared,
      result,
      'context-receipt',
    );
    expect(validateVerifiedRequirementCoverage(context, ledger).complete).toBe(
      true,
    );
    result.answers[requirementCoverageClauseQuestionKey(0, 'nonmaterial')] = {
      type: 'predicate',
      probability: 0.84,
    };
    ledger.audit = resolveRequirementCoverageAudit(
      prepared,
      result,
      'context-low',
    );
    expect(validateVerifiedRequirementCoverage(context, ledger).complete).toBe(
      false,
    );
    expect(ledger.clauses[0]!.text).toBe(
      'Founded in 2014; serves four million customers.',
    );
    result.answers[requirementCoverageClauseQuestionKey(0, 'nonmaterial')] = {
      type: 'predicate',
      probability: 0.95,
    };
    ledger.audit = resolveRequirementCoverageAudit(
      prepared,
      result,
      'context-valid-before-tamper',
    );
    expect(validateVerifiedRequirementCoverage(context, ledger).complete).toBe(
      true,
    );
    const tampered = structuredClone(ledger);
    tampered.audit!.deterministicHeadingClauseIds = [ledger.clauses[0]!.id];
    expect(
      validateVerifiedRequirementCoverage(context, tampered).complete,
    ).toBe(false);
    const htmlContext = {
      ...context,
      sourceText: '<p data-source="retained">Founded in 2014.</p>',
    };
    const htmlLedger = buildRequirementCoverageSource(htmlContext);
    htmlLedger.dispositions = [
      {
        clauseId: htmlLedger.clauses[0]!.id,
        type: 'source_context',
        requirementIds: [],
      },
    ];
    expect(
      requirementCoverageHasLosslessWireClauses(htmlContext, htmlLedger),
    ).toBe(false);
    const htmlState = prepareRequirementCoverageAudit(htmlContext, htmlLedger)
      .request.state;
    if (!htmlState || typeof htmlState !== 'object' || Array.isArray(htmlState))
      throw new Error('Expected an object audit state for this fixture.');
    expect(htmlState.source).toBe(htmlContext.sourceText);
  });

  it('rejects incomplete semantics, malformed answers and unknown audit provenance', () => {
    const { prepared, ledger, context, result } = fixture();
    result.answers[requirementCoverageClauseQuestionKey(1, 'mapped')] = {
      type: 'predicate',
      probability: 0.84,
    };
    ledger.audit = resolveRequirementCoverageAudit(
      prepared,
      result,
      'receipt-1',
    );
    expect(validateVerifiedRequirementCoverage(context, ledger).complete).toBe(
      false,
    );
    delete result.answers[requirementCoverageClauseQuestionKey(1, 'mapped')];
    expect(() =>
      resolveRequirementCoverageAudit(prepared, result, 'receipt-1'),
    ).toThrow('Malformed source coverage');
    const noReceipt = fixture();
    noReceipt.ledger.audit = resolveRequirementCoverageAudit(
      noReceipt.prepared,
      noReceipt.result,
    );
    expect(
      validateVerifiedRequirementCoverage(noReceipt.context, noReceipt.ledger)
        .complete,
    ).toBe(false);
  });

  it('normalizes unverified importance while preserving complete clause semantics', () => {
    const { context, ledger } = fixture();
    ledger.requirements[0]!.importance = 'required';
    const prepared = prepareRequirementCoverageAudit(context, ledger);
    expect(
      prepared.request.questions.importance_0_explicit.instructions,
    ).toContain('state.requirements.r0.text');
    const result = {
      answers: Object.fromEntries(
        Object.keys(prepared.request.questions).map((key) => [
          key,
          {
            type: 'predicate',
            probability: key.startsWith('importance_') ? 0.84 : 0.9,
          },
        ]),
      ),
    } as DecisionResult;
    ledger.audit = resolveRequirementCoverageAudit(
      prepared,
      result,
      'receipt-2',
    );
    expect(ledger.audit.importance['duty-1']).toBe('unknown');
    expect(validateVerifiedRequirementCoverage(context, ledger).complete).toBe(
      true,
    );
    result.answers.importance_0_explicit = {
      type: 'predicate',
      probability: 0.95,
    };
    ledger.audit = resolveRequirementCoverageAudit(
      prepared,
      result,
      'receipt-3',
    );
    expect(ledger.audit.importance['duty-1']).toBe('required');
    expect(validateVerifiedRequirementCoverage(context, ledger).complete).toBe(
      true,
    );
  });

  it('keeps unoffered importance unknown and retains all literal source meaning', () => {
    const context: RequirementCoverageContext = {
      sourceText: Array.from(
        { length: 50 },
        (_, index) =>
          `Required qualification ${index}: retain detail ${index}.`,
      ).join('\n'),
      sourceFingerprint: 'source-many',
      sourceVersion: 1,
      extractionFingerprint: 'extract-many',
    };
    const ledger = buildRequirementCoverageSource(context);
    ledger.requirements = ledger.clauses.map((clause, index) => ({
      id: `criterion-${index}`,
      text: clause.text,
      clauseIds: [clause.id],
      importance: 'required',
    }));
    ledger.dispositions = ledger.clauses.map((clause, index) => ({
      clauseId: clause.id,
      type: 'material_requirement',
      requirementIds: [`criterion-${index}`],
    }));
    const prepared = prepareRequirementCoverageAudit(context, ledger);
    const offered = new Set(Object.values(prepared.questionRequirementIds));
    expect(offered.size).toBeGreaterThan(0);
    expect(offered.size).toBeLessThan(ledger.requirements.length);
    expect(Object.keys(prepared.questionClauseIds)).toHaveLength(50);
    expect(JSON.stringify(prepared.request.state)).toContain(
      ledger.requirements[49]!.text,
    );
    ledger.audit = resolveRequirementCoverageAudit(
      prepared,
      {
        model: 'jev-test',
        provenance: { model: 'jev-test', provider: 'typesafe' },
        answers: Object.fromEntries(
          Object.keys(prepared.request.questions).map((key) => [
            key,
            { type: 'predicate', probability: 0.95 },
          ]),
        ),
      },
      'receipt-many',
    );
    for (const requirement of ledger.requirements)
      expect(ledger.audit.importance[requirement.id]).toBe(
        offered.has(requirement.id) ? 'required' : 'unknown',
      );
    expect(validateVerifiedRequirementCoverage(context, ledger).complete).toBe(
      true,
    );
  });

  it('uses a stable source intent across deterministic preparation and distinguishes recorded negative confidence', async () => {
    const opportunity = {
      id: 'role-1',
      descriptionRaw: 'Platform work.',
      sourceContentFingerprint: 'source-1',
      sourceContentVersion: 1,
    };
    expect(requirementCoverageSourceDependencyFingerprint(opportunity)).toBe(
      requirementCoverageSourceDependencyFingerprint({
        ...opportunity,
        preparedPostingFingerprint: 'previous-preparation',
      }),
    );
    const context = requirementCoverageContextForOpportunity(opportunity);
    const ledger = buildRequirementCoverageSource(context);
    ledger.requirements = [
      {
        id: 'r1',
        text: ledger.clauses[0]!.text,
        clauseIds: [ledger.clauses[0]!.id],
        importance: 'unknown',
      },
    ];
    ledger.dispositions = [
      {
        clauseId: ledger.clauses[0]!.id,
        type: 'role_duty',
        requirementIds: ['r1'],
      },
    ];
    const prepared = prepareRequirementCoverageAudit(context, ledger);
    const result: DecisionResult = {
      model: 'jev-test',
      provenance: { model: 'jev-test', provider: 'typesafe' },
      answers: {
        [requirementCoverageClauseQuestionKey(0, 'mapped')]: {
          type: 'predicate',
          probability: 0.5,
        },
      },
    };
    ledger.audit = resolveRequirementCoverageAudit(
      prepared,
      result,
      'negative-receipt',
    );
    const cached = {
      ...opportunity,
      preparedPostingJson: JSON.stringify({ requirementCoverage: ledger }),
    };
    mocks.query.mockResolvedValue({
      rows: [{ output_json: JSON.stringify(result) }],
    });
    await expect(
      readRecordedRequirementCoverageOutcome('role-1', cached),
    ).resolves.toMatchObject({ status: 'blocked', reason: 'confidence' });
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(
      readRecordedRequirementCoverageOutcome('role-1', cached),
    ).resolves.toEqual({ status: 'missing' });
  });

  it('blocks paid failed source identities while keeping pre-provider revocation missing', async () => {
    const opportunity = {
      id: 'role-failed',
      descriptionRaw: 'Platform reliability.',
      sourceContentFingerprint: 'source-failed',
      sourceContentVersion: 1,
    };
    const bridge = {
      sourcePreparationAgentRunId: 'server-saved-run',
      sourceDependencyFingerprint:
        requirementCoverageSourceDependencyFingerprint(opportunity),
    };
    mocks.query.mockResolvedValue({
      rows: [
        {
          status: 'failed',
          accounting_basis: 'conservative',
          actual_total_tokens: 0,
          request_id: 'internal-1',
          provider_request_id: 'internal-1',
          owner_request_id: 'internal-1',
        },
      ],
    });
    await expect(
      readRecordedRequirementCoverageOutcome(
        'role-failed',
        opportunity,
        bridge,
      ),
    ).resolves.toEqual({ status: 'missing' });
    mocks.query.mockResolvedValue({
      rows: [
        {
          status: 'failed',
          accounting_basis: 'actual',
          actual_total_tokens: 42,
          request_id: 'request-1',
          provider_request_id: 'provider-1',
          owner_request_id: 'request-1',
        },
      ],
    });
    await expect(
      readRecordedRequirementCoverageOutcome(
        'role-failed',
        opportunity,
        bridge,
      ),
    ).resolves.toMatchObject({ status: 'blocked', reason: 'attempt_failed' });
    expect(mocks.query.mock.calls[1]![1]).toContain('server-saved-run');
  });

  it('shares only an actually invoked failed repair bound to an attested current source identity', async () => {
    const opportunity = {
      id: 'role-repair',
      descriptionRaw: 'Diagnose service-mesh failures.',
      sourceContentFingerprint: 'repair-source',
      sourceContentVersion: 1,
    };
    const fingerprint =
      requirementCoverageSourceDependencyFingerprint(opportunity);
    const failed = {
      status: 'failed',
      feature: 'opportunity-source-requirement-repair',
      accounting_basis: 'actual',
      actual_total_tokens: 42,
      request_id: 'repair-request',
      provider_request_id: 'provider-repair',
      owner_request_id: 'repair-request',
    };
    mocks.query.mockResolvedValue({ rows: [failed] });
    const outcomes = [];
    for (const tenantId of ['tenant-a', 'tenant-b']) {
      outcomes.push(
        await readRecordedRequirementCoverageOutcome(
          'role-repair',
          { ...opportunity, tenantId },
          {
            sourcePreparationAgentRunId: `server-${tenantId}`,
            sourceDependencyFingerprint: fingerprint,
            repairInputFingerprint: 'native-attested-repair-fingerprint',
          },
        ),
      );
    }
    expect(outcomes[0]).toMatchObject({
      status: 'blocked',
      reason: 'attempt_failed',
    });
    expect(outcomes[1]).toEqual(outcomes[0]);
    for (const [query, args] of mocks.query.mock.calls) {
      expect(query).toContain(
        "r.input_fingerprint = ? AND r.feature = 'opportunity-source-requirement-repair'",
      );
      expect(query).toContain("COALESCE(r.tenant_id, '') = ''");
      expect(
        args.filter(
          (arg: unknown) => arg === 'native-attested-repair-fingerprint',
        ),
      ).toHaveLength(2);
    }
    mocks.query.mockResolvedValue({
      rows: [
        {
          ...failed,
          accounting_basis: 'conservative',
          actual_total_tokens: 0,
          provider_request_id: failed.request_id,
        },
      ],
    });
    await expect(
      readRecordedRequirementCoverageOutcome('role-repair', opportunity, {
        sourcePreparationAgentRunId: 'server-a',
        sourceDependencyFingerprint: fingerprint,
        repairInputFingerprint: 'native-attested-repair-fingerprint',
      }),
    ).resolves.toEqual({ status: 'missing' });
    mocks.query.mockResolvedValue({ rows: [] });
    await readRecordedRequirementCoverageOutcome('role-repair', opportunity, {
      sourcePreparationAgentRunId: 'server-a',
      sourceDependencyFingerprint: 'stale-source-intent',
      repairInputFingerprint: 'native-attested-repair-fingerprint',
    });
    expect(mocks.query.mock.calls.at(-1)![1]).not.toContain(
      'native-attested-repair-fingerprint',
    );
  });

  it('shares a paid failed GLOBAL audit across profiles without a native cache or job bridge', async () => {
    const opportunity = {
      id: 'role-global',
      descriptionRaw: 'Platform reliability.',
      sourceContentFingerprint: 'source-global',
      sourceContentVersion: 1,
    };
    const extraction = {
      status: 'completed',
      feature: 'opportunity-extraction-chunk-0',
      output_json: JSON.stringify({
        requirementCoverage: {
          requirements: [
            {
              id: 'r1',
              text: 'Platform reliability.',
              clauseIds: ['c0'],
              importance: 'unknown',
            },
          ],
          dispositions: [
            { clauseId: 'c0', type: 'role_duty', requirementIds: ['r1'] },
          ],
        },
      }),
    };
    const failed = {
      owner_request_id: 'audit-request',
      request_id: 'audit-request',
      provider_request_id: 'actual-provider-request',
      accounting_basis: 'actual',
      actual_total_tokens: 42,
    };
    mocks.query
      .mockResolvedValueOnce({ rows: [extraction] })
      .mockResolvedValueOnce({ rows: [failed] })
      .mockResolvedValueOnce({ rows: [extraction] })
      .mockResolvedValueOnce({ rows: [failed] });
    const profileA = await readRecordedRequirementCoverageOutcome(
      'role-global',
      {
        ...opportunity,
        tenantId: 'tenant-a',
        candidateProfileId: 'profile-a',
      },
    );
    const profileB = await readRecordedRequirementCoverageOutcome(
      'role-global',
      {
        ...opportunity,
        tenantId: 'tenant-b',
        candidateProfileId: 'profile-b',
      },
    );
    expect(profileA).toMatchObject({
      status: 'blocked',
      reason: 'attempt_failed',
    });
    expect(profileB).toEqual(profileA);
    expect(mocks.query.mock.calls[1]![1]).toEqual(
      mocks.query.mock.calls[3]![1],
    );
    expect(mocks.query.mock.calls[1]![0]).toContain(
      "COALESCE(r.candidate_profile_id, '') = ''",
    );
    expect(JSON.stringify(profileA)).not.toContain('tenant-a');
    // Conservative accounting with an internal ID cannot poison the shared source.
    mocks.query
      .mockResolvedValueOnce({ rows: [extraction] })
      .mockResolvedValueOnce({
        rows: [
          {
            ...failed,
            accounting_basis: 'conservative',
            actual_total_tokens: 0,
            provider_request_id: failed.request_id,
            error_code: 'usage_accounting_missing',
            output_json: '{}',
          },
        ],
      });
    await expect(
      readRecordedRequirementCoverageOutcome('role-global', opportunity),
    ).resolves.toEqual({ status: 'missing' });
  });

  it('invalidates changed source, mappings, text or a reused audit on a new extraction', () => {
    const { ledger, context } = fixture();
    expect(validateVerifiedRequirementCoverage(context, ledger).complete).toBe(
      true,
    );
    expect(
      validateVerifiedRequirementCoverage(
        { ...context, sourceText: `${context.sourceText}!` },
        ledger,
      ).complete,
    ).toBe(false);
    expect(
      validateVerifiedRequirementCoverage(
        { ...context, extractionFingerprint: 'extraction-2' },
        ledger,
      ).complete,
    ).toBe(false);
    const changed: CoverageLedger = structuredClone(ledger);
    changed.requirements[0]!.text = 'Service mesh';
    expect(validateVerifiedRequirementCoverage(context, changed).complete).toBe(
      false,
    );
  });

  it('requires the exact completed global governance output, not an injected JSON cache', async () => {
    const { context, ledger, result } = fixture();
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(
      hasRecordedRequirementCoverageAudit('role-1', context, ledger),
    ).resolves.toBe(false);
    mocks.query.mockResolvedValue({
      rows: [{ output_json: JSON.stringify(result) }],
    });
    await expect(
      hasRecordedRequirementCoverageAudit('role-1', context, ledger),
    ).resolves.toBe(true);
    expect(mocks.query.mock.calls[1]![0]).toContain(
      "COALESCE(candidate_profile_id, '') = ''",
    );
    result.answers[requirementCoverageClauseQuestionKey(1, 'mapped')] = {
      type: 'predicate',
      probability: 0.5,
    };
    mocks.query.mockResolvedValue({
      rows: [{ output_json: JSON.stringify(result) }],
    });
    await expect(
      hasRecordedRequirementCoverageAudit('role-1', context, ledger),
    ).resolves.toBe(false);
  });

  it('counts every source/private stage and rejects an unfit combined lifecycle', () => {
    const limits = { calls: 4, inputTokens: 80_000 };
    expect(
      preflightRequirementCoverageLifecycle(
        [
          { calls: 1, reservedTokens: 77_824 },
          { calls: 1, reservedTokens: 10_000 },
        ],
        limits,
      ).fits,
    ).toBe(false);
    expect(
      preflightRequirementCoverageLifecycle(
        [
          { calls: 3, reservedTokens: 30_000 },
          { calls: 2, reservedTokens: 10_000 },
        ],
        limits,
      ).fits,
    ).toBe(false);
    expect(
      preflightRequirementCoverageLifecycle(
        [
          { calls: 1, reservedTokens: 20_000 },
          { calls: 1, reservedTokens: 15_000 },
        ],
        limits,
      ),
    ).toEqual({ calls: 2, reservedTokens: 35_000, fits: true });
  });
});
