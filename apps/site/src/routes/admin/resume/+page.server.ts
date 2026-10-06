import { error, fail, isHttpError } from '@sveltejs/kit';
import { isSharedHosted } from '$lib/server/app-config';
import {
  isOwnerAuthorityDenial,
  runAsOwner,
} from '$lib/server/owner-principal';
import {
  candidateProfileWhere,
  getPrivateRecord,
  listPrivateRecords,
  requireWorkspaceSubject,
  type WorkspaceSubject,
} from '$lib/server/private-workspace';
import {
  generateResumeAsset,
  loadResumeAssetPreviews,
  publishResumeAsset,
  regenerateResumeAsset,
} from '$lib/server/resume-admin';
import {
  invalidatePublishedResumeCache,
  listResumeAssets,
  listResumeTailoringConfigs,
  loadLegacyAdminResumeSource,
  loadLegacyResumeSource,
  loadNormalizedResumeSource,
  loadPublishedResumeSource,
} from '$lib/server/resume-data';
import { withPublishedCanonicalRefresh } from '$lib/server/resume-source-refresh';
import { getCollection } from '$lib/server/smrt';
import {
  requireCandidateWorkspaceSubject,
  withVerifiedWorkspaceSubject,
  workspaceSubjectFromLocals,
} from '$lib/server/workspace-subject';
import { workspaceWorkflowOperation } from '$lib/server/workspace-workflow-capabilities';
import type { Actions, PageServerLoad } from './$types';

type RecordLike = Record<string, unknown> & {
  id?: string;
  save?: () => Promise<void>;
};

function subjectFromLocals(locals: App.Locals): WorkspaceSubject {
  return requireWorkspaceSubject(
    requireCandidateWorkspaceSubject(workspaceSubjectFromLocals(locals)),
  );
}

async function runResumeMutation<T>(
  locals: App.Locals,
  fn: (
    subject: WorkspaceSubject,
    assertWriteAllowed: () => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  const subject = subjectFromLocals(locals);
  const operation = workspaceWorkflowOperation('profile.manage');
  const assertWriteAllowed = async () => {
    await runAsOwner(
      locals,
      async (run) => {
        await run.assertOperation(operation.collection, operation.action);
        await withVerifiedWorkspaceSubject(subject, async () => undefined);
      },
      { action: 'admin.resume.write' },
    );
  };
  try {
    return await runAsOwner(
      locals,
      async (run) => {
        await run.assertOperation(operation.collection, operation.action);
        return await withVerifiedWorkspaceSubject(
          subject,
          async (verified) =>
            await fn(requireWorkspaceSubject(verified), assertWriteAllowed),
        );
      },
      { action: 'admin.resume.manage' },
    );
  } catch (cause) {
    if (isOwnerAuthorityDenial(cause)) error(403, 'Forbidden');
    throw cause;
  }
}

async function listRecords(
  className: string,
  subject: WorkspaceSubject,
  orderBy = 'updated_at ASC',
) {
  if (className === 'CandidateProfile') {
    const profile = await getPrivateRecord(
      className,
      subject.profileId,
      subject,
    );
    return profile
      ? (JSON.parse(JSON.stringify([profile])) as RecordLike[])
      : [];
  }
  return JSON.parse(
    JSON.stringify(
      await listPrivateRecords(className, subject, { limit: 1000, orderBy }),
    ),
  ) as RecordLike[];
}

async function savedResumeData() {
  invalidatePublishedResumeCache();
  // A shared candidate edit must never refresh a global public resume or other owners' applications.
  return isSharedHosted()
    ? { ok: true, message: 'Saved resume data.' }
    : await withPublishedCanonicalRefresh({ ok: true });
}

function dateFormValue(value: FormDataEntryValue | null): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return new Date(`${value}T00:00:00.000Z`);
}

async function updateRecord(
  className: string,
  form: FormData,
  keys: string[],
  subject: WorkspaceSubject,
  assertWriteAllowed: () => Promise<void>,
) {
  const id = String(form.get('id') ?? '');
  if (!id) return { ok: false, error: 'Missing record id' };
  const record = (await getPrivateRecord(
    className,
    id,
    subject,
  )) as RecordLike | null;
  if (!record) return { ok: false, error: 'Record not found' };
  for (const key of keys) {
    const value = form.get(key);
    if (key.endsWith('Date')) record[key] = dateFormValue(value);
    else if (key === 'weight' || key === 'sortOrder') {
      record[key] =
        typeof value === 'string' && value.trim() !== '' ? Number(value) : 0;
    } else if (key === 'active' || key === 'isDefault')
      record[key] = value === 'on';
    else record[key] = typeof value === 'string' ? value.trim() : '';
  }
  if (typeof record.save !== 'function')
    return { ok: false, error: 'Record cannot be saved' };
  await assertWriteAllowed();
  await record.save();
  return await savedResumeData();
}

type ResumePageTab = 'data' | 'markdown' | 'pdf' | 'text';

function resumePageTab(value: string | null): ResumePageTab {
  if (value === 'markdown' || value === 'pdf' || value === 'text') return value;
  return 'data';
}

