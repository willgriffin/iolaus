import { describe, expect, it } from 'vitest';
import {
  defaultResumeImportAction,
  editableResumeImportFields,
  type ResumeImportEntry,
} from './resume-import';

describe('resume import browser DTO', () => {
  it('uses only the explicit editable fields for each proposal type', () => {
    const entry = {
      id: 'experience-1',
      kind: 'experience',
      fields: { company: 'Acme', ownerId: 'not-client-editable' },
    } as unknown as ResumeImportEntry;
    expect(editableResumeImportFields(entry)).toEqual({
      company: 'Acme',
      title: '',
      startDate: '',
      endDate: '',
      summary: '',
      bullets: '',
      bulletSections: '',
    });
  });

  it('defaults uncertain proposals and possible duplicates to skip', () => {
    expect(
      defaultResumeImportAction({
        id: '1',
        kind: 'skill',
        uncertain: true,
        fields: {},
      }),
    ).toBe('skip');
    expect(
      defaultResumeImportAction({
        id: '2',
        kind: 'skill',
        candidateMatches: [{ id: 'existing', label: 'TypeScript' }],
        fields: {},
      }),
    ).toBe('skip');
    expect(
      defaultResumeImportAction({
        id: '3',
        kind: 'skill',
        fields: { name: 'TypeScript' },
      }),
    ).toBe('create');
  });

  it('defaults a profile proposal with its owned profile match to merge', () => {
    expect(
      defaultResumeImportAction({
        id: 'profile-1',
        kind: 'profile',
        fields: { summary: 'Builder' },
        candidateMatches: [{ id: 'profile-owned', label: 'Alex' }],
      }),
    ).toBe('merge');
  });
});
