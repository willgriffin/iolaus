import { describe, expect, it } from 'vitest';
import {
  applyResumeImportDomain,
  parseResumeImportDate,
  ResumeImportDomainError,
  validateResumeImportFields,
  validateResumeImportProposalEntries,
} from './resume-import-domain.js';

const subject = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  profileId: 'profile-a',
};
const database = {};

describe('resume import domain validation', () => {
  it('preserves submitted ISO date precision without fabricating a day', () => {
    expect(parseResumeImportDate('2024')).toMatchObject({
      precision: 'year',
      date: new Date(Date.UTC(2024, 0, 1)),
    });
    expect(parseResumeImportDate('2024-07')).toMatchObject({
      precision: 'month',
      date: new Date(Date.UTC(2024, 6, 1)),
    });
    expect(parseResumeImportDate('2024-07-15')).toMatchObject({
      precision: 'day',
      date: new Date(Date.UTC(2024, 6, 15)),
    });
    expect(() => parseResumeImportDate('July 2024')).toThrow(
      ResumeImportDomainError,
    );
    expect(() => parseResumeImportDate('2024-02-30')).toThrow(
      'Invalid calendar date',
    );
  });

  it('rejects stale revisions before performing a domain read or write', async () => {
    await expect(
      applyResumeImportDomain({
        db: database,
        subject,
        proposal: { revision: 'server-revision', entries: [] },
        input: { revision: 'browser-revision', entries: [] },
      }),
    ).rejects.toThrow('Proposal revision is stale');
  });

  it('rejects entries not present in the server proposal', async () => {
    await expect(
      applyResumeImportDomain({
        db: database,
        subject,
        proposal: { revision: 'v1', entries: [] },
        input: {
          revision: 'v1',
          entries: [{ id: 'forged', action: 'skip', fields: {} }],
        },
      }),
    ).rejects.toThrow('not in the server proposal');
  });

  it('rejects arbitrary merge IDs before writing', async () => {
    await expect(
      applyResumeImportDomain({
        db: database,
        subject,
        proposal: {
          revision: 'v1',
          entries: [
            {
              id: 'education-1',
              kind: 'education',
              fields: { title: 'BSc', institution: 'U' },
              candidateMatches: [],
            },
          ],
        },
        input: {
          revision: 'v1',
          entries: [
            {
              id: 'education-1',
              action: 'merge',
              targetId: 'foreign-row',
              fields: { title: 'BSc', institution: 'U' },
            },
          ],
        },
      }),
    ).rejects.toThrow('not captured by the server proposal');
  });

  it('allows an incomplete entry to be explicitly skipped', async () => {
    await expect(
      applyResumeImportDomain({
        db: database,
        subject,
        proposal: {
          revision: 'v1',
          entries: [
            { id: 'skill-1', kind: 'skill', fields: { name: 'TypeScript' } },
          ],
        },
        input: {
          revision: 'v1',
          entries: [
            {
              id: 'skill-1',
              action: 'skip',
              fields: { name: 'TypeScript', ownerUserId: 'user-a' },
            },
          ],
        },
      }),
    ).resolves.toEqual({
      createdIds: [],
      mergedIds: [],
      skippedIds: ['skill-1'],
    });
  });

  it('rejects unsafe project URLs before any write', async () => {
    await expect(
      applyResumeImportDomain({
        db: database,
        subject,
        proposal: {
          revision: 'v1',
          entries: [
            {
              id: 'project-1',
              kind: 'project',
              fields: { name: 'Site', url: 'javascript:alert(1)' },
            },
          ],
        },
        input: {
          revision: 'v1',
          entries: [
            {
              id: 'project-1',
              action: 'create',
              fields: { name: 'Site', url: 'javascript:alert(1)' },
            },
          ],
        },
      }),
    ).rejects.toThrow('Project URL must be HTTP or HTTPS');
  });

  it('rejects a project parent reference that is not an experience proposal', async () => {
    await expect(
      applyResumeImportDomain({
        db: database,
        subject,
        proposal: {
          revision: 'v1',
          entries: [
            { id: 'skill-1', kind: 'skill', fields: { name: 'TypeScript' } },
            {
              id: 'project-1',
              kind: 'project',
              fields: { name: 'Site', proposalExperienceId: 'skill-1' },
            },
          ],
        },
        input: {
          revision: 'v1',
          entries: [
            { id: 'skill-1', action: 'skip', fields: {} },
            { id: 'project-1', action: 'skip', fields: {} },
          ],
        },
      }),
    ).rejects.toThrow('Project parent proposal entry is invalid');
  });

  it('rejects credential-bearing project URLs before any write', async () => {
    await expect(
      applyResumeImportDomain({
        db: database,
        subject,
        proposal: {
          revision: 'v2',
          entries: [
            {
              id: 'project-1',
              kind: 'project',
              fields: { name: 'Site', url: 'https://token@example.test' },
            },
          ],
        },
        input: {
          revision: 'v2',
          entries: [
            {
              id: 'project-1',
              action: 'create',
              fields: { name: 'Site', url: 'https://token@example.test' },
            },
          ],
        },
      }),
    ).rejects.toThrow('must not include credentials');
  });

  it('accepts a non-Latin project name without deriving an ASCII key', () => {
    expect(
      validateResumeImportFields('project', { name: '国際化プロジェクト' }),
    ).toEqual({ name: '国際化プロジェクト' });
  });

  it('accepts project bullets as reviewed newline-separated content', () => {
    expect(
      validateResumeImportFields('project', {
        name: 'Portal',
        bullets: 'Built checkout\nImproved accessibility',
      }),
    ).toEqual({
      name: 'Portal',
      bullets: 'Built checkout\nImproved accessibility',
    });
  });

  it('accepts reviewed bullet sections while rejecting client-submitted skill evidence', () => {
    expect(
      validateResumeImportFields('experience', {
        company: 'Acme',
        title: 'Engineer',
        bulletSections: JSON.stringify([
          { title: 'Leadership', bullets: ['Mentored the team'] },
        ]),
      }),
    ).toMatchObject({ company: 'Acme', title: 'Engineer' });
    expect(
      validateResumeImportFields('experience', {
        company: 'Acme',
        title: 'Engineer',
        bulletSections: '',
      }),
    ).not.toHaveProperty('bulletSections');
    expect(() =>
      validateResumeImportFields('skill', {
        name: 'TypeScript',
        skillEvidence: '[]',
      }),
    ).toThrow('Unknown skill field');
    expect(
      validateResumeImportProposalEntries([
        {
          id: 'skill-1',
          kind: 'skill',
          fields: { name: 'TypeScript', skillEvidence: '[]' },
        },
      ]),
    ).toHaveLength(1);
  });

  it('uses the same reviewed bullet and structure bounds for proposal and apply', () => {
    const largeBullets = 'x'.repeat(25_000);
    const largeSections = JSON.stringify([
      {
        title: 'Engineering',
        bullets: Array.from(
          { length: 22 },
          (_, index) => `${index}-${'x'.repeat(1_197)}`,
        ),
      },
    ]);
    const experience = (fields: Record<string, string>) => [
      { id: 'experience-1', kind: 'experience' as const, fields },
    ];
    expect(
      validateResumeImportFields('experience', {
        company: 'Acme',
        title: 'Engineer',
        bullets: largeBullets,
      }),
    ).toHaveProperty('bullets', largeBullets);
    expect(
      validateResumeImportProposalEntries(
        experience({
          company: 'Acme',
          title: 'Engineer',
          bullets: largeBullets,
        }),
      ),
    ).toHaveLength(1);
    expect(
      validateResumeImportFields('experience', {
        company: 'Acme',
        title: 'Engineer',
        bulletSections: largeSections,
      }),
    ).toHaveProperty('bulletSections', largeSections);
    expect(
      validateResumeImportProposalEntries(
        experience({
          company: 'Acme',
          title: 'Engineer',
          bulletSections: largeSections,
        }),
      ),
    ).toHaveLength(1);
    const oversizedBullets = 'x'.repeat(50_001);
    expect(() =>
      validateResumeImportFields('experience', {
        company: 'Acme',
        title: 'Engineer',
        bullets: oversizedBullets,
      }),
    ).toThrow('bullets field is too long');
    expect(() =>
      validateResumeImportProposalEntries(
        experience({
          company: 'Acme',
          title: 'Engineer',
          bullets: oversizedBullets,
        }),
      ),
    ).toThrow('bullets field is too long');
    const oversizedSections = JSON.stringify([
      { title: 'Engineering', bullets: ['x'.repeat(512 * 1024)] },
    ]);
    expect(() =>
      validateResumeImportFields('experience', {
        company: 'Acme',
        title: 'Engineer',
        bulletSections: oversizedSections,
      }),
    ).toThrow('bulletSections field is too long');
    expect(() =>
      validateResumeImportProposalEntries(
        experience({
          company: 'Acme',
          title: 'Engineer',
          bulletSections: oversizedSections,
        }),
      ),
    ).toThrow('bulletSections field is too long');
  });
});
