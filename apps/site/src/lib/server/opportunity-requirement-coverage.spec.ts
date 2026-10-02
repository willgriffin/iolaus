import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import capturedIncomplete from './fixtures/ats/wealthsimple-source-coverage-incomplete.json';
import capturedPending from './fixtures/ats/wealthsimple-source-coverage-pending.json';
import {
  buildPostingClauses,
  buildRequirementCoverage,
  buildRequirementCoverageSource,
  type CoverageLedger,
  canonicalHeadingClauseIds,
  mergeRequirementCoverageRepair,
  normalizeRequirementCoverageForAudit,
  prepareRequirementCoverageRepair,
  type RequirementCoverageContext,
  requirementCoverageContextForOpportunity,
  requirementCoverageExtractionClauses,
  validatePreparedRequirementCoverageRepair,
  validateRequirementCoverage,
  validateRequirementCoverageAuditAdmission,
} from './opportunity-requirement-coverage.js';

// Frozen public Wealthsimple posting/audited role clauses; no candidate facts.
const publicPosting =
  "Build something people love\nWealthsimple is Canada’s leading financial innovator. The company offers a full suite of simple, sophisticated financial products across managed investing, do-it-yourself trading, cryptocurrency, tax filing, spending and saving. Wealthsimple currently serves more than 4 million Canadians and holds over $155 billion in assets under administration. The company was founded in 2014 by a team of financial experts and technology entrepreneurs, and is headquartered in Toronto, Canada.\n\nWe're proud of what we've built — and we're just getting started. Read our Culture Manual and learn more about how we work .\n\nAbout the team\nWe build the products and infrastructure that millions of Canadians trust with their financial lives. Data & Engineering at Wealthsimple spans everything from the client-facing apps to the systems running underneath them — and we hold ourselves to a high bar on both. We move fast, but we build thoughtfully: quality, security, and scalability aren’t trade-offs here, they’re the standard.\nThe Production Engineering team sits within Platform Experience, on the boundary between Platform and Product. Our mandate is to raise reliability across Wealthsimple’s most critical flows — reducing incidents, helping service teams ship safely, and turning individual fixes into platform-wide improvements. We measure ourselves against two targets: 99.9% uptime on critical flows, and fewer than 1% of weekly active users experiencing errors in the app. If you want to work on hard problems with people who care deeply about craft, you’ll fit right in.\n \nAbout the role\nThis is a new role — one that doesn’t yet exist at Wealthsimple — and it’s a meaningful one. As a Staff Software Developer on Production Engineering, you’ll bring senior technical leadership to the work of making Wealthsimple more reliable at scale. You’ll work across platform and product teams, identify the highest-leverage reliability problems, and build solutions that don’t just fix the immediate issue but raise the floor for everyone. This isn’t a role where you sit in one corner of the codebase. It’s a role where you shape how engineering gets done across the company.\n \nWhat you’ll do\n\n- Improve the platform to prevent incidents — designing and driving adoption of guardrails, sensible defaults, and engineering standards that reduce the likelihood of failures across services\n\n- Build tooling that reduces time to mitigation when incidents occur, including contributing to our in-house product on AI-assisted incident response\n\n- Own the investigation and follow-through on load test findings — translating results into concrete reliability improvements across critical flows\n\n- Work across platform and product engineering teams as a technical influencer — participating in architecture and readiness reviews, coaching service owners, and driving adoption of scalable reliability practices\n\n- Identify recurring failure patterns and design platform-level fixes that prevent them from showing up again in a different service\n\n- Contribute to the team’s reliability syncs with product engineering, helping align on incident themes, critical-flow risks, and the next highest-leverage initiatives\n\n \nSkills you bring\n\n- 8+ years of software engineering experience, with significant time in platform, infrastructure, or SRE work\n\n- Demonstrated track record of improving reliability at scale — reducing incidents, building guardrails, or driving operational standards across multiple teams\n\n- Strong proficiency in backend systems and distributed architecture; you can diagnose complex failure modes across a service mesh\n\n- Experience with load testing and capacity planning, and the ability to translate findings into concrete engineering improvements\n\n- Proven ability to work across engineering teams as a technical influencer — driving adoption of standards and practices without direct authority\n\n- Familiarity with Kubernetes, Helm, Argo and modern deployment tooling\n\n- Strong written and verbal communication — comfortable presenting findings and recommendations to both engineering teams and senior leadership\n\n \nWho you are\n\n- You think in systems — you’re not looking for the fix, you’re looking for what caused the problem and how to make sure it doesn’t happen elsewhere\n\n- You’re comfortable working without direct authority; you build credibility through the quality of your thinking and the clarity of your recommendations\n\n- You hold a high bar for operational excellence without making it someone else’s problem to catch up to — you bring people along\n\n- You’re energised by ambiguity, not slowed down by it; you know how to prioritise when everything feels urgent\n\n- You’re curious about where AI-assisted tooling is headed in reliability engineering, and you want to help shape how we use it — not just observe it from a distance\n\nWhy Wealthsimple?\n🌸 Top-tier health benefits and life insurance\n📈 Long-term group savings with employer match, through Wealthsimple for Business\n🌴 20 vacation days, 4 wellness days, and unlimited sick and mental health days per year*\n✈️ 90 days away: work outside Canada for up to 90 days per year*\n👥 Employee resource groups, including Rainbow (2SLGBTQ), Women of WS, and Black at WS\n🌎 We are a hybrid team with over 1,500 employees across North America. The people are one of the best parts of working here: you'll collaborate with incredibly talented, curious, and driven teammates who are deeply committed to doing great work.\n\n*Unlimited paid sick days, Wellness Days and the 90 day away program do not apply to certain roles.\n\nICYMI\nTechnology & Innovation at Wealthsimple: We move quickly and build thoughtfully. That means we're always looking for better ways to work — whether that's new tools, AI, or rethinking how we approach a problem. We don't expect you to have all the answers, but we do expect curiosity and a willingness to evolve alongside the products we're building.\n\nInclusion Statement: We're building products for a diverse world, and we need a diverse team to do it well. We strongly encourage applications from everyone, regardless of race, religion, colour, national origin, gender, sexual orientation, age, marital status, or disability status.\n\nAccessibility Statement: We're committed to an accessible hiring experience. If you need any accommodations throughout the interview process, please let us know — we'll work with you to make sure you have what you need. We also welcome any feedback on how we can better accommodate candidates with accessibility needs.\n\nAI in Hiring: We may use artificial intelligence (AI) tools to support parts of our hiring process, such as reviewing applications, analyzing resumes, or assessing responses. These tools assist our team but don't replace human judgment – all final hiring decisions are made by people. If you have questions about how your data is used, reach out to us.";
