import { createHash } from 'node:crypto';
import type { DecisionResult } from '@happyvertical/ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import capturedPending from './fixtures/ats/wealthsimple-source-coverage-pending.json';
import { prepareOpportunityPosting } from './opportunity-posting-preparation.js';
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
  type PreparedRequirementCoverageAudit,
  preflightRequirementCoverageAudit,
  preflightRequirementCoverageLifecycle,
  prepareRequirementCoverageAudit,
  REQUIREMENT_COVERAGE_AUDIT_VERSION,
  readRecordedRequirementCoverageOutcome,
  readVerifiedOpportunityRequirementCoverage,
  requirementCoverageAuditReservationCeiling,
  requirementCoverageClauseQuestionKey,
  requirementCoverageHasLosslessWireClauses,
  requirementCoverageLedgerFingerprint,
  requirementCoverageSourceDependencyFingerprint,
  resolveRequirementCoverageAudit,
  validateVerifiedRequirementCoverage,
} from './opportunity-requirement-coverage-provider.js';

const publicPosting =
  "Build something people love\nWealthsimple is Canada’s leading financial innovator. The company offers a full suite of simple, sophisticated financial products across managed investing, do-it-yourself trading, cryptocurrency, tax filing, spending and saving. Wealthsimple currently serves more than 4 million Canadians and holds over $155 billion in assets under administration. The company was founded in 2014 by a team of financial experts and technology entrepreneurs, and is headquartered in Toronto, Canada.\n\nWe're proud of what we've built — and we're just getting started. Read our Culture Manual and learn more about how we work .\n\nAbout the team\nWe build the products and infrastructure that millions of Canadians trust with their financial lives. Data & Engineering at Wealthsimple spans everything from the client-facing apps to the systems running underneath them — and we hold ourselves to a high bar on both. We move fast, but we build thoughtfully: quality, security, and scalability aren’t trade-offs here, they’re the standard.\nThe Production Engineering team sits within Platform Experience, on the boundary between Platform and Product. Our mandate is to raise reliability across Wealthsimple’s most critical flows — reducing incidents, helping service teams ship safely, and turning individual fixes into platform-wide improvements. We measure ourselves against two targets: 99.9% uptime on critical flows, and fewer than 1% of weekly active users experiencing errors in the app. If you want to work on hard problems with people who care deeply about craft, you’ll fit right in.\n \nAbout the role\nThis is a new role — one that doesn’t yet exist at Wealthsimple — and it’s a meaningful one. As a Staff Software Developer on Production Engineering, you’ll bring senior technical leadership to the work of making Wealthsimple more reliable at scale. You’ll work across platform and product teams, identify the highest-leverage reliability problems, and build solutions that don’t just fix the immediate issue but raise the floor for everyone. This isn’t a role where you sit in one corner of the codebase. It’s a role where you shape how engineering gets done across the company.\n \nWhat you’ll do\n\n- Improve the platform to prevent incidents — designing and driving adoption of guardrails, sensible defaults, and engineering standards that reduce the likelihood of failures across services\n\n- Build tooling that reduces time to mitigation when incidents occur, including contributing to our in-house product on AI-assisted incident response\n\n- Own the investigation and follow-through on load test findings — translating results into concrete reliability improvements across critical flows\n\n- Work across platform and product engineering teams as a technical influencer — participating in architecture and readiness reviews, coaching service owners, and driving adoption of scalable reliability practices\n\n- Identify recurring failure patterns and design platform-level fixes that prevent them from showing up again in a different service\n\n- Contribute to the team’s reliability syncs with product engineering, helping align on incident themes, critical-flow risks, and the next highest-leverage initiatives\n\n \nSkills you bring\n\n- 8+ years of software engineering experience, with significant time in platform, infrastructure, or SRE work\n\n- Demonstrated track record of improving reliability at scale — reducing incidents, building guardrails, or driving operational standards across multiple teams\n\n- Strong proficiency in backend systems and distributed architecture; you can diagnose complex failure modes across a service mesh\n\n- Experience with load testing and capacity planning, and the ability to translate findings into concrete engineering improvements\n\n- Proven ability to work across engineering teams as a technical influencer — driving adoption of standards and practices without direct authority\n\n- Familiarity with Kubernetes, Helm, Argo and modern deployment tooling\n\n- Strong written and verbal communication — comfortable presenting findings and recommendations to both engineering teams and senior leadership\n\n \nWho you are\n\n- You think in systems — you’re not looking for the fix, you’re looking for what caused the problem and how to make sure it doesn’t happen elsewhere\n\n- You’re comfortable working without direct authority; you build credibility through the quality of your thinking and the clarity of your recommendations\n\n- You hold a high bar for operational excellence without making it someone else’s problem to catch up to — you bring people along\n\n- You’re energised by ambiguity, not slowed down by it; you know how to prioritise when everything feels urgent\n\n- You’re curious about where AI-assisted tooling is headed in reliability engineering, and you want to help shape how we use it — not just observe it from a distance\n\nWhy Wealthsimple?\n🌸 Top-tier health benefits and life insurance\n📈 Long-term group savings with employer match, through Wealthsimple for Business\n🌴 20 vacation days, 4 wellness days, and unlimited sick and mental health days per year*\n✈️ 90 days away: work outside Canada for up to 90 days per year*\n👥 Employee resource groups, including Rainbow (2SLGBTQ), Women of WS, and Black at WS\n🌎 We are a hybrid team with over 1,500 employees across North America. The people are one of the best parts of working here: you'll collaborate with incredibly talented, curious, and driven teammates who are deeply committed to doing great work.\n\n*Unlimited paid sick days, Wellness Days and the 90 day away program do not apply to certain roles.\n\nICYMI\nTechnology & Innovation at Wealthsimple: We move quickly and build thoughtfully. That means we're always looking for better ways to work — whether that's new tools, AI, or rethinking how we approach a problem. We don't expect you to have all the answers, but we do expect curiosity and a willingness to evolve alongside the products we're building.\n\nInclusion Statement: We're building products for a diverse world, and we need a diverse team to do it well. We strongly encourage applications from everyone, regardless of race, religion, colour, national origin, gender, sexual orientation, age, marital status, or disability status.\n\nAccessibility Statement: We're committed to an accessible hiring experience. If you need any accommodations throughout the interview process, please let us know — we'll work with you to make sure you have what you need. We also welcome any feedback on how we can better accommodate candidates with accessibility needs.\n\nAI in Hiring: We may use artificial intelligence (AI) tools to support parts of our hiring process, such as reviewing applications, analyzing resumes, or assessing responses. These tools assist our team but don't replace human judgment – all final hiring decisions are made by people. If you have questions about how your data is used, reach out to us.";

