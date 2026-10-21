import { describe, expect, it } from 'vitest';
import {
  parseResumeImportBulletSections,
  parseResumeImportSkillEvidence,
  parseResumeImportStoredSkillEvidence,
  ResumeImportStructureError,
} from './resume-import-structure.js';

describe('resume import structured review fields', () => {
  it('keeps section labels on their own bullet groups', () => {
    expect(
      parseResumeImportBulletSections(
        JSON.stringify([
          { title: 'Leadership', bullets: ['Led delivery'] },
          { title: 'Engineering', bullets: ['Built services'] },
        ]),
      ),
    ).toEqual([
      { title: 'Leadership', bullets: ['Led delivery'] },
      { title: 'Engineering', bullets: ['Built services'] },
    ]);
  });

  it('rejects unsupported skill evidence fields and invalid explicit usage dates', () => {
    expect(() =>
      parseResumeImportSkillEvidence(
        JSON.stringify([
          {
            proposalExperienceId: 'experience-1',
            usage: 'TypeScript',
            depth: 'hands_on',
            quote: 'Built TypeScript services',
            page: 1,
            roleStartDate: '2020',
          },
        ]),
      ),
    ).toThrow(ResumeImportStructureError);
    expect(() =>
      parseResumeImportSkillEvidence(
        JSON.stringify([
          {
            proposalExperienceId: 'experience-1',
            usage: 'TypeScript',
            depth: 'hands_on',
            quote: 'Built TypeScript services',
            page: 1,
            startDate: '2024-02-30',
          },
        ]),
      ),
    ).toThrow('not a calendar date');
  });

  it('reads server-enriched role dates separately from explicit usage dates', () => {
    expect(
      parseResumeImportStoredSkillEvidence(
        JSON.stringify([
          {
            proposalExperienceId: 'experience-1',
            experienceId: 'native-experience',
            company: 'Acme',
            role: 'Engineer',
            roleStartDate: '2020-01',
            roleEndDate: '2022',
            usage: 'TypeScript',
            depth: 'hands_on',
            quote: 'Built TypeScript services',
            page: 1,
            startDate: '2021-03',
          },
        ]),
      ),
    ).toEqual([
      expect.objectContaining({
        roleStartDate: '2020-01',
        roleEndDate: '2022',
        startDate: '2021-03',
      }),
    ]);
  });
});
