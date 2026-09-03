import type { OpportunityScoringConfig } from '../opportunity-intelligence-config.js';
import type {
  OpportunityScoringEvidenceSource,
  OpportunityScoringPreScoreKind,
} from '../opportunity-scoring.js';

export const opportunityIntelligenceCanaryCategories = [
  'long',
  'noisy',
  'sparse',
  'remote',
  'hybrid',
  'compensation',
  'ambiguous-seniority',
] as const;

export type OpportunityIntelligenceCanaryCategory =
  (typeof opportunityIntelligenceCanaryCategories)[number];

export interface OpportunityIntelligenceFieldCheck {
  field: string;
  operator: 'contains' | 'empty' | 'equals';
  value?: number | string;
}

export interface OpportunityIntelligenceCanaryFixture {
  categories: OpportunityIntelligenceCanaryCategory[];
  expectedExtraction: OpportunityIntelligenceFieldCheck[];
  id: string;
  opportunity: Record<string, unknown>;
  scoring: {
    evidenceSources: OpportunityScoringEvidenceSource[];
    expectedDecision: OpportunityScoringPreScoreKind;
    expectedRecommendation: 'maybe' | 'needs_research' | 'recommend' | 'reject';
    opportunity: Record<string, unknown>;
    policy: OpportunityScoringConfig;
  };
}

const scoringPolicy: OpportunityScoringConfig = {
  clearAcceptMinRequired: 2,
  clearRejectMinGaps: 2,
  inputTokenCeiling: 3_000,
  modelEnabled: true,
};

function evidence(
  id: string,
  ...skills: string[]
): OpportunityScoringEvidenceSource[] {
  return skills.map((skill, index) => ({
    id: `${id}-evidence-${index + 1}`,
    kind: 'resume_skill',
    text: skill,
    title: skill,
  }));
}

function posting(
  id: string,
  descriptionRaw: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    descriptionRaw,
    id: `canary-${id}`,
    postingUrl: `https://jobs.example.invalid/${id}`,
    sourceContentFingerprint: `sanitized-canary-${id}-v1`,
    sourceContentVersion: 1,
    ...extra,
  };
}

const longPosting = [
  'Staff Platform Engineer',
  'Location: Remote in Canada',
  'Compensation: CAD 180,000 - 220,000 per year',
  'Employment type: Full time',
  'Responsibilities',
  'Build TypeScript services and operate PostgreSQL and Kubernetes platforms.',
  'Qualifications',
  '8+ years of software engineering experience.',
  'TypeScript, PostgreSQL, and Kubernetes are required.',
  ...Array.from(
    { length: 90 },
    (_, index) =>
      `Additional context ${index + 1}: ${'reliable platform delivery and measurable operations '.repeat(12)}`,
  ),
].join('\n');

