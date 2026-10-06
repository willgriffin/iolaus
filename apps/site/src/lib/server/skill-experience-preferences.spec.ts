import type { PrincipalRun } from '@happyvertical/smrt-agents';
import { describe, expect, it, vi } from 'vitest';
import {
  loadSkillExperience,
  type SkillExperienceDependencies,
  saveSkillExperience,
} from './skill-experience-preferences.js';

const subject = { tenantId: 'tenant', userId: 'user', profileId: 'profile' };
function fixture() {
  const profile = {
    id: 'profile',
    tenantId: 'tenant',
    ownerUserId: 'user',
    active: true,
    summary: 'Public summary',
    factsJson: JSON.stringify({
      version: 1,
      facts: {
        workAuthorization: { value: 'CA', provenance: 'user_verified' },
      },
      unresolvedQuestions: ['other'],
    }),
    save: vi.fn(async () => {}),
  };
  const assertOperation = vi.fn(async () => {});
  const deps: SkillExperienceDependencies = {
    getProfile: vi.fn(async () => profile),
    runFresh: async (owned, capability, work) => {
      expect(capability).toBe('profile.manage');
      return await work(owned, { assertOperation } as unknown as PrincipalRun);
    },
  };
  return { profile, deps, assertOperation };
}
describe('private skill experience preferences', () => {
  it('preserves exact verified text, other facts and public summary; blank clears only the note', async () => {
    const f = fixture();
    const before = JSON.parse(f.profile.factsJson);
    const note =
      ' I primarily use TypeScript. I have only dabbled in Java and Python.\n';
    await saveSkillExperience(subject, note, f.deps);
    expect(JSON.parse(f.profile.factsJson)).toEqual({
      ...before,
      facts: {
        ...before.facts,
        skillExperience: { value: note, provenance: 'user_verified' },
      },
    });
    expect(await loadSkillExperience(subject, f.deps)).toBe(note);
    expect(f.profile.summary).toBe('Public summary');
    expect(f.assertOperation).toHaveBeenCalledWith(
      'workflow',
      'profile.manage',
    );
    await saveSkillExperience(subject, '  ', f.deps);
    expect(JSON.parse(f.profile.factsJson)).toEqual(before);
  });
  it.each([
    'tenantId',
    'ownerUserId',
    'id',
    'active',
  ])('denies foreign or inactive profile %s before writing', async (key) => {
    const f = fixture();
    Object.assign(f.profile, { [key]: key === 'active' ? false : 'other' });
    await expect(
      saveSkillExperience(subject, 'note', f.deps),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.profile.save).not.toHaveBeenCalled();
  });
  it('denies revoked authority and missing subject', async () => {
    const f = fixture();
    f.assertOperation.mockRejectedValueOnce(new Error('revoked'));
    await expect(saveSkillExperience(subject, 'note', f.deps)).rejects.toThrow(
      'revoked',
    );
    await expect(
      saveSkillExperience({ ...subject, userId: '' }, 'note', f.deps),
    ).rejects.toThrow();
    expect(f.profile.save).not.toHaveBeenCalled();
  });
  it.each([
    'oops',
    '{"version":2}',
    '{"version":1,"facts":[]}',
  ])('rejects malformed prior facts %s', async (raw) => {
    const f = fixture();
    f.profile.factsJson = raw;
    await expect(
      saveSkillExperience(subject, 'note', f.deps),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.profile.factsJson).toBe(raw);
    expect(f.profile.save).not.toHaveBeenCalled();
  });
  it('rejects invalid input and propagates persistence failures', async () => {
    const f = fixture();
    for (const value of [null, 'x'.repeat(4001)])
      await expect(
        saveSkillExperience(subject, value, f.deps),
      ).rejects.toMatchObject({ status: 400 });
    f.profile.save.mockRejectedValueOnce(new Error('write failed'));
    await expect(saveSkillExperience(subject, 'note', f.deps)).rejects.toThrow(
      'write failed',
    );
  });
});
