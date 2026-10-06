import { error } from '@sveltejs/kit';
import {
  JobWorkspaceSubjectError,
  runAsRevalidatedJobWorkspaceSubject,
} from './job-workspace-subject.js';
import { isOwnerAuthorityDenial } from './owner-principal.js';
import {
  requireWorkspaceSubject,
  type WorkspaceSubject,
} from './private-workspace.js';
import { getCollection } from './smrt.js';

type Profile = Record<string, unknown> & { save?: () => Promise<void> };
export interface SkillExperienceDependencies {
  runFresh?: typeof runAsRevalidatedJobWorkspaceSubject;
  getProfile?: (subject: WorkspaceSubject) => Promise<Profile | null>;
}
function state(
  raw: unknown,
): Record<string, unknown> & { facts: Record<string, unknown> } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(String(raw || '{}'));
  } catch {
    error(409, 'Profile facts are malformed; repair them before saving.');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed.version !== undefined && parsed.version !== 1) ||
    (parsed.facts !== undefined &&
      (!parsed.facts ||
        typeof parsed.facts !== 'object' ||
        Array.isArray(parsed.facts)))
  )
    error(409, 'Profile facts are malformed; repair them before saving.');
  return {
    ...parsed,
    version: 1,
    facts: { ...(parsed.facts as Record<string, unknown> | undefined) },
  };
}
async function withProfile<T>(
  subject: WorkspaceSubject,
  deps: SkillExperienceDependencies,
  work: (profile: Profile) => Promise<T>,
) {
  try {
    return await (deps.runFresh ?? runAsRevalidatedJobWorkspaceSubject)(
      requireWorkspaceSubject(subject),
      'profile.manage',
      async (owned, run) => {
        await run.assertOperation('workflow', 'profile.manage');
        const profile = deps.getProfile
          ? await deps.getProfile(owned)
          : ((await (
              await getCollection('CandidateProfile')
            ).get(
              { id: owned.profileId },
              { cache: false },
            )) as unknown as Profile | null);
        if (
          !profile ||
          profile.id !== owned.profileId ||
          profile.tenantId !== owned.tenantId ||
          profile.ownerUserId !== owned.userId ||
          profile.active !== true
        )
          error(403, 'An active owned profile is required.');
        return await work(profile);
      },
    );
  } catch (cause) {
    if (
      cause instanceof JobWorkspaceSubjectError ||
      isOwnerAuthorityDenial(cause)
    )
      error(403, 'Current workspace permission is required.');
    throw cause;
  }
}
export async function loadSkillExperience(
  subject: WorkspaceSubject,
  deps: SkillExperienceDependencies = {},
) {
  return await withProfile(subject, deps, async (profile) => {
    const note = state(profile.factsJson).facts.skillExperience as
      | { value?: unknown; provenance?: unknown }
      | undefined;
    return note?.provenance === 'user_verified' &&
      typeof note.value === 'string'
      ? note.value
      : '';
  });
}
export async function saveSkillExperience(
  subject: WorkspaceSubject,
  value: unknown,
  deps: SkillExperienceDependencies = {},
) {
  if (typeof value !== 'string' || value.length > 4000)
    error(400, 'Skill experience must be text of at most 4,000 characters.');
  // Fresh native authority and an uncached owned record are resolved immediately at the write fence.
  return await withProfile(subject, deps, async (profile) => {
    const next = state(profile.factsJson);
    if (value.trim())
      next.facts.skillExperience = { value, provenance: 'user_verified' };
    else delete next.facts.skillExperience;
    if (typeof profile.save !== 'function')
      error(409, 'Profile cannot be saved.');
    profile.factsJson = JSON.stringify(next);
    await profile.save();
    return value.trim() ? value : '';
  });
}