export const load: PageServerLoad = async ({ locals, url }) => {
  const subject = subjectFromLocals(locals);
  const [normalizedSourceResult, tailoringConfigsResult, assetsResult] =
    await Promise.allSettled([
      loadNormalizedResumeSource(undefined, subject),
      listResumeTailoringConfigs(subject),
      listResumeAssets(subject),
    ]);

  const normalizedSource =
    normalizedSourceResult.status === 'fulfilled'
      ? normalizedSourceResult.value
      : null;
  const normalizedRecordsAvailable =
    normalizedSourceResult.status === 'fulfilled';
  const activeResumeTab = resumePageTab(url.searchParams.get('tab'));
  const tailoringConfigs =
    tailoringConfigsResult.status === 'fulfilled'
      ? tailoringConfigsResult.value
      : [];
  const assets =
    assetsResult.status === 'fulfilled'
      ? await loadResumeAssetPreviews(
          assetsResult.value,
          undefined,
          activeResumeTab === 'markdown'
            ? 'markdown'
            : activeResumeTab === 'text'
              ? 'text'
              : 'none',
        )
      : [];
  let legacySource = null;
  if (!normalizedSource) {
    try {
      legacySource = await loadLegacyAdminResumeSource(undefined, subject);
    } catch {
      // The static legacy source still makes the editor usable when the
      // normalized and legacy database reads are temporarily unavailable.
    }
  }
  const source =
    normalizedSource ??
    legacySource ??
    (isSharedHosted()
      ? await loadPublishedResumeSource()
      : loadLegacyResumeSource());
  const [profiles, experiences, educationRecords] = normalizedRecordsAvailable
    ? await Promise.all([
        listRecords('CandidateProfile', subject, 'profileKey ASC'),
        listRecords('Experience', subject, 'sortOrder ASC'),
        listRecords('Education', subject, 'sortOrder ASC'),
      ])
    : [[], [], []];

  return {
    activeResumeTab,
    assets,
    educationRecords,
    experiences,
    profiles,
    source,
    tailoringConfigs,
  };
};

export const actions: Actions = {
  generate: async ({ locals, request }) => {
    const form = await request.formData();
    const tailoringId = String(form.get('tailoringId') ?? '');
    return await runResumeMutation(
      locals,
      async (subject, assertWriteAllowed) =>
        await generateResumeAsset({ tailoringId, subject, assertWriteAllowed }),
    );
  },
  regenerate: async ({ locals, request }) => {
    const form = await request.formData();
    try {
      const asset = await runResumeMutation(
        locals,
        async (subject, assertWriteAllowed) =>
          await regenerateResumeAsset(
            String(form.get('assetId') ?? ''),
            undefined,
            subject,
            assertWriteAllowed,
          ),
      );
      return {
        assetId: asset.id,
        message: 'Resume regenerated.',
        ok: true,
      };
    } catch (cause) {
      if (isHttpError(cause)) {
        return fail(cause.status, {
          error: cause.body.message,
          ok: false,
        });
      }
      console.error('Resume regeneration failed.', cause);
      return fail(500, {
        error:
          'Resume regeneration failed. Check the resume history and retry.',
        ok: false,
      });
    }
  },
  publish: async ({ locals, request }) => {
    const form = await request.formData();
    return await runResumeMutation(
      locals,
      async (subject, assertWriteAllowed) =>
        await publishResumeAsset(
          String(form.get('assetId') ?? ''),
          undefined,
          subject,
          assertWriteAllowed,
        ),
    );
  },
  updateProfile: async ({ locals, request }) => {
    const form = await request.formData();
    return await runResumeMutation(
      locals,
      async (subject, assertWriteAllowed) =>
        await updateRecord(
          'CandidateProfile',
          form,
          [
            'profileKey',
            'name',
            'firstName',
            'lastName',
            'title',
            'email',
            'phone',
            'location',
            'linkedinUrl',
            'githubUrl',
            'workAuthorization',
            'summary',
            'active',
            'isDefault',
          ],
          subject,
          assertWriteAllowed,
        ),
    );
  },
  updateExperience: async ({ locals, request }) => {
    const form = await request.formData();
    return await runResumeMutation(
      locals,
      async (subject, assertWriteAllowed) =>
        await updateRecord(
          'Experience',
          form,
          [
            'experienceKey',
            'url',
            'summary',
            'startDate',
            'endDate',
            'startPrecision',
            'endPrecision',
            'weight',
            'sortOrder',
          ],
          subject,
          assertWriteAllowed,
        ),
    );
  },
  updateEducation: async ({ locals, request }) => {
    const form = await request.formData();
    return await runResumeMutation(
      locals,
      async (subject, assertWriteAllowed) =>
        await updateRecord(
          'Education',
          form,
          [
            'profileKey',
            'title',
            'institution',
            'detail',
            'startDate',
            'endDate',
            'sortOrder',
          ],
          subject,
          assertWriteAllowed,
        ),
    );
  },
  setDefaultProfile: async ({ locals, request }) => {
    const form = await request.formData();
    const id = String(form.get('profileId') ?? '');
    if (!id) return { ok: false, error: 'Missing profile id' };
    return await runResumeMutation(
      locals,
      async (subject, assertWriteAllowed) => {
        const profile = await getPrivateRecord('CandidateProfile', id, subject);
        if (!profile) error(404, 'Profile not found.');
        const collection = await getCollection('CandidateProfile');
        const records = (await collection.list({
          limit: 1000,
          where: candidateProfileWhere(subject),
        })) as unknown as RecordLike[];
        for (const record of records) {
          if (
            record.tenantId !== subject.tenantId ||
            record.ownerUserId !== subject.userId
          )
            continue;
          record.isDefault = record.id === id;
          if (record.id === id) record.active = true;
          if (typeof record.save === 'function') {
            await assertWriteAllowed();
            await record.save();
          }
        }
        return await savedResumeData();
      },
    );
  },
};
