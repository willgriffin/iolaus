import type { OpportunityScoringConfig } from '../opportunity-intelligence-config.js';
import {
  type PreparedPosting,
  prepareOpportunityPosting,
} from '../opportunity-posting-preparation.js';
import type { OpportunityScoringEvidenceSource } from '../opportunity-scoring.js';

export interface OpportunityScoringFixture {
  evidenceSources: OpportunityScoringEvidenceSource[];
  opportunity: Record<string, unknown>;
  policy: OpportunityScoringConfig;
  prepared: PreparedPosting;
}

const baselinePolicy: OpportunityScoringConfig = {
  clearAcceptMinRequired: 2,
  clearRejectMinGaps: 2,
  inputTokenCeiling: 4_000,
  modelEnabled: true,
};

function fixture(options: {
  descriptionRaw: string;
  evidence?: string[];
  name: string;
  policy?: Partial<OpportunityScoringConfig>;
  preferredSkills?: string;
  requiredSkills: string;
  workMode?: string;
}): OpportunityScoringFixture {
  const opportunity = {
    descriptionRaw: options.descriptionRaw,
    postingUrl: `https://example.com/jobs/${options.name}`,
    preferredSkills: options.preferredSkills ?? '',
    requiredSkills: options.requiredSkills,
    sourceContentFingerprint: `fixture-${options.name}-v1`,
    sourceContentVersion: 1,
    title: 'Staff Platform Engineer',
    workMode: options.workMode ?? 'remote',
  };
  return {
    evidenceSources: (options.evidence ?? []).map((value, index) => ({
      id: `${options.name}-evidence-${index + 1}`,
      kind: 'resume_skill',
      text: value,
      title: value,
    })),
    opportunity,
    policy: { ...baselinePolicy, ...options.policy },
    prepared: prepareOpportunityPosting(opportunity),
  };
}

export const clearAcceptScoringFixture = fixture({
  descriptionRaw:
    'Qualifications\nStrong TypeScript skills.\nProduction PostgreSQL experience.',
  evidence: ['TypeScript', 'PostgreSQL'],
  name: 'clear-accept',
  requiredSkills: 'TypeScript\nPostgreSQL',
});

export const clearRejectScoringFixture = fixture({
  descriptionRaw:
    'Qualifications\nTypeScript is required.\nPython is required.\nRust is required.',
  evidence: ['TypeScript'],
  name: 'clear-reject',
  requiredSkills: 'TypeScript\nPython\nRust',
});

export const borderlineScoringFixture = fixture({
  descriptionRaw:
    'Qualifications\nTypeScript is required.\nPython experience is required.',
  evidence: ['TypeScript'],
  name: 'borderline',
  requiredSkills: 'TypeScript\nPython',
});

export const missingEvidenceScoringFixture = fixture({
  descriptionRaw: 'Qualifications\nTypeScript is required.',
  name: 'missing-evidence',
  requiredSkills: 'TypeScript',
});

export const preferredOnlyEvidenceScoringFixture = fixture({
  descriptionRaw:
    'Qualifications\nTypeScript is required.\nPython is required.\nRust is preferred.',
  evidence: ['Rust'],
  name: 'preferred-only-evidence',
  preferredSkills: 'Rust',
  requiredSkills: 'TypeScript\nPython',
});

export const conflictingEvidenceScoringFixture = fixture({
  descriptionRaw:
    'Location\nThis role is on-site in Calgary.\nQualifications\nTypeScript is required.',
  evidence: ['TypeScript'],
  name: 'conflicting-evidence',
  requiredSkills: 'TypeScript',
  workMode: 'remote',
});

const maximumRequirements = Array.from(
  { length: 8 },
  (_, index) => `Platform Skill ${index + 1}`,
);
export const maximumScoringInputFixture = fixture({
  descriptionRaw: [
    'Qualifications',
    ...maximumRequirements.map(
      (requirement) =>
        `${requirement} is required. ${'Detailed posting context '.repeat(30)}`,
    ),
    `Unrelated tail ${'COMPLETE_RAW_POSTING_SENTINEL '.repeat(200)}`,
  ].join('\n'),
  evidence: Array.from({ length: 80 }, (_, index) => {
    const requirement = maximumRequirements[index % maximumRequirements.length];
    return `${requirement}. ${'Long reviewed candidate evidence '.repeat(30)}`;
  }),
  name: 'maximum-input',
  preferredSkills: maximumRequirements.join('\n'),
  requiredSkills: maximumRequirements.join('\n'),
});
