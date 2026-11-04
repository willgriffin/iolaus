import { resolveDatabase } from '@happyvertical/smrt-core';
import { getRequestScopedDatabase } from '@happyvertical/smrt-users';
import { error } from '@sveltejs/kit';
import { getDbConfig } from './db.js';
import {
  JobWorkspaceSubjectError,
  runAsRevalidatedJobWorkspaceSubject,
} from './job-workspace-subject.js';
import {
  MATCHING_PREFERENCE_ITEM_MAX_LENGTH,
  MATCHING_PREFERENCE_MAX_ITEMS,
  matchingPreferenceDocument,
  readMatchingPreferences,
} from './matching-projection-input.js';
import { isOwnerAuthorityDenial } from './owner-principal.js';
import type { CandidateWorkspaceSubject } from './workspace-subject.js';

const where =
  'id = ? AND tenant_id = ? AND owner_user_id = ? AND active = TRUE';

async function withOwnedProfile<T>(
  subject: CandidateWorkspaceSubject,
  use: (
    db: Awaited<ReturnType<typeof resolveDatabase>>,
    args: string[],
    previous: string,
  ) => Promise<T>,
): Promise<T> {
  try {
    return await runAsRevalidatedJobWorkspaceSubject(
      subject,
      'profile.manage',
      async (owned, run) => {
        await run.assertOperation('workflow', 'profile.manage');
        const db =
          getRequestScopedDatabase() ?? (await resolveDatabase(getDbConfig()));
        const args = [owned.profileId, owned.tenantId, owned.userId];
        const {
          rows: [profile],
        } = await db.query(
          `SELECT preferences_json FROM candidate_profiles WHERE ${where}`,
          args,
        );
        if (!profile) error(403, 'An active owned profile is required.');
        if (typeof profile.preferences_json !== 'string')
          error(409, 'Profile preferences could not be read.');
        return await use(db, args, profile.preferences_json);
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

export async function loadMatchingPreferences(
  subject: CandidateWorkspaceSubject,
) {
  return await withOwnedProfile(subject, async (_db, _args, previous) => {
    const document = matchingPreferenceDocument(previous);
    if (!document) error(409, 'Profile preferences could not be read.');
    return readMatchingPreferences(document);
  });
}

function submittedLines(form: FormData, name: string): string[] {
  const value = form.get(name);
  if (
    typeof value !== 'string' ||
    value.length >
      (MATCHING_PREFERENCE_ITEM_MAX_LENGTH + 2) * MATCHING_PREFERENCE_MAX_ITEMS
  )
    error(400, 'Each preference can have up to 12 entries of 120 characters.');
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function saveMatchingPreferences(
  subject: CandidateWorkspaceSubject,
  form: FormData,
) {
  const next = readMatchingPreferences({
    targetRoles: submittedLines(form, 'targetRoles'),
    locations: submittedLines(form, 'locations'),
    remoteCountries: submittedLines(form, 'remoteCountries'),
    workModes: form.getAll('workModes'),
  });
  if (!next) error(400, 'Enter up to 12 valid preferences per field.');

  return await withOwnedProfile(subject, async (db, args, previous) => {
    const document = matchingPreferenceDocument(previous);
    if (!document) error(409, 'Profile preferences could not be read.');
    const { rows } = await db.query(
      `UPDATE candidate_profiles SET preferences_json = ?, updated_at = ?
       WHERE ${where} AND preferences_json = ? RETURNING id`,
      [
        JSON.stringify({
          ...document,
          ...next,
          // Onboarding's single-choice editor preserves a multi-mode list
          // when its own choice is unknown.
          workModeChoice:
            next.workModes.length === 0
              ? 'any'
              : next.workModes.length === 1
                ? next.workModes[0]
                : 'unknown',
        }),
        new Date().toISOString(),
        ...args,
        previous,
      ],
    );
    if (rows.length !== 1)
      error(409, 'Your profile changed while saving. Refresh and try again.');
  });
}
