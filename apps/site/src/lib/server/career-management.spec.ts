import type { ResumeSource } from '@willgriffin/iolaus-resume';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCollection: vi.fn(),
  loadSource: vi.fn(),
  invalidate: vi.fn(),
  assertOperation: vi.fn(),
  verify: vi.fn(),
}));
vi.mock('./smrt.js', () => ({ getCollection: mocks.getCollection }));
vi.mock('./resume-data.js', () => ({
  loadAdminResumeSource: mocks.loadSource,
  invalidatePublishedResumeCache: mocks.invalidate,
}));
vi.mock('./owner-principal.js', () => ({
  isOwnerAuthorityDenial: (cause: unknown) =>
    cause instanceof Error && cause.message === 'permission denied',
  runAsOwner: async (
    _locals: unknown,
    fn: (run: {
      assertOperation: typeof mocks.assertOperation;
    }) => Promise<unknown>,
  ) => await fn({ assertOperation: mocks.assertOperation }),
}));
vi.mock('./workspace-subject.js', () => ({
  workspaceSubjectFromLocals: (locals: { workspaceSubject?: unknown }) => {
    if (!locals.workspaceSubject)
      throw new Error('Workspace session is not verified.');
    return locals.workspaceSubject;
  },
  requireCandidateWorkspaceSubject: (subject: unknown) => subject,
  withVerifiedWorkspaceSubject: async (
    subject: unknown,
    fn: (subject: unknown) => Promise<unknown>,
  ) => {
    await mocks.verify(subject);
    return await fn(subject);
  },
}));

import {
  CAREER_EDIT_SECTIONS,
  loadCareerManagement,
  saveCareerSection,
} from './career-management.js';

const subject = { tenantId: 'tenant', userId: 'owner', profileId: 'profile' };
const locals = { workspaceSubject: subject } as App.Locals;
const ownership = {
  tenantId: subject.tenantId,
  ownerUserId: subject.userId,
  candidateProfileId: subject.profileId,
};
const source: ResumeSource = {
  profile: {
    name: 'Fictional Candidate',
    title: 'Engineer',
    summary: 'Canonical summary',
    email: 'candidate@example.test',
    links: [],
  },
  skills: { groups: [], skillGroups: [] },
  experience: { positions: [], other: [], education: [] },
};
type Row = Record<string, unknown> & {
  id: string;
  save: ReturnType<typeof vi.fn>;
};
let records: Map<string, Row[]>;
let profile: Row;
let achievement: Row;
function form(
  section = 'profile',
  id = 'profile',
  fields: Record<string, string> = { summary: 'Revised fictional summary' },
) {
  const payload = new FormData();
  payload.set('section', section);
  payload.set('id', id);
  for (const [key, value] of Object.entries(fields)) payload.set(key, value);
  return payload;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertOperation.mockReset();
  mocks.verify.mockReset();
  mocks.loadSource.mockReset();
  profile = {
    id: 'profile',
    tenantId: 'tenant',
    ownerUserId: 'owner',
    active: true,
    name: 'Fictional Candidate',
    summary: 'Canonical summary',
    profileKey: 'default',
    save: vi.fn(),
  };
  achievement = {
    id: 'achievement',
    ...ownership,
    title: 'Original achievement',
    body: 'Original body',
    experienceId: 'experience',
    save: vi.fn(),
  };
  records = new Map([
    ['CandidateProfile', [profile]],
    ['Achievement', [achievement]],
  ]);
  mocks.getCollection.mockImplementation(async (className: string) => ({
    get: vi.fn(
      async (id: string) =>
        (records.get(className) ?? []).find((row) => row.id === id) ?? null,
    ),
    // Deliberately ignores where: the real private helper must enforce the tuple.
    list: vi.fn(async () => records.get(className) ?? []),
  }));
  mocks.loadSource.mockResolvedValue(source);
});