const mocks = vi.hoisted(() => ({ query: vi.fn(), attestCompleted: vi.fn() }));
vi.mock('@happyvertical/smrt-core', () => ({
  resolveDatabase: async () => ({ query: mocks.query }),
}));
vi.mock('./opportunity-requirement-coverage-repair-job.js', () => ({
  attestCompletedOpportunityRequirementCoverageRepair: mocks.attestCompleted,
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
        {
          type: 'predicate',
          probability: prepared.contextQuestionKeys.includes(key) ? 0.1 : 0.9,
        },
      ]),
    ),
  } as DecisionResult;
  ledger.audit = resolveRequirementCoverageAudit(prepared, result, 'receipt-1');
  return { context, ledger, prepared, result };
}

function recordedOutput(
  prepared: PreparedRequirementCoverageAudit,
  result: DecisionResult,
  opportunityId: string,
  requestId: string,
) {
  const fp = createHash('sha256')
    .update(
      JSON.stringify({
        ledger: prepared.ledgerFingerprint,
        request: prepared.request,
      }),
    )
    .digest('hex');
  return {
    output_json: JSON.stringify(result),
    owner_request_id: requestId,
    request_id: requestId,
    opportunity_id: opportunityId,
    request_opportunity_id: opportunityId,
    content_fingerprint: prepared.context.sourceFingerprint,
    request_content_fingerprint: prepared.context.sourceFingerprint,
    input_fingerprint: fp,
    request_input_fingerprint: fp,
    feature: 'opportunity-source-requirement-coverage',
    request_feature: 'opportunity-source-requirement-coverage',
    output_schema_version: REQUIREMENT_COVERAGE_AUDIT_VERSION,
    prompt_version: REQUIREMENT_COVERAGE_AUDIT_VERSION,
    prepared_payload_version: REQUIREMENT_COVERAGE_AUDIT_VERSION,
    result_status: 'completed',
    request_status: 'succeeded',
    accounting_basis: 'actual',
    actual_total_tokens: 12,
    model: 'jev-test',
    request_model: 'jev-test',
    profile: 'typesafe-opportunity-source-coverage',
    request_profile: 'typesafe-opportunity-source-coverage',
    tenant_id: '',
    owner_user_id: '',
    candidate_profile_id: '',
    request_tenant_id: '',
    request_owner_user_id: '',
    request_candidate_profile_id: '',
  };
}

