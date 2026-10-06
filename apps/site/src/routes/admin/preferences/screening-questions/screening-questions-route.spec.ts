import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  loadSkill: vi.fn(),
  saveSkill: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('$lib/server/skill-experience-preferences', () => ({
  loadSkillExperience: mocks.loadSkill,
  saveSkillExperience: mocks.saveSkill,
}));
vi.mock('$lib/server/screening-question-store', () => ({
  listScreeningQuestions: mocks.list,
  createScreeningQuestion: mocks.create,
  updateScreeningQuestion: mocks.update,
  deleteScreeningQuestion: mocks.delete,
  ScreeningQuestionStoreError: class extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock('$lib/server/smrt.js', () => ({
  getCollection: vi.fn(),
  getRequestScopedSmrtOptions: vi.fn(),
}));
vi.mock('$lib/server/db.js', () => ({ getSmrtOptions: vi.fn() }));

import { ScreeningQuestionStoreError } from '$lib/server/screening-question-store';
import { actions, load } from './+page.server';

const subject = { tenantId: 'tenant', userId: 'owner', profileId: 'profile' };
const locals = {
  workspaceSubject: subject,
  tenantId: 'tenant',
  user: { id: 'owner' },
  membership: {
    userId: 'owner',
    tenantId: 'tenant',
    roleId: 'role',
    status: 'active',
  },
} as App.Locals;
const snapshot = {
  questions: [],
  questionSetFingerprint: 'current-set',
  suggestions: [],
  invalidQuestions: [],
};
function event(
  action: 'save' | 'delete' | 'saveSkillExperience',
  overrides: Record<string, string> = {},
) {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    text: 'Does the posting allow remote work?',
    kind: 'source',
    importance: 'preference',
    desiredAnswer: 'yes',
    weight: '3',
    active: 'true',
    ...overrides,
  }))
    form.set(key, value);
  return {
    locals,
    request: new Request(
      `http://localhost/admin/preferences/screening-questions?/${action}`,
      { method: 'POST', body: form },
    ),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue(snapshot);
  mocks.loadSkill.mockResolvedValue('exact note');
  mocks.create.mockResolvedValue(snapshot);
  mocks.update.mockResolvedValue(snapshot);
  mocks.delete.mockResolvedValue(snapshot);
});
describe('Screening Questions private preference route', () => {
  it('saves private skill experience for the verified subject, ignoring form ownership', async () => {
    expect(
      await actions.saveSkillExperience(
        event('saveSkillExperience', {
          skillExperience: ' Exact note ',
          profileId: 'foreign',
        }) as never,
      ),
    ).toMatchObject({
      ok: true,
      action: 'skillExperience',
      message: 'Skill experience saved.',
    });
    expect(mocks.saveSkill).toHaveBeenCalledExactlyOnceWith(
      subject,
      ' Exact note ',
    );
  });
  it('denies skill experience writes without a verified workspace', async () => {
    const e = event('saveSkillExperience', { skillExperience: 'note' });
    const result = await actions.saveSkillExperience({
      ...e,
      locals: { ...locals, membership: null },
    } as never);
    expect(result).toMatchObject({
      status: 403,
      data: { action: 'skillExperience' },
    });
    expect(mocks.saveSkill).not.toHaveBeenCalled();
  });
  it('loads only the selected verified subject and never creates defaults on load', async () => {
    expect(await load({ locals } as never)).toEqual({
      ...snapshot,
      skillExperience: 'exact note',
    });
    expect(mocks.loadSkill).toHaveBeenCalledExactlyOnceWith(subject);
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith(subject);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each([
    { ...locals, membership: null },
    { ...locals, membership: { ...locals.membership, status: 'inactive' } },
    { ...locals, tenantId: 'foreign-tenant' },
    { ...locals, workspaceSubject: { ...subject, profileId: '' } },
  ])('denies missing, inactive, foreign or unselected workspace contexts before reads', async (invalidLocals) => {
    await expect(
      load({ locals: invalidLocals } as never),
    ).rejects.toMatchObject({ status: 403 });
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it('creates explicit desired-no preferences through the native service without trusting form profile IDs', async () => {
    const result = await actions.save(
      event('save', {
        desiredAnswer: 'no',
        profileId: 'foreign',
        tenantId: 'foreign',
      }) as never,
    );
    expect(result).toMatchObject({
      ok: true,
      message: 'Screening question saved.',
    });
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith(subject, {
      text: 'Does the posting allow remote work?',
      kind: 'source',
      importance: 'preference',
      desiredAnswer: 'no',
      weight: 3,
      active: true,
    });
  });
  it('pins update and delete to the native owned locator revision', async () => {
    await actions.save(
      event('save', {
        id: 'question-1',
        expectedRevision: 'revision',
        importance: 'must_have',
      }) as never,
    );
    expect(mocks.update).toHaveBeenCalledWith(subject, {
      id: 'question-1',
      expectedRevision: 'revision',
      patch: expect.objectContaining({ importance: 'must_have' }),
    });
    await actions.delete(
      event('delete', {
        id: 'invalid-question',
        expectedRevision: 'opaque-native-revision',
      }) as never,
    );
    expect(mocks.delete).toHaveBeenCalledWith(subject, {
      id: 'invalid-question',
      expectedRevision: 'opaque-native-revision',
    });
  });
  const malformedForms: Record<string, string>[] = [
    { kind: 'unknown' },
    { importance: 'hard_filter' },
    { desiredAnswer: 'maybe' },
    { active: 'not-boolean' },
  ];
  it.each(
    malformedForms,
  )('rejects malformed form enums before mutation (%j)', async (fields) => {
    expect(await actions.save(event('save', fields) as never)).toMatchObject({
      status: 400,
      data: { ok: false },
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each([
    ['invalid_question', 400],
    ['revision_conflict', 409],
    ['not_found', 404],
  ] as const)('surfaces native %s failure without claiming persistence', async (code, status) => {
    mocks.update.mockRejectedValueOnce(
      new ScreeningQuestionStoreError(code, status, 'Native save refused.'),
    );
    expect(
      await actions.save(
        event('save', { id: 'question-1', expectedRevision: 'old' }) as never,
      ),
    ).toMatchObject({
      status,
      data: { ok: false, error: 'Native save refused.' },
    });
  });
});