describe('Career canonical management', () => {
  it('reuses the exact subject-scoped canonical resolver without writes on load', async () => {
    const loaded = await loadCareerManagement(locals);
    expect(loaded.source).toBe(source);
    expect(mocks.loadSource).toHaveBeenCalledWith(undefined, subject);
    expect(
      loaded.sections.find((section) => section.key === 'profile')?.records[0]
        .values.summary,
    ).toBe('Canonical summary');
    expect(profile.save).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.assertOperation).not.toHaveBeenCalled();
  });
  it('filters foreign editor rows even when the adapter ignores ownership predicates', async () => {
    records.set('Achievement', [
      achievement,
      ...[
        { ownerUserId: 'other' },
        { candidateProfileId: 'other' },
        { tenantId: 'other' },
      ].map((foreign, index) => ({
        ...achievement,
        ...foreign,
        id: `foreign-${index}`,
        title: 'Private foreign content',
      })),
    ]);
    const loaded = await loadCareerManagement(locals);
    const section = loaded.sections.find(
      (entry) => entry.key === 'achievements',
    );
    expect(section?.records.map((row) => row.id)).toEqual(['achievement']);
    expect(JSON.stringify(loaded)).not.toContain('Private foreign content');
    expect(section?.records[0].values).not.toHaveProperty('ownerUserId');
  });
  it.each([
    { active: false },
    { ownerUserId: 'other' },
    { tenantId: 'other' },
  ])('denies inactive or foreign selected profile %j before source read', async (changes) => {
    Object.assign(profile, changes);
    await expect(loadCareerManagement(locals)).rejects.toMatchObject({
      status: 403,
    });
    expect(mocks.loadSource).not.toHaveBeenCalled();
  });
  it('fails closed if the canonical resolver no longer finds the selected profile', async () => {
    mocks.loadSource.mockResolvedValue(null);
    await expect(loadCareerManagement(locals)).rejects.toMatchObject({
      status: 404,
    });
  });
  it('persists only allowed content, preserving profile and relationship authority', async () => {
    const saved = await saveCareerSection(
      locals,
      form('achievements', 'achievement', {
        title: 'Revised achievement',
        body: ' New fictional body ',
        metric: '20%',
        experienceId: 'forged',
        projectId: 'forged',
        tenantId: 'forged',
        ownerUserId: 'forged',
        candidateProfileId: 'forged',
      }),
    );
    expect(saved).toMatchObject({ ok: true });
    expect(achievement).toMatchObject({
      ...ownership,
      title: 'Revised achievement',
      body: 'New fictional body',
      metric: '20%',
      experienceId: 'experience',
    });
    expect(achievement).not.toHaveProperty('projectId');
    expect(achievement.save).toHaveBeenCalledOnce();
    expect(mocks.invalidate).toHaveBeenCalledOnce();
    expect(mocks.assertOperation).toHaveBeenCalledTimes(2);
    expect(mocks.assertOperation.mock.calls[0]).toEqual([
      'workflow',
      'profile.manage',
    ]);
    expect(mocks.verify).toHaveBeenCalledTimes(2);
  });
  it('saves summary without changing profile selection, resume asset or preferences and reloads canonical data', async () => {
    Object.assign(profile, {
      resumeAssetId: 'existing-pdf',
      preferencesJson: '{"targetRoles":["Engineer"]}',
    });
    await saveCareerSection(
      locals,
      form('profile', 'profile', {
        summary: 'Revised fictional summary',
        active: 'false',
        profileKey: 'forged',
        resumeAssetId: 'forged',
        preferencesJson: '{}',
      }),
    );
    mocks.loadSource.mockImplementation(async () => ({
      ...source,
      profile: { ...source.profile, summary: profile.summary },
    }));
    const loaded = await loadCareerManagement(locals);
    expect(loaded.source.profile.summary).toBe('Revised fictional summary');
    expect(profile).toMatchObject({
      active: true,
      profileKey: 'default',
      resumeAssetId: 'existing-pdf',
      preferencesJson: '{"targetRoles":["Engineer"]}',
    });
  });
  it.each([
    { ownerUserId: 'other' },
    { candidateProfileId: 'other' },
    { tenantId: 'other' },
  ])('denies foreign native record edits %j', async (changes) => {
    Object.assign(achievement, changes);
    await expect(
      saveCareerSection(
        locals,
        form('achievements', 'achievement', { body: 'forged' }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(achievement.body).toBe('Original body');
    expect(achievement.save).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
  it('denies a different profile ID even in the same owner workspace', async () => {
    records.get('CandidateProfile')?.push({ ...profile, id: 'other-profile' });
    await expect(
      saveCareerSection(locals, form('profile', 'other-profile')),
    ).rejects.toMatchObject({ status: 404 });
    expect(profile.save).not.toHaveBeenCalled();
  });
  it('rechecks permission immediately before write and never assigns on denial', async () => {
    mocks.assertOperation
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('permission denied'));
    await expect(saveCareerSection(locals, form())).rejects.toMatchObject({
      status: 403,
    });
    expect(profile.summary).toBe('Canonical summary');
    expect(profile.save).not.toHaveBeenCalled();
  });
  it('rechecks record ownership inside the write principal', async () => {
    mocks.verify
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        achievement.ownerUserId = 'other';
      });
    await expect(
      saveCareerSection(
        locals,
        form('achievements', 'achievement', { body: 'forged' }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(achievement.body).toBe('Original body');
    expect(achievement.save).not.toHaveBeenCalled();
  });
  it.each([
    'javascript:alert(1)',
    'file:///private/resume',
    'not a link',
  ])('rejects unsafe or malformed contact link %s', async (href) => {
    await expect(
      saveCareerSection(locals, form('links', 'link', { href })),
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.assertOperation).not.toHaveBeenCalled();
  });
  it('rejects unknown sections, files and forged-only updates', async () => {
    await expect(
      saveCareerSection(locals, form('ResumeAsset')),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      saveCareerSection(
        locals,
        form('profile', 'profile', { ownerUserId: 'other' }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    const payload = form();
    payload.set('summary', new Blob(['upload']), 'resume.txt');
    await expect(saveCareerSection(locals, payload)).rejects.toMatchObject({
      status: 400,
    });
    expect(profile.save).not.toHaveBeenCalled();
    expect(Object.keys(CAREER_EDIT_SECTIONS)).not.toContain('ResumeAsset');
  });
});
