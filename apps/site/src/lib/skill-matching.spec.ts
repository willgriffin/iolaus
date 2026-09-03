import { describe, expect, it } from 'vitest';

// Synthetic evidence; never use the user's seeded profile in tests.
const experienceData = {
  positions: [
    {
      achievements: [
        {
          title: 'Hybrid Cloud Infrastructure',
          tags: ['cloudnativepg', 'high-availability'],
        },
      ],
    },
  ],
};
const skillsData = {
  groups: [
    {
      skills: [
        'PostgreSQL',
        'Infrastructure as Code',
        'GitHub Actions',
        'Kubernetes',
        'Distributed Systems',
        'Team Leadership',
        'JavaScript',
        'TypeScript',
      ].map((label) => ({
        id: label === 'PostgreSQL' ? 'postgres' : label,
        label,
      })),
    },
  ],
};

import {
  candidateSkillTermsFromData,
  createCandidateSkillMatcher,
  hasCandidateSkill,
} from './skill-matching';

const realTerms = candidateSkillTermsFromData({
  experience: experienceData,
  skills: skillsData,
});
const hasReal = createCandidateSkillMatcher(realTerms);

describe('candidateSkillTermsFromData', () => {
  it('harvests catalog ids, labels, and curated achievement evidence', () => {
    // catalog id and human label of the same skill
    expect(realTerms).toContain('postgres');
    expect(realTerms).toContain('postgresql'); // from the "PostgreSQL" label
    expect(realTerms).toContain('infrastructure as code'); // iac label
    // achievement title + tag evidence from experience.json
    expect(realTerms).toContain('hybrid cloud infrastructure');
    expect(realTerms).toContain('cloudnativepg');
  });

  it('does not harvest container ids or job roles as skills', () => {
    // group container ids ("g-devops", "g-fullstack-js") are internal slugs,
    // not skills (their human labels are harvested instead).
    expect(realTerms).not.toContain('g devops');
    expect(realTerms).not.toContain('g fullstack js');
    // position roles ("Founder", "Integrations Engineer") are not skills
    expect(realTerms).not.toContain('founder');
    expect(realTerms).not.toContain('integrations engineer');
  });
});

describe('skill matching against the synthetic evidence', () => {
  it('matches broad requirements via labels and achievement evidence', () => {
    for (const skill of [
      'PostgreSQL',
      'Postgres',
      'Infrastructure as Code',
      'Cloud Infrastructure',
      'CloudNativePG',
      'GitHub Actions',
      'Kubernetes',
      'High Availability', // only present in an achievement title
      'Distributed Systems',
      'Team Leadership',
    ]) {
      expect(hasReal(skill), `expected to have "${skill}"`).toBe(true);
    }
  });

  it('matches a narrower owned skill inside a broader requirement', () => {
    // owned "github" / "kubernetes" appear as whole tokens in the requirement
    expect(hasReal('GitHub Actions workflows')).toBe(true);
    expect(hasReal('Kubernetes cluster operations')).toBe(true);
  });

  it('does not light up unrelated requirements via substring overlap', () => {
    // "RAG" must not match "Storage" (sto-rag-e), the classic substring bug
    expect(hasReal('Storage')).toBe(false);
    // owned JavaScript/TypeScript must not imply Java
    expect(hasReal('Java')).toBe(false);
    // skills genuinely absent from the resume
    expect(hasReal('Rust')).toBe(false);
    expect(hasReal('Salesforce')).toBe(false);
  });

  it('treats blank requirements as not-matched', () => {
    expect(hasReal('')).toBe(false);
    expect(hasReal('   ')).toBe(false);
  });
});

describe('curated aliases', () => {
  it('matches posting phrasing through skill aliases', () => {
    const terms = candidateSkillTermsFromData({
      skills: {
        groups: [
          {
            label: 'Cloud & DevOps',
            skills: [
              {
                aliases: ['Cloud-native infrastructure'],
                id: 'cloud-infrastructure',
                label: 'Cloud Infrastructure',
              },
              {
                aliases: ['Postgres on Kubernetes'],
                id: 'cloudnativepg',
                label: 'CloudNativePG',
              },
            ],
          },
        ],
      },
    });

    expect(hasCandidateSkill('Cloud-native infrastructure', terms)).toBe(true);
    expect(hasCandidateSkill('Postgres on Kubernetes', terms)).toBe(true);
  });
});