const actualRoleClauses = [
  'Improve the platform to prevent incidents — designing and driving adoption of guardrails, sensible defaults, and engineering standards that reduce the likelihood of failures across services',
  'Build tooling that reduces time to mitigation when incidents occur, including contributing to our in-house product on AI-assisted incident response',
  'Own the investigation and follow-through on load test findings — translating results into concrete reliability improvements across critical flows',
  'Work across platform and product engineering teams as a technical influencer — participating in architecture and readiness reviews, coaching service owners, and driving adoption of scalable reliability practices',
  'Identify recurring failure patterns and design platform-level fixes that prevent them from showing up again in a different service',
  'Contribute to the team’s reliability syncs with product engineering, helping align on incident themes, critical-flow risks, and the next highest-leverage initiatives',
  '8+ years of software engineering experience, with significant time in platform, infrastructure, or SRE work',
  'Demonstrated track record of improving reliability at scale — reducing incidents, building guardrails, or driving operational standards across multiple teams',
  'Strong proficiency in backend systems and distributed architecture; you can diagnose complex failure modes across a service mesh',
  'Experience with load testing and capacity planning, and the ability to translate findings into concrete engineering improvements',
  'Proven ability to work across engineering teams as a technical influencer — driving adoption of standards and practices without direct authority',
  'Familiarity with Kubernetes, Helm, Argo and modern deployment tooling',
  'Strong written and verbal communication — comfortable presenting findings and recommendations to both engineering teams and senior leadership',
  'You think in systems — you’re not looking for the fix, you’re looking for what caused the problem and how to make sure it doesn’t happen elsewhere',
  'You’re comfortable working without direct authority; you build credibility through the quality of your thinking and the clarity of your recommendations',
  'You hold a high bar for operational excellence without making it someone else’s problem to catch up to — you bring people along',
  'You’re energised by ambiguity, not slowed down by it; you know how to prioritise when everything feels urgent',
  'You’re curious about where AI-assisted tooling is headed in reliability engineering, and you want to help shape how we use it — not just observe it from a distance',
];
const context: RequirementCoverageContext = {
  sourceText: publicPosting,
  sourceFingerprint: 'source-current',
  sourceVersion: 1,
  extractionFingerprint: 'extraction-current',
  preparedFingerprint: 'prepared-current',
};
function completeLedger(ctx = context): CoverageLedger {
  const ledger = buildRequirementCoverageSource(ctx);
  for (const clause of ledger.clauses) {
    if (clause.kind === 'heading') continue;
    const id = `requirement:${clause.id}`;
    ledger.requirements.push({
      id,
      text: clause.text,
      clauseIds: [clause.id],
      importance: 'unknown',
    });
    ledger.dispositions = ledger.dispositions.map((row) =>
      row.clauseId === clause.id
        ? { clauseId: clause.id, type: 'role_context', requirementIds: [id] }
        : row,
    );
  }
  return ledger;
}
describe('exact source requirement coverage', () => {
  it('repairs exact source context and omitted criteria while preserving the paid base and scoped retirement provenance', () => {
    const base = normalizeRequirementCoverageForAudit(
      context,
      buildRequirementCoverage(context, [capturedPending.providerProposal]),
    );
    const before = structuredClone(base);
    const targets = [4, 5, 33, 35, 36, 38].map(
      (index) => base.clauses[index].id,
    );
    const prepared = prepareRequirementCoverageRepair(
      context,
      base,
      'actual-completed-base',
      {
        sourceFingerprint: context.sourceFingerprint,
        sourceVersion: context.sourceVersion,
        extractionFingerprint: context.extractionFingerprint,
        auditInputFingerprint: 'actual-negative-audit',
        requestId: 'actual-audit-request',
        probabilities: Object.fromEntries(
          base.clauses.map((row) => [row.id, 0.5]),
        ),
      },
      targets,
      { inputTokenCeiling: 6000, maxOutputTokens: 4096 },
    );
    const output = {
      requirementCoverage: {
        requirements: [
          {
            id: 'repair_r1',
            text: 'Curiosity.',
            clauseIds: ['c38'],
            importance: 'unknown',
          },
          {
            id: 'repair_r2',
            text: 'Willingness to evolve alongside the products Wealthsimple is building.',
            clauseIds: ['c38'],
            importance: 'unknown',
          },
        ],
        removedRequirementIds: ['r1', 'r49', 'r50'],
        dispositions: [
          { clauseId: 'c4', type: 'source_context', requirementIds: [] },
          {
            clauseId: 'c5',
            type: 'role_duty',
            requirementIds: ['r2', 'r3', 'r4'],
          },
          { clauseId: 'c33', type: 'source_context', requirementIds: [] },
          { clauseId: 'c35', type: 'source_context', requirementIds: [] },
          { clauseId: 'c36', type: 'source_context', requirementIds: [] },
          {
            clauseId: 'c38',
            type: 'material_requirement',
            requirementIds: ['repair_r1', 'repair_r2'],
          },
        ],
      },
    };
    const merged = mergeRequirementCoverageRepair(prepared, output);
    expect(validatePreparedRequirementCoverageRepair(context, prepared)).toBe(
      true,
    );
    const changedSeed = structuredClone(prepared);
    changedSeed.provenance.targetClauseIds.pop();
    expect(
      validatePreparedRequirementCoverageRepair(context, changedSeed),
    ).toBe(false);
    expect(prepared.provenance.baseExtractionFingerprint).toBe(
      context.extractionFingerprint,
    );
    expect(prepared.provenance.inputFingerprint).not.toBe(
      context.extractionFingerprint,
    );
    expect(() =>
      prepareRequirementCoverageRepair(
        { ...context, sourceVersion: context.sourceVersion + 1 },
        base,
        prepared.provenance.baseRequestId,
        {
          sourceFingerprint: context.sourceFingerprint,
          sourceVersion: context.sourceVersion,
          extractionFingerprint: context.extractionFingerprint,
          auditInputFingerprint: 'actual-negative-audit',
          requestId: 'actual-audit-request',
          probabilities: Object.fromEntries(
            base.clauses.map((row) => [row.id, 0.5]),
          ),
        },
        targets,
        { inputTokenCeiling: 6000, maxOutputTokens: 4096 },
      ),
    ).toThrow('exact current source');
    expect(base).toEqual(before);
    expect(merged.clauses).toEqual(base.clauses);
    expect(merged.requirements).toHaveLength(49);
    expect(
      merged.requirements.filter((row) => !row.id.startsWith('repair_')),
    ).toEqual(
      base.requirements.filter((row) => !['r1', 'r49', 'r50'].includes(row.id)),
    );
    expect(merged.repair).toMatchObject({
      baseExtractionFingerprint: context.extractionFingerprint,
      baseRequestId: 'actual-completed-base',
      feedbackAuditFingerprint: 'actual-negative-audit',
      removedRequirementIds: ['r1', 'r49', 'r50'],
    });
    expect(
      validateRequirementCoverage(context, merged).structuralComplete,
    ).toBe(true);
    expect(merged.audit).toBeUndefined();
    const overwrite = structuredClone(output);
    overwrite.requirementCoverage.requirements[0].id = 'r2';
    expect(() => mergeRequirementCoverageRepair(prepared, overwrite)).toThrow(
      'cannot replace paid rows',
    );
    const unrelated = structuredClone(output);
    unrelated.requirementCoverage.removedRequirementIds.push('r26');
    expect(() => mergeRequirementCoverageRepair(prepared, unrelated)).toThrow(
      'confined to updated source targets',
    );
    const lostDuty = structuredClone(output);
    lostDuty.requirementCoverage.dispositions[1].requirementIds = ['r3', 'r4'];
    expect(() => mergeRequirementCoverageRepair(prepared, lostDuty)).toThrow(
      'incomplete',
    );
    const proposedCriterionLoss = structuredClone(output);
    proposedCriterionLoss.requirementCoverage.removedRequirementIds.push('r2');
    proposedCriterionLoss.requirementCoverage.dispositions[1].requirementIds = [
      'r3',
      'r4',
    ];
    const stillUnverified = mergeRequirementCoverageRepair(
      prepared,
      proposedCriterionLoss,
    );
    expect(stillUnverified.audit).toBeUndefined();
    expect(stillUnverified.clauses[5].text).toContain('reducing incidents');
  });
  it('retains source context verbatim without candidate rows and requires canonical heading evidence', () => {
    const ledger = normalizeRequirementCoverageForAudit(
      context,
      buildRequirementCoverage(context, [capturedPending.providerProposal]),
    );
    const pending = ledger.dispositions.find((row) => row.auditPending)!;
    Object.assign(pending, { type: 'source_context', auditPending: undefined });
    expect(
      validateRequirementCoverage(context, ledger).structuralComplete,
    ).toBe(true);
    expect(ledger.requirements).toHaveLength(50);
    expect(
      ledger.clauses.find((row) => row.id === pending.clauseId)?.text,
    ).toContain('quality, security, and scalability');
    expect(canonicalHeadingClauseIds(context, ledger)).toEqual(
      ledger.clauses
        .filter((row) => row.kind === 'heading')
        .map((row) => row.id),
    );
    const forged = structuredClone(ledger);
    forged.clauses[0].kind = 'heading';
    expect(canonicalHeadingClauseIds(context, forged)).toEqual([]);
    const mappedHeading = structuredClone(ledger);
    const heading = mappedHeading.clauses.find(
      (row) => row.kind === 'heading',
    )!;
    Object.assign(
      mappedHeading.dispositions.find((row) => row.clauseId === heading.id)!,
      { type: 'material_requirement', requirementIds: ['forged-heading-row'] },
    );
    expect(canonicalHeadingClauseIds(context, mappedHeading)).not.toContain(
      heading.id,
    );
    pending.requirementIds = ['r1'];
    expect(
      validateRequirementCoverageAuditAdmission(context, ledger).errors,
    ).toContain(
      `Source context must not create candidate requirement rows: ${pending.clauseId}.`,
    );
    expect(
      validateRequirementCoverageAuditAdmission(context, ledger)
        .structuralComplete,
    ).toBe(false);
  });
  it('admits the actual V4 proposal only for independent audit while retaining its unmapped context', () => {
    const original = buildRequirementCoverage(context, [
      capturedPending.providerProposal,
    ]);
    expect(validateRequirementCoverage(context, original).errors).toHaveLength(
      21,
    );
    const normalized = normalizeRequirementCoverageForAudit(context, original);
    expect(normalized.requirements).toEqual(original.requirements);
    expect(normalized.clauses).toEqual(original.clauses);
    expect(normalized.requirements).toHaveLength(50);
    expect(normalized.dispositions).toHaveLength(42);
    const pending = normalized.dispositions.filter((row) => row.auditPending);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      type: 'role_context',
      requirementIds: [],
      auditPending: 'nonmaterial',
    });
    expect(
      normalized.clauses.find((row) => row.id === pending[0].clauseId)?.text,
    ).toContain('quality, security, and scalability');
    const strict = validateRequirementCoverage(context, normalized);
    expect(strict.structuralComplete).toBe(false);
    expect(strict.errors).toEqual([
      `Material source clause has no lossless mapped requirement: ${pending[0].clauseId}.`,
    ]);
    const admission = validateRequirementCoverageAuditAdmission(
      context,
      normalized,
    );
    expect(admission.structuralComplete).toBe(true);
    expect(admission.pendingContextClauseIds).toEqual([pending[0].clauseId]);
    expect(normalized.audit).toBeUndefined();
    expect(original.dispositions.some((row) => row.auditPending)).toBe(false);
  });

  it('does not normalize a body into a heading or allow a pending marker to bypass broken source mappings', () => {
    const ledger = normalizeRequirementCoverageForAudit(
      context,
      buildRequirementCoverage(context, [capturedPending.providerProposal]),
    );
    const pending = ledger.dispositions.find((row) => row.auditPending)!;
    pending.type = 'role_duty';
    expect(
      validateRequirementCoverageAuditAdmission(context, ledger)
        .structuralComplete,
    ).toBe(false);
    pending.type = 'role_context';
    ledger.requirements[0].clauseIds = ['forged-clause'];
    expect(
      validateRequirementCoverageAuditAdmission(context, ledger)
        .structuralComplete,
    ).toBe(false);
    const body = ledger.dispositions.find(
      (row) => row.clauseId === pending.clauseId,
    )!;
    Object.assign(body, { type: 'section_heading', auditPending: undefined });
    const normalized = normalizeRequirementCoverageForAudit(context, ledger);
    expect(
      normalized.dispositions.find((row) => row.clauseId === body.clauseId)
        ?.type,
    ).toBe('section_heading');
    expect(
      validateRequirementCoverageAuditAdmission(context, normalized)
        .structuralComplete,
    ).toBe(false);
  });

  it('normalizes only the exact recorded nonmaterial suffix and rejects arbitrary exclusion rules before audit', () => {
    const original = buildRequirementCoverage(context, [
      capturedPending.providerProposal,
    ]);
    const exclusion = original.dispositions.find(
      (row) =>
        row.exclusionRule ===
        'literal_nonmaterial_audit pending independent verification',
    )!;
    exclusion.exclusionRule =
      ' literal_nonmaterial_audit pending independent verification ';
    const normalized = normalizeRequirementCoverageForAudit(context, original);
    expect(
      normalized.dispositions.find((row) => row.clauseId === exclusion.clauseId)
        ?.exclusionRule,
    ).toBe('literal_nonmaterial_audit');
    expect(
      validateRequirementCoverageAuditAdmission(context, normalized)
        .structuralComplete,
    ).toBe(true);
    for (const rule of [
      'arbitrary_invalid_rule',
      'literal_nonmaterial_audit pending independent verification invented suffix',
      'literal_nonmaterial_audit pending',
    ]) {
      exclusion.exclusionRule = rule;
      const invalid = normalizeRequirementCoverageForAudit(context, original);
      expect(
        invalid.dispositions.find((row) => row.clauseId === exclusion.clauseId)
          ?.exclusionRule,
      ).toBe(rule);
      expect(
        validateRequirementCoverageAuditAdmission(context, invalid)
          .structuralComplete,
      ).toBe(false);
      expect(
        validateRequirementCoverageAuditAdmission(context, invalid).errors,
      ).toContain(
        `Unsupported nonrequirement exclusion: ${exclusion.clauseId}.`,
      );
    }
  });
  it('rejects the actual complete-JSON source failure without inventing missing context rows or exclusions', () => {
    const ledger = buildRequirementCoverage(context, [
      capturedIncomplete.providerProposal,
    ]);
    expect(ledger.clauses).toHaveLength(42);
    expect(ledger.requirements).toHaveLength(25);
    expect(ledger.dispositions).toHaveLength(42);
    const result = validateRequirementCoverage(context, ledger);
    expect(result.structuralComplete).toBe(false);
    expect(
      result.errors.filter((error) => error.startsWith('Broken reciprocal')),
    ).toHaveLength(2);
    expect(
      result.errors.filter((error) =>
        error.startsWith('Unsupported nonrequirement'),
      ),
    ).toHaveLength(5);
    expect(
      ledger.requirements.some((row) => row.id === 'r26' || row.id === 'r27'),
    ).toBe(false);
    expect(ledger.audit).toBeUndefined();
  });
  it('compacts request citations without losing a literal clause and restores exact durable IDs', () => {
    const ledger = completeLedger();
    const wire = requirementCoverageExtractionClauses(ledger);
    expect(wire.map((row) => row.text)).toEqual(
      ledger.clauses.map((row) => row.text),
    );
    expect(wire.every((row) => Object.keys(row).join(',') === 'id,text')).toBe(
      true,
    );
    const alias = new Map(
      ledger.clauses.map((row, index) => [row.id, `c${index}`]),
    );
    const restored = buildRequirementCoverage(context, [
      {
        requirements: ledger.requirements.map((row) => ({
          ...row,
          clauseIds: row.clauseIds.map((id) => alias.get(id)),
        })),
        dispositions: ledger.dispositions.map((row) => ({
          ...row,
          clauseId: alias.get(row.clauseId),
        })),
      },
    ]);
    expect(restored).toEqual(ledger);
    expect(
      validateRequirementCoverage(context, restored).structuralComplete,
    ).toBe(true);
    const invalid = buildRequirementCoverage(context, [
      {
        dispositions: [
          { clauseId: 'c9999', type: 'unknown', requirementIds: [] },
        ],
      },
    ]);
    expect(validateRequirementCoverage(context, invalid).complete).toBe(false);
  });
  it('retains all18 actual role clauses and About/team material, with exact full UTF-16 spans/hashes', () => {
    const clauses = buildPostingClauses(context);
    expect(actualRoleClauses).toHaveLength(18);
    for (const text of actualRoleClauses)
      expect(clauses.some((clause) => clause.text.includes(text))).toBe(true);
    expect(
      clauses.some((clause) =>
        /platform.*reliability|team.*reliability/i.test(clause.text),
      ),
    ).toBe(true);
    for (const clause of clauses) {
      expect(publicPosting.slice(clause.spanStart, clause.spanEnd)).toBe(
        clause.text,
      );
      expect(clause.hash).toBe(
        createHash('sha256').update(clause.text).digest('hex'),
      );
    }
    expect(new Set(clauses.map((clause) => clause.id)).size).toBe(
      clauses.length,
    );
  });
  it('preserves inline HTML/entities, surrogate pairs, line offsets, and repeated criteria', () => {
    const raw =
      '<h2>About the role</h2>\r\n<p>🚀 Own <strong>critical</strong> flows &amp; incident response.</p>\n<li>8+ years platform experience.</li><li>8+ years platform experience.</li>';
    const ctx = { ...context, sourceText: raw };
    const clauses = buildPostingClauses(ctx);
    expect(
      clauses.filter((clause) => clause.text.includes('8+ years')),
    ).toHaveLength(2);
    expect(
      clauses.some((clause) =>
        clause.text.includes('<strong>critical</strong>'),
      ),
    ).toBe(true);
    for (const clause of clauses)
      expect(raw.slice(clause.spanStart, clause.spanEnd)).toBe(clause.text);
    expect(clauses.at(-1)?.id).not.toBe(clauses.at(-2)?.id);
  });
  it('starts incomplete and never derives requirement importance from headings', () => {
    const ledger = buildRequirementCoverageSource(context);
    expect(ledger.requirements).toEqual([]);
    expect(validateRequirementCoverage(context, ledger).complete).toBe(false);
    const completed = completeLedger();
    expect(
      completed.requirements.every((row) => row.importance === 'unknown'),
    ).toBe(true);
    expect(
      validateRequirementCoverage(context, completed).structuralComplete,
    ).toBe(true);
    expect(completed.audit).toBeUndefined(); // Structural mapping is not semantic/provider proof.
  });
  it('merges explicit reciprocal mappings, strips model audit/source identity, and seeds missing unknowns', () => {
    const full = completeLedger();
    const merged = buildRequirementCoverage(context, [
      {
        requirementCoverage: {
          ...full,
          sourceFingerprint: 'forged',
          audit: { fingerprint: 'forged' },
          clauses: [],
        },
      },
    ]);
    expect(merged.audit).toBeUndefined();
    expect(merged.sourceFingerprint).toBe(context.sourceFingerprint);
    expect(merged.clauses).toEqual(full.clauses);
    expect(validateRequirementCoverage(context, merged).complete).toBe(true);
    const body = merged.clauses.find((row) => row.kind === 'body')!;
    const partial = buildRequirementCoverage(context, [
      {
        requirements: full.requirements,
        dispositions: full.dispositions.filter(
          (row) => row.clauseId !== body.id,
        ),
      },
    ]);
    expect(
      validateRequirementCoverage(context, partial).uncoveredClauseIds,
    ).toContain(body.id);
  });
  it.each([
    [
      'stale source',
      (l: CoverageLedger) => {
        l.sourceFingerprint = 'stale';
      },
    ],
    [
      'stale version',
      (l: CoverageLedger) => {
        l.sourceVersion = 2;
      },
    ],
    [
      'stale extraction',
      (l: CoverageLedger) => {
        l.extractionFingerprint = 'stale';
      },
    ],
    [
      'stale prepared',
      (l: CoverageLedger) => {
        l.preparedFingerprint = 'stale';
      },
    ],
    [
      'invalid offset',
      (l: CoverageLedger) => {
        l.clauses[0].spanStart += 1;
      },
    ],
    [
      'altered text',
      (l: CoverageLedger) => {
        l.clauses[0].text = 'partial summary';
      },
    ],
    [
      'forged hash',
      (l: CoverageLedger) => {
        l.clauses[0].hash = 'bad';
      },
    ],
    [
      'missing manifest',
      (l: CoverageLedger) => {
        l.clauses.pop();
      },
    ],
    [
      'duplicate mapping',
      (l: CoverageLedger) => {
        l.dispositions.push(l.dispositions[0]);
      },
    ],
    [
      'unknown disposition',
      (l: CoverageLedger) => {
        l.dispositions[0].type = 'unknown';
      },
    ],
    [
      'orphan requirement',
      (l: CoverageLedger) => {
        l.requirements[0].clauseIds = ['not-a-clause'];
      },
    ],
    [
      'orphan disposition',
      (l: CoverageLedger) => {
        l.dispositions[0].requirementIds = ['not-a-requirement'];
      },
    ],
  ])('refuses %s', (_label, corrupt) => {
    const ledger = structuredClone(completeLedger());
    corrupt(ledger);
    expect(validateRequirementCoverage(context, ledger).complete).toBe(false);
  });
  it('refuses role_context with no mapped literal meaning and blanket About/team exclusions', () => {
    const ledger = completeLedger();
    const clause = ledger.clauses.find((row) => row.kind === 'body')!;
    ledger.dispositions = ledger.dispositions.map((row) =>
      row.clauseId === clause.id
        ? { clauseId: clause.id, type: 'role_context', requirementIds: [] }
        : row,
    );
    expect(validateRequirementCoverage(context, ledger).complete).toBe(false);
    ledger.dispositions = ledger.dispositions.map((row) =>
      row.clauseId === clause.id
        ? {
            clauseId: clause.id,
            type: 'nonrequirement',
            requirementIds: [],
            exclusionRule: 'section_heading',
          }
        : row,
    );
    expect(validateRequirementCoverage(context, ledger).complete).toBe(false);
  });
  it('admits literal nonmaterial proposals structurally but supplies no model-only proof', () => {
    const ctx = {
      ...context,
      sourceText: 'Company benefit: health insurance.',
    };
    const ledger = buildRequirementCoverage(ctx, [
      {
        dispositions: [
          {
            clauseId: buildPostingClauses(ctx)[0].id,
            type: 'nonrequirement',
            requirementIds: [],
            exclusionRule: 'literal_nonmaterial_audit',
          },
        ],
        audit: { fingerprint: 'self-certified' },
      },
    ]);
    expect(validateRequirementCoverage(ctx, ledger).structuralComplete).toBe(
      true,
    );
    expect(ledger.audit).toBeUndefined(); // Verified gate requires separate recorded global audit.
  });
  it('rejects malformed optional/open arrays safely', () => {
    for (const value of [
      null,
      {},
      { clauses: [null], requirements: [null], dispositions: [null] },
    ]) {
      expect(validateRequirementCoverage(context, value).complete).toBe(false);
    }
    expect(
      validateRequirementCoverage(
        context,
        buildRequirementCoverage(context, [
          { requirements: [null], dispositions: [null] },
        ]),
      ).complete,
    ).toBe(false);
  });
  it('rejects bloated mapped source text instead of truncating it', () => {
    const ctx = { ...context, sourceText: 'Must own reliability.' };
    const ledger = completeLedger(ctx);
    ledger.requirements[0].text = 'x'.repeat(1000);
    expect(validateRequirementCoverage(ctx, ledger).errors.join(' ')).toContain(
      'admission bound',
    );
  });
  it('counts repeated mapped text occurrences in the pre-admitted audit bound', () => {
    const ctx = {
      ...context,
      sourceText: Array.from(
        { length: 5 },
        (_, index) => `Own reliability domain ${index}.`,
      ).join('\n'),
    };
    const ledger = buildRequirementCoverageSource(ctx);
    ledger.requirements = [
      {
        id: 'all-context',
        text: ctx.sourceText,
        clauseIds: ledger.clauses.map((clause) => clause.id),
        importance: 'unknown',
      },
    ];
    ledger.dispositions = ledger.clauses.map((clause) => ({
      clauseId: clause.id,
      type: 'role_context',
      requirementIds: ['all-context'],
    }));
    expect(validateRequirementCoverage(ctx, ledger).errors.join(' ')).toContain(
      'Repeated mapped source text',
    );
  });
  it('never certifies a summary as full raw source and prefers canonical captured content', () => {
    const summaryOnly = requirementCoverageContextForOpportunity({
      descriptionSummary: 'Short summary',
      sourceContentFingerprint: 'native-fp',
      sourceContentVersion: 1,
    });
    expect(summaryOnly.sourceText).toBe('');
    expect(
      validateRequirementCoverage(
        summaryOnly,
        buildRequirementCoverageSource(summaryOnly),
      ).complete,
    ).toBe(false);
    const canonical = requirementCoverageContextForOpportunity({
      descriptionRaw: 'Derived summary changed',
      sourceContentJson: JSON.stringify({
        descriptionRaw: 'Full canonical raw criterion',
      }),
      sourceContentFingerprint: 'native-fp',
      sourceContentVersion: 1,
    });
    expect(canonical.sourceText).toBe('Full canonical raw criterion');
  });
  it('derives cache identity from native source/prepared material, never injected ledger claims', () => {
    const opportunity = {
      descriptionRaw: 'Material source 🚀',
      sourceContentFingerprint: 'native-fp',
      sourceContentVersion: 1,
      preparedPostingFingerprint: 'native-prepared',
    };
    const first = requirementCoverageContextForOpportunity(opportunity);
    expect(
      requirementCoverageContextForOpportunity({
        ...opportunity,
        preparedPostingJson: JSON.stringify({
          requirementCoverage: { extractionFingerprint: 'fake' },
        }),
      }),
    ).toEqual(first);
    expect(
      requirementCoverageContextForOpportunity({
        ...opportunity,
        descriptionRaw: 'changed',
      }).extractionFingerprint,
    ).not.toBe(first.extractionFingerprint);
    expect(
      requirementCoverageContextForOpportunity({
        ...opportunity,
        preparedPostingFingerprint: 'changed',
      }).extractionFingerprint,
    ).not.toBe(first.extractionFingerprint);
  });
});