describe('source requirement coverage audit', () => {
  it('fits the actual 42-clause 46-row repaired ledger and preserves every independent answer', () => {
    const context: RequirementCoverageContext = {
      sourceText: publicPosting,
      sourceFingerprint:
        'b6ac3f8a55585780e534f408fb7decf4a8b5d260bc5d921d7b4facd5d9b45a11',
      sourceVersion: 1,
      extractionFingerprint: 'public-extraction',
    };
    const ledger = buildRequirementCoverageSource(context);
    const proposal = {
      requirements: [
        {
          id: 'r5',
          text: 'Bring senior technical leadership to the work of making Wealthsimple more reliable at scale.',
          clauseIds: ['clause:5bb66be711ba984a066cb9df'],
          importance: 'required',
        },
        {
          id: 'r6',
          text: 'Work across platform and product teams.',
          clauseIds: ['clause:5bb66be711ba984a066cb9df'],
          importance: 'required',
        },
        {
          id: 'r7',
          text: 'Identify the highest-leverage reliability problems.',
          clauseIds: ['clause:5bb66be711ba984a066cb9df'],
          importance: 'required',
        },
        {
          id: 'r8',
          text: 'Build solutions that fix the immediate issue and raise the floor for everyone.',
          clauseIds: ['clause:5bb66be711ba984a066cb9df'],
          importance: 'required',
        },
        {
          id: 'r9',
          text: 'Shape how engineering gets done across the company.',
          clauseIds: ['clause:5bb66be711ba984a066cb9df'],
          importance: 'required',
        },
        {
          id: 'r10',
          text: 'Improve the platform to prevent incidents by designing guardrails, sensible defaults, and engineering standards that reduce the likelihood of failures across services.',
          clauseIds: ['clause:99adec899b9cca9a96a5db07'],
          importance: 'required',
        },
        {
          id: 'r11',
          text: 'Drive adoption of guardrails, sensible defaults, and engineering standards that reduce the likelihood of failures across services.',
          clauseIds: ['clause:99adec899b9cca9a96a5db07'],
          importance: 'required',
        },
        {
          id: 'r12',
          text: 'Build tooling that reduces time to mitigation when incidents occur.',
          clauseIds: ['clause:ab75ddd15e9153deca2d1c74'],
          importance: 'required',
        },
        {
          id: 'r13',
          text: 'Contribute to the in-house product on AI-assisted incident response.',
          clauseIds: ['clause:ab75ddd15e9153deca2d1c74'],
          importance: 'required',
        },
        {
          id: 'r14',
          text: 'Own the investigation and follow-through on load test findings.',
          clauseIds: ['clause:682797740997fc2f0380b9e6'],
          importance: 'required',
        },
        {
          id: 'r15',
          text: 'Translate load test results into concrete reliability improvements across critical flows.',
          clauseIds: ['clause:682797740997fc2f0380b9e6'],
          importance: 'required',
        },
        {
          id: 'r16',
          text: 'Work across platform and product engineering teams as a technical influencer.',
          clauseIds: ['clause:4bc6e8cf8ae4474c102b33d8'],
          importance: 'required',
        },
        {
          id: 'r17',
          text: 'Participate in architecture and readiness reviews.',
          clauseIds: ['clause:4bc6e8cf8ae4474c102b33d8'],
          importance: 'required',
        },
        {
          id: 'r18',
          text: 'Coach service owners.',
          clauseIds: ['clause:4bc6e8cf8ae4474c102b33d8'],
          importance: 'required',
        },
        {
          id: 'r19',
          text: 'Drive adoption of scalable reliability practices.',
          clauseIds: ['clause:4bc6e8cf8ae4474c102b33d8'],
          importance: 'required',
        },
        {
          id: 'r20',
          text: 'Identify recurring failure patterns.',
          clauseIds: ['clause:912fcb0fa2fec8a108376512'],
          importance: 'required',
        },
        {
          id: 'r21',
          text: 'Design platform-level fixes that prevent recurring failure patterns from showing up again in a different service.',
          clauseIds: ['clause:912fcb0fa2fec8a108376512'],
          importance: 'required',
        },
        {
          id: 'r22',
          text: 'Contribute to the team’s reliability syncs with product engineering.',
          clauseIds: ['clause:08ea52bc4fc05123007f0fb2'],
          importance: 'required',
        },
        {
          id: 'r23',
          text: 'Help align on incident themes, critical-flow risks, and the next highest-leverage initiatives.',
          clauseIds: ['clause:08ea52bc4fc05123007f0fb2'],
          importance: 'required',
        },
        {
          id: 'r24',
          text: 'Have 8+ years of software engineering experience.',
          clauseIds: ['clause:a30b9d1d9f8eac3a8f581dce'],
          importance: 'required',
        },
        {
          id: 'r25',
          text: 'Have significant time in platform, infrastructure, or SRE work.',
          clauseIds: ['clause:a30b9d1d9f8eac3a8f581dce'],
          importance: 'required',
        },
        {
          id: 'r26',
          text: 'Have a demonstrated track record of improving reliability at scale through reducing incidents, building guardrails, or driving operational standards across multiple teams.',
          clauseIds: ['clause:0a154200359c45b02a0ffa4d'],
          importance: 'required',
        },
        {
          id: 'r27',
          text: 'Have strong proficiency in backend systems.',
          clauseIds: ['clause:0152c8bf71033ef54ff88529'],
          importance: 'required',
        },
        {
          id: 'r28',
          text: 'Have strong proficiency in distributed architecture.',
          clauseIds: ['clause:0152c8bf71033ef54ff88529'],
          importance: 'required',
        },
        {
          id: 'r29',
          text: 'Be able to diagnose complex failure modes across a service mesh.',
          clauseIds: ['clause:0152c8bf71033ef54ff88529'],
          importance: 'required',
        },
        {
          id: 'r30',
          text: 'Have experience with load testing and capacity planning.',
          clauseIds: ['clause:983f42723b4b563b7191c8a1'],
          importance: 'required',
        },
        {
          id: 'r31',
          text: 'Be able to translate load testing and capacity planning findings into concrete engineering improvements.',
          clauseIds: ['clause:983f42723b4b563b7191c8a1'],
          importance: 'required',
        },
        {
          id: 'r32',
          text: 'Have a proven ability to work across engineering teams as a technical influencer, driving adoption of standards and practices without direct authority.',
          clauseIds: ['clause:39e77d46c7f6138e1e773642'],
          importance: 'required',
        },
        {
          id: 'r33',
          text: 'Have familiarity with Kubernetes.',
          clauseIds: ['clause:944b081adab613a2c5cf45b4'],
          importance: 'required',
        },
        {
          id: 'r34',
          text: 'Have familiarity with Helm.',
          clauseIds: ['clause:944b081adab613a2c5cf45b4'],
          importance: 'required',
        },
        {
          id: 'r35',
          text: 'Have familiarity with Argo.',
          clauseIds: ['clause:944b081adab613a2c5cf45b4'],
          importance: 'required',
        },
        {
          id: 'r36',
          text: 'Have familiarity with modern deployment tooling.',
          clauseIds: ['clause:944b081adab613a2c5cf45b4'],
          importance: 'required',
        },
        {
          id: 'r37',
          text: 'Have strong written communication skills.',
          clauseIds: ['clause:bd618864a1b28ca723696e85'],
          importance: 'required',
        },
        {
          id: 'r38',
          text: 'Have strong verbal communication skills.',
          clauseIds: ['clause:bd618864a1b28ca723696e85'],
          importance: 'required',
        },
        {
          id: 'r39',
          text: 'Be comfortable presenting findings and recommendations to both engineering teams and senior leadership.',
          clauseIds: ['clause:bd618864a1b28ca723696e85'],
          importance: 'required',
        },
        {
          id: 'r40',
          text: 'Think in systems: look for what caused a problem and how to make sure it does not happen elsewhere, rather than looking only for the fix.',
          clauseIds: ['clause:0f4a8f3b136fde69ddff6af1'],
          importance: 'required',
        },
        {
          id: 'r41',
          text: 'Be comfortable working without direct authority.',
          clauseIds: ['clause:8204d1637f7bfe6b2326f012'],
          importance: 'required',
        },
        {
          id: 'r42',
          text: 'Build credibility through the quality of your thinking and the clarity of your recommendations.',
          clauseIds: ['clause:8204d1637f7bfe6b2326f012'],
          importance: 'required',
        },
        {
          id: 'r43',
          text: 'Hold a high bar for operational excellence without making it someone else’s problem to catch up to.',
          clauseIds: ['clause:7f46b835eb5993e19f31f955'],
          importance: 'required',
        },
        {
          id: 'r44',
          text: 'Bring people along.',
          clauseIds: ['clause:7f46b835eb5993e19f31f955'],
          importance: 'required',
        },
        {
          id: 'r45',
          text: 'Be energised by ambiguity, not slowed down by it.',
          clauseIds: ['clause:0b517d07f65788d46a30efef'],
          importance: 'required',
        },
        {
          id: 'r46',
          text: 'Know how to prioritise when everything feels urgent.',
          clauseIds: ['clause:0b517d07f65788d46a30efef'],
          importance: 'required',
        },
        {
          id: 'r47',
          text: 'Be curious about where AI-assisted tooling is headed in reliability engineering.',
          clauseIds: ['clause:cd3cbbdf00be859aa4448900'],
          importance: 'required',
        },
        {
          id: 'r48',
          text: 'Want to help shape how AI-assisted tooling is used in reliability engineering, not just observe it from a distance.',
          clauseIds: ['clause:cd3cbbdf00be859aa4448900'],
          importance: 'required',
        },
        {
          id: 'repair_r1',
          text: 'Be curious about better ways to work, including new tools, AI, or rethinking how to approach a problem.',
          clauseIds: ['clause:9af48b8468b6c89a022e31d4'],
          importance: 'unknown',
        },
        {
          id: 'repair_r2',
          text: 'Be willing to evolve alongside the products Wealthsimple is building.',
          clauseIds: ['clause:9af48b8468b6c89a022e31d4'],
          importance: 'unknown',
        },
      ],
      dispositions: [
        {
          clauseId: 'clause:711e6a637ddaaaf2d37dcc25',
          type: 'nonrequirement',
          requirementIds: [],
          exclusionRule: 'literal_nonmaterial_audit',
        },
        {
          clauseId: 'clause:2e745252ccde07b2a9761db7',
          type: 'nonrequirement',
          requirementIds: [],
          exclusionRule: 'literal_nonmaterial_audit',
        },
        {
          clauseId: 'clause:577d2c76eda37e6470a7ddf6',
          type: 'nonrequirement',
          requirementIds: [],
          exclusionRule: 'literal_nonmaterial_audit',
        },
        {
          clauseId: 'clause:901544d8e9eca92625812418',
          type: 'nonrequirement',
          requirementIds: [],
          exclusionRule: 'section_heading',
        },
        {
          clauseId: 'clause:f8a13f672a2ff97edf065765',
          type: 'source_context',
          requirementIds: [],
        },
        {
          clauseId: 'clause:988e296f3ffceaa11df17e9a',
          type: 'source_context',
          requirementIds: [],
        },
        {
          clauseId: 'clause:7dc43cbc9b9e6755c50dfa68',
          type: 'nonrequirement',
          requirementIds: [],
          exclusionRule: 'section_heading',
        },
        {
          clauseId: 'clause:5bb66be711ba984a066cb9df',
          type: 'role_context',
          requirementIds: ['r5', 'r6', 'r7', 'r8', 'r9'],
        },
        {
          clauseId: 'clause:161d34e927e8e3d49b1af4ea',
          type: 'nonrequirement',
          requirementIds: [],
          exclusionRule: 'section_heading',
        },
        {
          clauseId: 'clause:99adec899b9cca9a96a5db07',
          type: 'role_duty',
          requirementIds: ['r10', 'r11'],
        },
        {
          clauseId: 'clause:ab75ddd15e9153deca2d1c74',
          type: 'role_duty',
          requirementIds: ['r12', 'r13'],
        },
        {
          clauseId: 'clause:682797740997fc2f0380b9e6',
          type: 'role_duty',
          requirementIds: ['r14', 'r15'],
        },
        {
          clauseId: 'clause:4bc6e8cf8ae4474c102b33d8',
          type: 'role_duty',
          requirementIds: ['r16', 'r17', 'r18', 'r19'],
        },
        {
          clauseId: 'clause:912fcb0fa2fec8a108376512',
          type: 'role_duty',
          requirementIds: ['r20', 'r21'],
        },
        {
          clauseId: 'clause:08ea52bc4fc05123007f0fb2',
          type: 'role_duty',
          requirementIds: ['r22', 'r23'],
        },
        {
          clauseId: 'clause:d56e9a720e7417337062952e',
          type: 'nonrequirement',
          requirementIds: [],
          exclusionRule: 'literal_nonmaterial_audit',
        },
        {
          clauseId: 'clause:a30b9d1d9f8eac3a8f581dce',
          type: 'material_requirement',
          requirementIds: ['r24', 'r25'],
        },
        {
          clauseId: 'clause:0a154200359c45b02a0ffa4d',
          type: 'material_requirement',
          requirementIds: ['r26'],
        },
        {
          clauseId: 'clause:0152c8bf71033ef54ff88529',
          type: 'material_requirement',
          requirementIds: ['r27', 'r28', 'r29'],
        },
        {
          clauseId: 'clause:983f42723b4b563b7191c8a1',
          type: 'material_requirement',
          requirementIds: ['r30', 'r31'],
        },
        {
          clauseId: 'clause:39e77d46c7f6138e1e773642',
          type: 'material_requirement',
          requirementIds: ['r32'],
        },
        {
          clauseId: 'clause:944b081adab613a2c5cf45b4',
          type: 'material_requirement',
          requirementIds: ['r33', 'r34', 'r35', 'r36'],
        },
        {
          clauseId: 'clause:bd618864a1b28ca723696e85',
          type: 'material_requirement',
          requirementIds: ['r37', 'r38', 'r39'],
        },
        {
          clauseId: 'clause:059c95bb008a4e9e3d43562e',
          type: 'nonrequirement',
          requirementIds: [],
          exclusionRule: 'section_heading',
        },
        {
          clauseId: 'clause:0f4a8f3b136fde69ddff6af1',
          type: 'material_requirement',
          requirementIds: ['r40'],
        },
        {
          clauseId: 'clause:8204d1637f7bfe6b2326f012',
          type: 'material_requirement',
          requirementIds: ['r41', 'r42'],
        },
        {
          clauseId: 'clause:7f46b835eb5993e19f31f955',
          type: 'material_requirement',
          requirementIds: ['r43', 'r44'],
        },
        {
          clauseId: 'clause:0b517d07f65788d46a30efef',
          type: 'material_requirement',
          requirementIds: ['r45', 'r46'],
        },
        {
          clauseId: 'clause:cd3cbbdf00be859aa4448900',
          type: 'material_requirement',
          requirementIds: ['r47', 'r48'],
        },
        {
          clauseId: 'clause:bc1c395190adc33c463c7014',
          type: 'nonrequirement',
          requirementIds: [],
          exclusionRule: 'literal_nonmaterial_audit',
        },
        {
          clauseId: 'clause:0b0c3b93aec978cf28190b36',
          type: 'nonrequirement',
          requirementIds: [],
          exclusionRule: 'literal_nonmaterial_audit',
        },
        {
          clauseId: 'clause:7247c020e4f78d1b4f6b9119',
          type: 'nonrequirement',
          requirementIds: [],
          exclusionRule: 'literal_nonmaterial_audit',
        },
        {
          clauseId: 'clause:43bd255de96590cc8efdb651',
          type: 'nonrequirement',
          requirementIds: [],
          exclusionRule: 'literal_nonmaterial_audit',
        },
        {
          clauseId: 'clause:a8b870bd266516bac5200dad',
          type: 'source_context',
          requirementIds: [],
        },
        {
          clauseId: 'clause:40c20554b5af2f2934b76bd8',
          type: 'nonrequirement',
          requirementIds: [],
          exclusionRule: 'literal_nonmaterial_audit',
        },
        {
          clauseId: 'clause:43718a8cbedb50e33e4cc8ad',
          type: 'source_context',
          requirementIds: [],
        },
        {
          clauseId: 'clause:9ecf22ac7b288b9a2dd23538',
          type: 'source_context',
          requirementIds: [],
        },
        {
          clauseId: 'clause:58a006bc9c4b3a07f46e24a8',
          type: 'nonrequirement',
          requirementIds: [],
          exclusionRule: 'literal_nonmaterial_audit',
        },
        {
          clauseId: 'clause:9af48b8468b6c89a022e31d4',
          type: 'material_requirement',
          requirementIds: ['repair_r1', 'repair_r2'],
        },
        {
          clauseId: 'clause:9ec1e0fbc4df7feca1a069ce',
          type: 'nonrequirement',
          requirementIds: [],
          exclusionRule: 'literal_nonmaterial_audit',
        },
        {
          clauseId: 'clause:1ed16f6271b199c995c195a0',
          type: 'nonrequirement',
          requirementIds: [],
          exclusionRule: 'literal_nonmaterial_audit',
        },
        {
          clauseId: 'clause:4ae56f27a5fadee6f664d799',
          type: 'nonrequirement',
          requirementIds: [],
          exclusionRule: 'literal_nonmaterial_audit',
        },
      ],
    };
    ledger.requirements =
      proposal.requirements as CoverageLedger['requirements'];
    ledger.dispositions =
      proposal.dispositions as CoverageLedger['dispositions'];
    expect(
      validateRequirementCoverageAuditAdmission(context, ledger).errors,
    ).toEqual([]);
    const prepared = prepareRequirementCoverageAudit(context, ledger);
    expect(ledger.clauses).toHaveLength(42);
    expect(ledger.requirements).toHaveLength(46);
    expect(Object.keys(prepared.request.questions)).toHaveLength(84);
    expect(Object.keys(prepared.questionEntailmentIds)).toHaveLength(46);
    expect(prepared.contextQuestionKeys).toHaveLength(18);
    const exact = preflightRequirementCoverageAudit(prepared);
    expect(exact.fits).toBe(true);
    expect(exact.reservedTokens + 2 * (6000 + 4096)).toBeLessThanOrEqual(80000);
    const result: DecisionResult = {
      model: 'test',
      provenance: { model: 'test', provider: 'typesafe' },
      answers: Object.fromEntries(
        Object.keys(prepared.request.questions).map((key) => [
          key,
          {
            type: 'predicate',
            probability: prepared.contextQuestionKeys.includes(key)
              ? 0.15
              : 0.85,
          },
        ]),
      ),
    };
    ledger.audit = resolveRequirementCoverageAudit(
      prepared,
      result,
      'exact-receipt',
    );
    expect(Object.keys(ledger.audit.answerProbabilities)).toHaveLength(84);
    expect(validateVerifiedRequirementCoverage(context, ledger).complete).toBe(
      true,
    );
    for (const lowKey of [
      'c21_row0_entailed',
      requirementCoverageClauseQuestionKey(21, 'mapped'),
    ]) {
      const bad = structuredClone(result);
      bad.answers[lowKey] = { type: 'predicate', probability: 0.84 };
      ledger.audit = resolveRequirementCoverageAudit(
        prepared,
        bad,
        'low-receipt',
      );
      expect(ledger.audit.probabilities[ledger.clauses[21]!.id]).toBe(0.84);
      expect(
        validateVerifiedRequirementCoverage(context, ledger).complete,
      ).toBe(false);
    }
    for (const mode of ['missing', 'extra', 'malformed']) {
      const bad = structuredClone(result);
      if (mode === 'missing') delete bad.answers.c21_row0_entailed;
      else if (mode === 'extra')
        bad.answers.unasked = { type: 'predicate', probability: 0.99 };
      else
        bad.answers.c21_row0_entailed = {
          type: 'predicate',
          probability: Number.NaN,
        };
      expect(() =>
        resolveRequirementCoverageAudit(prepared, bad, 'invalid-receipt'),
      ).toThrow();
    }
    ledger.audit = resolveRequirementCoverageAudit(
      prepared,
      result,
      'binding-receipt',
    );
    const altered = structuredClone(prepared);
    altered.questionEntailmentIds.c21_row0_entailed = 'unoffered-row';
    expect(
      resolveRequirementCoverageAudit(altered, result, 'binding-receipt')
        .fingerprint,
    ).not.toBe(ledger.audit.fingerprint);
  });

  beforeEach(() => vi.resetAllMocks());

  it('binds self-contained literal clauses and row texts without policy indirection', () => {
    const { prepared, ledger } = fixture();
    const coverage =
      prepared.request.questions[
        requirementCoverageClauseQuestionKey(1, 'mapped')
      ].instructions;
    expect(coverage).toContain(JSON.stringify(ledger.clauses[1]!.text));
    expect(coverage).toContain('ALL applicant qualifications');
    expect(coverage).not.toContain('state.auditPolicy');
    const row = prepared.request.questions.c1_row0_entailed.instructions;
    expect(row).toContain(JSON.stringify(ledger.requirements[0]!.text));
    expect(row).toContain('explicitly establish');
    expect(prepared.questionEntailmentIds).toEqual({
      c1_row0_entailed: 'duty-1',
    });
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
    // A worst-case unknown future direct layout honestly declines if it does
    // not fit; a previously recorded complete ledger uses its exact request.
    expect(bound.reservedTokens).toBeGreaterThan(0);
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
    expect(question).toContain(JSON.stringify(ledger.clauses[1]!.text));
    expect(question).toContain(
      'Does this clause state an applicant qualification',
    );
    const result: DecisionResult = {
      model: 'jev-test',
      provenance: { model: 'jev-test', provider: 'typesafe' },
      answers: Object.fromEntries(
        Object.keys(prepared.request.questions).map((key) => [
          key,
          {
            type: 'predicate',
            probability: prepared.contextQuestionKeys.includes(key) ? 0.1 : 0.9,
          },
        ]),
      ),
    };
    result.answers[requirementCoverageClauseQuestionKey(1, 'nonmaterial')] = {
      type: 'predicate',
      probability: 0.151,
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
      probability: 0.15,
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
      rows: [
        recordedOutput(prepared, result, 'role-pending', 'pending-receipt'),
      ],
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
    expect(contextQuestion).toContain(JSON.stringify(ledger.clauses[0]!.text));
    expect(contextQuestion).toContain('employment/benefit terms');
    const mappedQuestion =
      prepared.request.questions[
        requirementCoverageClauseQuestionKey(1, 'mapped')
      ].instructions;
    expect(mappedQuestion).toContain('ALL applicant qualifications');
    expect(mappedQuestion).toContain(
      JSON.stringify(ledger.requirements[0]!.text),
    );
    const result: DecisionResult = {
      model: 'jev-test',
      provenance: { model: 'jev-test', provider: 'typesafe' },
      answers: Object.fromEntries(
        Object.keys(prepared.request.questions).map((key) => [
          key,
          {
            type: 'predicate',
            probability: prepared.contextQuestionKeys.includes(key)
              ? 0.05
              : 0.95,
          },
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
      probability: 0.151,
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
      probability: 0.05,
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
    ).toThrow('cardinality');
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

  it('keeps all proposed importance unknown without a separately verified classification', () => {
    const { context, ledger } = fixture();
    ledger.requirements[0]!.importance = 'required';
    const prepared = prepareRequirementCoverageAudit(context, ledger);
    expect(prepared.questionRequirementIds).toEqual({});
    const result: DecisionResult = {
      model: 'test',
      provenance: { model: 'test', provider: 'typesafe' },
      answers: Object.fromEntries(
        Object.keys(prepared.request.questions).map((key) => [
          key,
          {
            type: 'predicate',
            probability: prepared.contextQuestionKeys.includes(key)
              ? 0.05
              : 0.95,
          },
        ]),
      ),
    };
    ledger.audit = resolveRequirementCoverageAudit(
      prepared,
      result,
      'receipt-importance',
    );
    expect(ledger.audit.importance['duty-1']).toBe('unknown');
    expect(validateVerifiedRequirementCoverage(context, ledger).complete).toBe(
      true,
    );
    ledger.audit.importance['duty-1'] = 'required';
    expect(validateVerifiedRequirementCoverage(context, ledger).complete).toBe(
      false,
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
    expect(offered.size).toBe(0);
    expect(offered.size).toBeLessThan(ledger.requirements.length);
    expect(Object.keys(prepared.questionClauseIds)).toHaveLength(100);
    expect(JSON.stringify(prepared.request)).toContain(
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
            {
              type: 'predicate',
              probability: prepared.contextQuestionKeys.includes(key)
                ? 0.05
                : 0.95,
            },
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

  it('requires native GLOBAL audit and completed ancestry before selecting an allowlisted historical context', async () => {
    const opportunity = {
      id: 'native-role',
      descriptionRaw: 'Diagnose failures.',
      sourceContentFingerprint: 'source-native',
      sourceContentVersion: 1,
    };
    const planned = prepareOpportunityPosting(opportunity);
    const native = {
      ...opportunity,
      preparedPostingFingerprint: planned.fingerprint,
    };
    const context = requirementCoverageContextForOpportunity(
      native,
      'paid-v4-coverage-only4096',
    );
    const ledger = buildRequirementCoverageSource(context);
    ledger.requirements = [
      {
        id: 'native-duty',
        text: 'Diagnose failures.',
        clauseIds: [ledger.clauses[0]!.id],
        importance: 'unknown',
      },
    ];
    ledger.dispositions = [
      {
        clauseId: ledger.clauses[0]!.id,
        type: 'role_duty',
        requirementIds: ['native-duty'],
      },
    ];
    ledger.repair = {
      version: 'requirement-coverage-repair/v1-delta4096',
      baseExtractionFingerprint: context.extractionFingerprint,
      baseLedgerFingerprint: 'native-base-ledger',
      baseRequestId: 'base-native',
      feedbackAuditFingerprint: 'feedback-native-fp',
      feedbackRequestId: 'feedback-native',
      targetClauseIds: [ledger.clauses[0]!.id],
      inputFingerprint: 'repair-native-fp',
      inputTokenCeiling: 6000,
      maxOutputTokens: 4096,
      removedRequirementIds: [],
    };
    const prepared = prepareRequirementCoverageAudit(context, ledger);
    const result: DecisionResult = {
      model: 'test',
      provenance: { model: 'test', provider: 'typesafe' },
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
      'native-audit',
    );
    const cached = {
      ...native,
      preparedPostingJson: JSON.stringify({ requirementCoverage: ledger }),
    };
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(
      readVerifiedOpportunityRequirementCoverage(cached),
    ).resolves.toBeUndefined();
    mocks.query.mockImplementation(async (sql: string) =>
      sql.includes("feature = 'opportunity-source-requirement-repair'")
        ? { rows: [{ owner_request_id: 'repair-native' }] }
        : {
            rows: [
              recordedOutput(prepared, result, 'native-role', 'native-audit'),
            ],
          },
    );
    mocks.attestCompleted.mockRejectedValue(
      new Error('Missing native base/repair ancestry'),
    );
    await expect(
      readVerifiedOpportunityRequirementCoverage(cached),
    ).resolves.toBeUndefined();
    mocks.attestCompleted.mockResolvedValue({
      prepared: { context },
      completedRepair: {
        inputFingerprint: 'repair-native-fp',
        ledgerFingerprint: requirementCoverageLedgerFingerprint(ledger),
      },
    });
    const verified = await readVerifiedOpportunityRequirementCoverage(cached);
    expect(verified?.context.extractionFingerprint).toBe(
      context.extractionFingerprint,
    );
    expect(verified?.ledger.requirements).toHaveLength(1);
    expect(mocks.attestCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceContentFingerprint: 'source-native',
        sourceContentVersion: 1,
        preparedPostingFingerprint: planned.fingerprint,
      }),
      expect.objectContaining({
        baseRequestId: 'base-native',
        repairRequestId: 'repair-native',
      }),
    );
    for (const changed of [
      { descriptionRaw: 'Different source.' },
      { sourceContentFingerprint: 'new-source' },
      { sourceContentVersion: 2 },
    ])
      await expect(
        readVerifiedOpportunityRequirementCoverage({ ...cached, ...changed }),
      ).resolves.toBeUndefined();
    const forged = structuredClone(ledger);
    forged.requirements[0]!.text = 'Invented qualification';
    await expect(
      readVerifiedOpportunityRequirementCoverage({
        ...cached,
        preparedPostingJson: JSON.stringify({ requirementCoverage: forged }),
      }),
    ).resolves.toBeUndefined();
    mocks.attestCompleted.mockResolvedValue({
      prepared: { context },
      completedRepair: {
        inputFingerprint: 'repair-native-fp',
        ledgerFingerprint: 'different-merged-material',
      },
    });
    await expect(
      readVerifiedOpportunityRequirementCoverage(cached),
    ).resolves.toBeUndefined();
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
    const native = {
      ...opportunity,
      preparedPostingFingerprint:
        prepareOpportunityPosting(opportunity).fingerprint,
    };
    const context = requirementCoverageContextForOpportunity(native);
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
        c0_row0_entailed: { type: 'predicate', probability: 0.9 },
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
      ...native,
      preparedPostingJson: JSON.stringify({ requirementCoverage: ledger }),
    };
    mocks.query.mockResolvedValue({
      rows: [recordedOutput(prepared, result, 'role-1', 'negative-receipt')],
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
    const { context, ledger, prepared, result } = fixture();
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(
      hasRecordedRequirementCoverageAudit('role-1', context, ledger),
    ).resolves.toBe(false);
    mocks.query.mockResolvedValue({
      rows: [recordedOutput(prepared, result, 'role-1', 'receipt-1')],
    });
    await expect(
      hasRecordedRequirementCoverageAudit('role-1', context, ledger),
    ).resolves.toBe(true);
    expect(mocks.query.mock.calls[1]![0]).toContain(
      "COALESCE(q.candidate_profile_id, '') = ''",
    );
    result.answers[requirementCoverageClauseQuestionKey(1, 'mapped')] = {
      type: 'predicate',
      probability: 0.5,
    };
    mocks.query.mockResolvedValue({
      rows: [recordedOutput(prepared, result, 'role-1', 'receipt-1')],
    });
    await expect(
      hasRecordedRequirementCoverageAudit('role-1', context, ledger),
    ).resolves.toBe(false);
  });

  it('denies orphan, foreign, conservative or uninvoked outputs despite matching answer JSON', async () => {
    const { context, ledger, prepared, result } = fixture();
    const good = recordedOutput(prepared, result, 'role-proof', 'receipt-1');
    for (const patch of [
      { request_id: undefined },
      { request_status: 'failed' },
      { accounting_basis: 'conservative' },
      { actual_total_tokens: 0 },
      { request_tenant_id: 'foreign' },
      { request_owner_user_id: 'foreign' },
      { request_candidate_profile_id: 'foreign' },
      { tenant_id: 'foreign' },
      { owner_user_id: 'foreign' },
      { candidate_profile_id: 'foreign' },
      { request_content_fingerprint: 'old' },
      { request_input_fingerprint: 'other' },
      { request_feature: 'private-assessment' },
      { request_model: 'another-model' },
      { request_profile: 'private-profile' },
      { prompt_version: 'old-contract' },
    ]) {
      mocks.query.mockResolvedValue({ rows: [{ ...good, ...patch }] });
      await expect(
        hasRecordedRequirementCoverageAudit('role-proof', context, ledger),
      ).resolves.toBe(false);
    }
    mocks.query.mockResolvedValue({
      rows: [{ output_json: JSON.stringify(result) }],
    });
    await expect(
      hasRecordedRequirementCoverageAudit('role-proof', context, ledger),
    ).resolves.toBe(false);
    mocks.query.mockResolvedValue({ rows: [good] });
    await expect(
      hasRecordedRequirementCoverageAudit('role-proof', context, ledger),
    ).resolves.toBe(true);
    const sql = mocks.query.mock.calls.at(-1)![0];
    expect(sql).toContain('JOIN opportunity_intelligence_requests q');
    expect(sql).toContain("q.status = 'succeeded'");
    expect(sql).toContain("q.accounting_basis = 'actual'");
    expect(sql).toContain('q.actual_total_tokens > 0');
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
