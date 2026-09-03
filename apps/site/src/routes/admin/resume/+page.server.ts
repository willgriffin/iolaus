import { fail, isHttpError } from '@sveltejs/kit';
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
} from '$lib/server/resume-data';
import { withPublishedCanonicalRefresh } from '$lib/server/resume-source-refresh';
import { getCollection } from '$lib/server/smrt';
import type { Actions, PageServerLoad } from './$types';

type RecordLike = Record<string, unknown> & {
  id?: string;
  save?: () => Promise<void>;
};

async function listRecords(className: string, orderBy = 'updated_at ASC') {
  const collection = await getCollection(className);
  const records = await collection.list({ limit: 1000, orderBy });
  return JSON.parse(JSON.stringify(records)) as RecordLike[];
}

function dateFormValue(value: FormDataEntryValue | null): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return new Date(`${value}T00:00:00.000Z`);
}

async function updateRecord(className: string, form: FormData, keys: string[]) {
  const id = String(form.get('id') ?? '');
  if (!id) return { ok: false, error: 'Missing record id' };
  const collection = await getCollection(className);
  const record = (await collection.get(id)) as RecordLike | null;
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
  await record.save();
  invalidatePublishedResumeCache();
  return await withPublishedCanonicalRefresh({ ok: true });
}

type ResumePageTab = 'data' | 'markdown' | 'pdf' | 'text';

function resumePageTab(value: string | null): ResumePageTab {
  if (value === 'markdown' || value === 'pdf' || value === 'text') return value;
  return 'data';
}

export const load: PageServerLoad = async ({ url }) => {
  const [normalizedSourceResult, tailoringConfigsResult, assetsResult] =
    await Promise.allSettled([
      loadNormalizedResumeSource(),
      listResumeTailoringConfigs(),
      listResumeAssets(),
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
      legacySource = await loadLegacyAdminResumeSource();
    } catch {
      // The static legacy source still makes the editor usable when the
      // normalized and legacy database reads are temporarily unavailable.
    }
  }
  const source = normalizedSource ?? legacySource ?? loadLegacyResumeSource();
  const [profiles, experiences, educationRecords] = normalizedRecordsAvailable
    ? await Promise.all([
        listRecords('CandidateProfile', 'profileKey ASC'),
        listRecords('Experience', 'sortOrder ASC'),
        listRecords('Education', 'sortOrder ASC'),
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
  generate: async ({ request }) => {
    const form = await request.formData();
    const tailoringId = String(form.get('tailoringId') ?? '');
    return await generateResumeAsset({ tailoringId });
  },
  regenerate: async ({ request }) => {
    const form = await request.formData();
    try {
      const asset = await regenerateResumeAsset(
        String(form.get('assetId') ?? ''),
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
  publish: async ({ request }) => {
    const form = await request.formData();
    return await publishResumeAsset(String(form.get('assetId') ?? ''));
  },
  updateProfile: async ({ request }) => {
    const form = await request.formData();
    return await updateRecord('CandidateProfile', form, [
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
    ]);
  },
  updateExperience: async ({ request }) => {
    const form = await request.formData();
    return await updateRecord('Experience', form, [
      'experienceKey',
      'url',
      'summary',
      'startDate',
      'endDate',
      'startPrecision',
      'endPrecision',
      'weight',
      'sortOrder',
    ]);
  },
  updateEducation: async ({ request }) => {
    const form = await request.formData();
    return await updateRecord('Education', form, [
      'profileKey',
      'title',
      'institution',
      'detail',
      'startDate',
      'endDate',
      'sortOrder',
    ]);
  },
  setDefaultProfile: async ({ request }) => {
    const form = await request.formData();
    const id = String(form.get('profileId') ?? '');
    if (!id) return { ok: false, error: 'Missing profile id' };
    const collection = await getCollection('CandidateProfile');
    const records = (await collection.list({
      limit: 1000,
    })) as unknown as RecordLike[];
    for (const record of records) {
      record.isDefault = record.id === id;
      if (record.id === id) record.active = true;
      if (typeof record.save === 'function') await record.save();
    }
    invalidatePublishedResumeCache();
    return await withPublishedCanonicalRefresh({ ok: true });
  },
};