export const opportunityIntelligenceCanaryFixtures: OpportunityIntelligenceCanaryFixture[] =
  [
    {
      categories: ['long', 'remote', 'compensation'],
      expectedExtraction: [
        {
          field: 'title',
          operator: 'equals',
          value: 'Staff Platform Engineer',
        },
        { field: 'seniority', operator: 'equals', value: 'staff' },
        { field: 'workMode', operator: 'equals', value: 'remote' },
        { field: 'currency', operator: 'equals', value: 'CAD' },
        { field: 'salaryMin', operator: 'equals', value: 180_000 },
        { field: 'salaryMax', operator: 'equals', value: 220_000 },
        { field: 'requiredSkills', operator: 'contains', value: 'TypeScript' },
        { field: 'requiredSkills', operator: 'contains', value: 'PostgreSQL' },
        { field: 'requiredSkills', operator: 'contains', value: 'Kubernetes' },
      ],
      id: 'long-platform',
      opportunity: posting('long-platform', longPosting, {
        title: 'Staff Platform Engineer',
      }),
      scoring: {
        evidenceSources: evidence('long-platform', 'TypeScript', 'PostgreSQL'),
        expectedDecision: 'clear_accept',
        expectedRecommendation: 'recommend',
        opportunity: {
          requiredSkills: 'TypeScript\nPostgreSQL',
          workMode: 'remote',
        },
        policy: scoringPolicy,
      },
    },
    {
      categories: ['noisy', 'remote', 'compensation'],
      expectedExtraction: [
        {
          field: 'title',
          operator: 'equals',
          value: 'Senior Infrastructure Engineer',
        },
        { field: 'workMode', operator: 'equals', value: 'remote' },
        { field: 'currency', operator: 'equals', value: 'CAD' },
        { field: 'salaryMin', operator: 'equals', value: 160_000 },
        { field: 'salaryMax', operator: 'equals', value: 195_000 },
        { field: 'requiredSkills', operator: 'contains', value: 'Rust' },
        { field: 'requiredSkills', operator: 'contains', value: 'Kubernetes' },
      ],
      id: 'noisy-repeated',
      opportunity: posting(
        'noisy-repeated',
        [
          'Apply now',
          'Privacy policy',
          'Senior Infrastructure Engineer',
          'Remote - Canada',
          'Salary CAD 160k to 195k',
          ...Array.from(
            { length: 25 },
            () => 'Apply now | Share | Cookie settings',
          ),
          'Requirements',
          'Rust is required.',
          'Kubernetes is required.',
          'Responsibilities',
          'Operate production infrastructure.',
          ...Array.from({ length: 20 }, () => 'Privacy policy | Apply now'),
        ].join('\n'),
        { title: 'Senior Infrastructure Engineer' },
      ),
      scoring: {
        evidenceSources: evidence('noisy-repeated', 'TypeScript'),
        expectedDecision: 'clear_reject',
        expectedRecommendation: 'reject',
        opportunity: {
          requiredSkills: 'Rust\nKubernetes',
          workMode: 'remote',
        },
        policy: scoringPolicy,
      },
    },
    {
      categories: ['sparse'],
      expectedExtraction: [
        { field: 'title', operator: 'equals', value: 'Backend Engineer' },
        { field: 'employmentType', operator: 'equals', value: 'full_time' },
        { field: 'salaryMin', operator: 'empty' },
        { field: 'workMode', operator: 'empty' },
      ],
      id: 'sparse-backend',
      opportunity: posting(
        'sparse-backend',
        'Backend Engineer\nFull-time\nBuild APIs.\nTypeScript required.',
        { title: 'Backend Engineer' },
      ),
      scoring: {
        evidenceSources: [],
        expectedDecision: 'missing_evidence',
        expectedRecommendation: 'needs_research',
        opportunity: { requiredSkills: 'TypeScript' },
        policy: scoringPolicy,
      },
    },
    {
      categories: ['remote'],
      expectedExtraction: [
        {
          field: 'title',
          operator: 'equals',
          value: 'Senior Product Engineer',
        },
        { field: 'workMode', operator: 'equals', value: 'remote' },
        { field: 'locationNotes', operator: 'contains', value: 'Canada' },
        { field: 'requiredSkills', operator: 'contains', value: 'TypeScript' },
      ],
      id: 'remote-canada',
      opportunity: posting(
        'remote-canada',
        'Senior Product Engineer\nWork from anywhere in Canada. No office attendance is required.\nRequirements\n- TypeScript\n- Product delivery',
        { title: 'Senior Product Engineer' },
      ),
      scoring: {
        evidenceSources: evidence(
          'remote-canada',
          'TypeScript',
          'Product delivery',
        ),
        expectedDecision: 'clear_accept',
        expectedRecommendation: 'recommend',
        opportunity: {
          requiredSkills: 'TypeScript\nProduct delivery',
          workMode: 'remote',
        },
        policy: scoringPolicy,
      },
    },
    {
      categories: ['hybrid'],
      expectedExtraction: [
        { field: 'title', operator: 'equals', value: 'Platform Developer' },
        { field: 'workMode', operator: 'equals', value: 'hybrid' },
        { field: 'locationNotes', operator: 'contains', value: 'Calgary' },
        { field: 'requiredSkills', operator: 'contains', value: 'Python' },
        { field: 'requiredSkills', operator: 'contains', value: 'Go' },
      ],
      id: 'hybrid-calgary',
      opportunity: posting(
        'hybrid-calgary',
        'Platform Developer\nHybrid in Calgary, Alberta: two office days each week.\nRequirements\n- Python\n- Go\nBuild internal developer tooling.',
        { title: 'Platform Developer' },
      ),
      scoring: {
        evidenceSources: evidence('hybrid-calgary', 'Python'),
        expectedDecision: 'borderline',
        expectedRecommendation: 'maybe',
        opportunity: {
          requiredSkills: 'Python\nGo',
          workMode: 'hybrid',
        },
        policy: scoringPolicy,
      },
    },
    {
      categories: ['compensation', 'remote'],
      expectedExtraction: [
        {
          field: 'title',
          operator: 'equals',
          value: 'Contract Systems Engineer',
        },
        { field: 'employmentType', operator: 'equals', value: 'contract' },
        { field: 'workMode', operator: 'equals', value: 'remote' },
        { field: 'currency', operator: 'equals', value: 'USD' },
        { field: 'hourlyMin', operator: 'equals', value: 90 },
        { field: 'hourlyMax', operator: 'equals', value: 110 },
      ],
      id: 'compensation-contract',
      opportunity: posting(
        'compensation-contract',
        'Contract Systems Engineer\nRemote in the United States\nSix-month contract\nUSD $90-$110 per hour\nRequirements\n- Go\n- Linux',
        { title: 'Contract Systems Engineer' },
      ),
      scoring: {
        evidenceSources: evidence('compensation-contract', 'Go', 'Linux'),
        expectedDecision: 'clear_accept',
        expectedRecommendation: 'recommend',
        opportunity: {
          requiredSkills: 'Go\nLinux',
          workMode: 'remote',
        },
        policy: scoringPolicy,
      },
    },
    {
      categories: ['ambiguous-seniority'],
      expectedExtraction: [
        {
          field: 'title',
          operator: 'equals',
          value: 'Senior / Staff Software Engineer',
        },
        { field: 'seniority', operator: 'empty' },
        { field: 'workMode', operator: 'equals', value: 'onsite' },
        { field: 'requiredSkills', operator: 'contains', value: 'TypeScript' },
      ],
      id: 'ambiguous-seniority',
      opportunity: posting(
        'ambiguous-seniority',
        'Senior / Staff Software Engineer\nLevel will be determined after interviews.\nThis role works on-site in Edmonton five days per week.\nRequirements\n- TypeScript\n- PostgreSQL',
        { title: 'Senior / Staff Software Engineer' },
      ),
      scoring: {
        evidenceSources: evidence(
          'ambiguous-seniority',
          'TypeScript',
          'PostgreSQL',
        ),
        expectedDecision: 'conflicting_evidence',
        expectedRecommendation: 'maybe',
        opportunity: {
          requiredSkills: 'TypeScript\nPostgreSQL',
          workMode: 'remote',
        },
        policy: scoringPolicy,
      },
    },
  ];
