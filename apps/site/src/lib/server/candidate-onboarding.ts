import {
  resolveDatabase,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import {
  normalizeAnswerLabel,
  reusableAnswerLabelKey,
} from './candidate-answers.js';
import { getDbConfig } from './db.js';
import { getCollection, getRequestScopedSmrtOptions } from './smrt.js';

export const candidateFactProvenance = [
  'user_verified',
  'safe_derivation',
  'unresolved_question',
] as const;

/** Stable identity makes concurrent first-save upserts converge on one profile. */
export const DEFAULT_CANDIDATE_PROFILE_ID =
  '01991a7d-8f74-7c36-a4f9-6d7ac583a39b';

export type CandidateFactProvenance = (typeof candidateFactProvenance)[number];

export interface CandidateFact {
  provenance: Exclude<CandidateFactProvenance, 'unresolved_question'>;
  value: string;
}

export interface CandidateFactState {
  facts: Record<string, CandidateFact>;
  unresolvedQuestions: string[];
  version: 1;
}

export interface CandidateOnboardingInput {
  demographics?: Record<string, string>;
  email?: string;
  firstName?: string;
  githubUrl?: string;
  lastName?: string;
  linkedinUrl?: string;
  location?: string;
  name?: string;
  phone?: string;
  preferences?: Record<string, string | string[]>;
  profileKey?: string;
  reusableAnswers?: Array<{
    label: string;
    saveForReuse: boolean;
    value: string;
  }>;
  resumeAssetId?: string;
  resumeSource?: 'existing_asset' | 'not_selected' | 'upload_later';
  saveVoluntaryDemographics?: boolean;
  summary?: string;
  title?: string;
  workAuthorization?: string;
}

/**
 * The only authority accepted by private candidate persistence.  Callers must
 * resolve this from the authenticated request; profile selection is never
 * inferred from a global/default row.
 */
export interface CandidateOnboardingSubject {
  tenantId: string;
  userId: string;
  profileId?: string;
}

type MutableRecord = Record<string, unknown> & {
  id?: string;
  save: () => Promise<void>;
};

type Collection = {
  create: (payload: Record<string, unknown>) => Promise<MutableRecord>;
  get: (id: string) => Promise<MutableRecord | null>;
  list: (options?: Record<string, unknown>) => Promise<MutableRecord[]>;
};

type AtomicResumeAssetClaim = (
  assetId: string,
  profileId: string,
) => Promise<boolean>;

type OnboardingDatabase = Awaited<ReturnType<typeof resolveDatabase>>;
type TransactionalOnboardingDatabase = OnboardingDatabase & {
  transaction?: <T>(
    run: (transaction: OnboardingDatabase) => Promise<T>,
  ) => Promise<T>;
};

const MAX_SUBJECT_ID_LENGTH = 160;

function requiredSubjectId(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`A valid candidate ${label} is required.`);
  }
  const id = value.trim();
  if (
    !id ||
    id.length > MAX_SUBJECT_ID_LENGTH ||
    [...id].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error(`A valid candidate ${label} is required.`);
  }
  return id;
}

/** Reject malformed or partial scope before any collection query or mutation. */
export function requireCandidateOnboardingSubject(
  subject: CandidateOnboardingSubject,
): CandidateOnboardingSubject {
  return {
    tenantId: requiredSubjectId(subject?.tenantId, 'tenant ID'),
    userId: requiredSubjectId(subject?.userId, 'user ID'),
    ...(subject?.profileId === undefined
      ? {}
      : { profileId: requiredSubjectId(subject.profileId, 'profile ID') }),
  };
}

function requireCandidateProfileSubject(
  subject: CandidateOnboardingSubject,
): Required<CandidateOnboardingSubject> {
  const verified = requireCandidateOnboardingSubject(subject);
  return {
    ...verified,
    profileId: requiredSubjectId(verified.profileId, 'profile ID'),
  };
}

function subjectWhere(subject: Required<CandidateOnboardingSubject>) {
  return {
    candidateProfileId: subject.profileId,
    ownerUserId: subject.userId,
    tenantId: subject.tenantId,
  };
}

function profileWhere(subject: CandidateOnboardingSubject) {
  return { ownerUserId: subject.userId, tenantId: subject.tenantId };
}

/**
 * Claim an unowned resume in a single conditional write. The predicate is
 * deliberately re-evaluated by the database at write time, rather than
 * trusting an earlier collection read that another request could invalidate.
 */
export async function claimResumeAssetAtomically(
  database: Pick<OnboardingDatabase, 'query'>,
  assetId: string,
  subject: CandidateOnboardingSubject,
): Promise<boolean> {
  const scope = requireCandidateProfileSubject(subject);
  const id = requiredSubjectId(assetId, 'resume asset ID');
  const result = await database.query(
    `UPDATE resume_assets
       SET candidate_profile_id = ?
     WHERE id = ?
       AND asset_type = 'resume'
       AND tenant_id = ?
       AND owner_user_id = ?
       AND (candidate_profile_id IS NULL
         OR candidate_profile_id = ''
         OR candidate_profile_id = ?)
   RETURNING id`,
    scope.profileId,
    id,
    scope.tenantId,
    scope.userId,
    scope.profileId,
  );
  return Array.isArray(result.rows) && result.rows.length === 1;
}

export interface CandidateOnboardingCollections {
  candidateAnswers: Collection;
  candidateProfiles: Collection;
  claimResumeAsset?: AtomicResumeAssetClaim;
  resumeAssets: Collection;
}

export interface CandidateOnboardingResult {
  profile: MutableRecord;
  savedForReuse: number;
  selectedResumeAssetId: string;
}

/**
 * Limit onboarding resume choices to unclaimed assets and assets already
 * owned by the active candidate profile. Foreign profile metadata must not be
 * projected into the owner-facing form merely because it shares a database.
 */
export function isCandidateResumeAssetSelectable(
  asset: Record<string, unknown>,
  candidateProfileId?: string,
): boolean {
  if (stringValue(asset.assetType) !== 'resume') return false;
  const owner = stringValue(asset.candidateProfileId, 160);
  const profileId = stringValue(candidateProfileId, 160);
  return !owner || Boolean(profileId && owner === profileId);
}

const MAX_FACT_LENGTH = 2_000;
const MAX_REUSABLE_ANSWERS = 20;
const MAX_REUSABLE_ANSWER_LENGTH = 4_000;
const PROFILE_KEY = 'default';
const requiredCandidateFacts = [
  ['firstName', 'First name'],
  ['lastName', 'Last name'],
  ['email', 'Email address'],
  ['phone', 'Phone number'],
  ['location', 'Current location'],
  ['workAuthorization', 'Work authorization'],
] as const;

function stringValue(value: unknown, maximum = MAX_FACT_LENGTH): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > maximum) {
    throw new Error(
      `Candidate onboarding values must be ${maximum} characters or fewer.`,
    );
  }
  return text;
}

function profileKey(value: unknown): string {
  const key = stringValue(value, 120).toLowerCase();
  // A multi-profile UI can be added later. First-run onboarding has exactly
  // one durable profile, preventing answers and resume selection from being
  // silently scoped to a guessed profile.
  if (key && key !== PROFILE_KEY) {
    throw new Error('First-run onboarding supports only the default profile.');
  }
  return PROFILE_KEY;
}

function compactStringRecord(
  value: Record<string, string> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value ?? {})
      .map(([key, item]) => [stringValue(key, 160), stringValue(item)])
      .filter(([key, item]) => key && item),
  );
}

function compactPreferences(
  value: Record<string, string | string[]> | undefined,
): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(value ?? {})
      .map(([key, item]) => {
        const normalizedKey = stringValue(key, 160);
        if (Array.isArray(item)) {
          const normalized = item
            .map((entry) => stringValue(entry))
            .filter(Boolean);
          return [normalizedKey, normalized] as const;
        }
        return [normalizedKey, stringValue(item)] as const;
      })
      .filter(
        ([key, item]) => key && (Array.isArray(item) ? item.length > 0 : item),
      ),
  );
}

/**
 * Preserve the origin of each candidate fact. Empty values deliberately
 * become unresolved questions; nothing is manufactured to make onboarding
 * appear complete.
 */
export function candidateFactState(
  input: CandidateOnboardingInput,
): CandidateFactState {
  const direct: Record<string, string> = {
    email: stringValue(input.email),
    firstName: stringValue(input.firstName),
    githubUrl: stringValue(input.githubUrl),
    lastName: stringValue(input.lastName),
    linkedinUrl: stringValue(input.linkedinUrl),
    location: stringValue(input.location),
    name: stringValue(input.name),
    phone: stringValue(input.phone),
    summary: stringValue(input.summary),
    title: stringValue(input.title),
    workAuthorization: stringValue(input.workAuthorization),
  };
  const facts: Record<string, CandidateFact> = {};
  for (const [key, value] of Object.entries(direct)) {
    if (value) facts[key] = { provenance: 'user_verified', value };
  }

  // A display name may be composed only from two values the person already
  // verified. Keep that derivation explicit rather than presenting it as a
  // supplied legal/preferred name.
  if (!facts.name && facts.firstName && facts.lastName) {
    facts.name = {
      provenance: 'safe_derivation',
      value: `${facts.firstName.value} ${facts.lastName.value}`,
    };
  }

  return {
    facts,
    unresolvedQuestions: requiredCandidateFacts
      .filter(([key]) => !facts[key])
      .map(([, label]) => label),
    version: 1,
  };
}

async function defaultCollections(
  options: Pick<SmrtClassOptions, 'db'> = getRequestScopedSmrtOptions(),
  claimResumeAsset?: AtomicResumeAssetClaim,
): Promise<CandidateOnboardingCollections> {
  const [candidateProfiles, candidateAnswers, resumeAssets] = await Promise.all(
    [
      getCollection('CandidateProfile', options),
      getCollection('CandidateAnswer', options),
      getCollection('ResumeAsset', options),
    ],
  );
  return {
    candidateAnswers: candidateAnswers as unknown as Collection,
    candidateProfiles: candidateProfiles as unknown as Collection,
    claimResumeAsset,
    resumeAssets: resumeAssets as unknown as Collection,
  };
}

async function findDefaultProfile(
  collection: Collection,
  subject: CandidateOnboardingSubject,
): Promise<MutableRecord | null> {
  if (!subject.profileId) return null;
  const rows = await collection.list({
    limit: 100,
    orderBy: 'updated_at DESC',
    where: profileWhere(subject),
  });
  return (
    rows.find((row) => stringValue(row.id, 160) === subject.profileId) ?? null
  );
}

async function saveExplicitReusableAnswer(options: {
  collection: Collection;
  label: string;
  subject: Required<CandidateOnboardingSubject>;
  value: string;
}): Promise<void> {
  const label = stringValue(options.label, 500);
  const value = stringValue(options.value, MAX_REUSABLE_ANSWER_LENGTH);
  const labelKey = normalizeAnswerLabel(label);
  if (!label || !labelKey || !value) return;

  const existing = await options.collection.list({
    limit: 500,
    orderBy: 'updated_at DESC',
    where: subjectWhere(options.subject),
  });
  const matching = existing.filter(
    (row) => reusableAnswerLabelKey(row) === labelKey,
  );
  const now = new Date();
  if (matching[0]) {
    Object.assign(matching[0], {
      active: true,
      label,
      labelKey,
      provenance: 'explicit_reusable_answer',
      revokedForReuseAt: null,
      savedForReuseAt: now,
      value,
    });
    await matching[0].save();
  } else {
    const created = await options.collection.create({
      active: true,
      label,
      labelKey,
      ...subjectWhere(options.subject),
      profileKey: PROFILE_KEY,
      provenance: 'explicit_reusable_answer',
      revokedForReuseAt: null,
      savedForReuseAt: now,
      value,
    });
    await created.save();
    matching.unshift(created);
  }
  // Retain duplicate/revoked history while keeping exactly one active answer.
  for (const duplicate of matching.slice(1)) {
    if (duplicate.active === false) continue;
    duplicate.active = false;
    duplicate.revokedForReuseAt = now;
    await duplicate.save();
  }
}

async function selectResumeAsset(options: {
  assetId: string;
  claimResumeAsset?: AtomicResumeAssetClaim;
  collection: Collection;
  profile: MutableRecord;
  subject: Required<CandidateOnboardingSubject>;
}): Promise<string> {
  const id = stringValue(options.assetId, 160);
  if (!id) return '';
  const profileId = options.subject.profileId;
  if (options.claimResumeAsset) {
    if (!profileId || !(await options.claimResumeAsset(id, profileId))) {
      throw new Error(
        'Select an existing resume asset before saving onboarding.',
      );
    }
    return id;
  }
  const asset = await options.collection.get(id);
  if (!asset || stringValue(asset.assetType) !== 'resume') {
    throw new Error(
      'Select an existing resume asset before saving onboarding.',
    );
  }
  const owner = stringValue(asset.candidateProfileId, 160);
  if (
    stringValue(asset.tenantId, 160) !== options.subject.tenantId ||
    stringValue(asset.ownerUserId, 160) !== options.subject.userId
  ) {
    throw new Error('The selected resume asset belongs to another profile.');
  }
  if (owner && profileId && owner !== profileId) {
    throw new Error('The selected resume asset belongs to another profile.');
  }
  if (profileId && !owner) {
    asset.candidateProfileId = profileId;
    await asset.save();
  }
  return id;
}

/**
 * Reject an unavailable or foreign asset before writing any profile state.
 * A newly created profile has no durable ID yet, so claiming an unowned asset
 * remains part of `selectResumeAsset` after that profile is saved.
 */
async function validateResumeAssetSelection(options: {
  assetId: string;
  collection: Collection;
  subject: Required<CandidateOnboardingSubject>;
}): Promise<void> {
  const id = stringValue(options.assetId, 160);
  if (!id) return;
  const asset = await options.collection.get(id);
  if (!asset || stringValue(asset.assetType) !== 'resume') {
    throw new Error(
      'Select an existing resume asset before saving onboarding.',
    );
  }
  const owner = stringValue(asset.candidateProfileId, 160);
  if (
    stringValue(asset.tenantId, 160) !== options.subject.tenantId ||
    stringValue(asset.ownerUserId, 160) !== options.subject.userId
  ) {
    throw new Error('The selected resume asset belongs to another profile.');
  }
  const profileId = options.subject.profileId;
  if (owner && owner !== profileId) {
    throw new Error('The selected resume asset belongs to another profile.');
  }
}

/**
 * Persist first-run candidate data. Only a checked `saveForReuse` answer is
 * copied to the reusable library; all other onboarding facts remain private
 * profile context and are never silently promoted into later applications.
 */
export async function persistCandidateOnboarding(
  input: CandidateOnboardingInput,
  subject: CandidateOnboardingSubject,
  collections: CandidateOnboardingCollections,
): Promise<CandidateOnboardingResult> {
  const scope = requireCandidateOnboardingSubject(subject);
  const key = profileKey(input.profileKey);
  const facts = candidateFactState(input);
  const now = new Date();
  const selectedResumeAssetId = stringValue(input.resumeAssetId, 160);
  const resumeSource = selectedResumeAssetId
    ? 'existing_asset'
    : input.resumeSource === 'upload_later'
      ? 'upload_later'
      : 'not_selected';
  const profileValues = {
    demographicsConsentAt: input.saveVoluntaryDemographics ? now : null,
    demographicsJson: JSON.stringify(
      input.saveVoluntaryDemographics
        ? compactStringRecord(input.demographics)
        : {},
    ),
    email: stringValue(input.email),
    factsJson: JSON.stringify(facts),
    firstName: stringValue(input.firstName),
    githubUrl: stringValue(input.githubUrl),
    isDefault: true,
    lastName: stringValue(input.lastName),
    linkedinUrl: stringValue(input.linkedinUrl),
    location: stringValue(input.location),
    name: facts.facts.name?.value ?? '',
    onboardingCompletedAt: now,
    phone: stringValue(input.phone),
    preferencesJson: JSON.stringify(compactPreferences(input.preferences)),
    profileKey: key,
    resumeAssetId: selectedResumeAssetId,
    resumeSource,
    summary: stringValue(input.summary),
    title: stringValue(input.title),
    workAuthorization: stringValue(input.workAuthorization),
  };

  const profile = await findDefaultProfile(
    collections.candidateProfiles,
    scope,
  );
  if (!collections.claimResumeAsset) {
    await validateResumeAssetSelection({
      assetId: selectedResumeAssetId,
      collection: collections.resumeAssets,
      subject: scope,
    });
  }
  const savedProfile = profile
    ? Object.assign(profile, profileValues)
    : await collections.candidateProfiles.create({
        active: true,
        ownerUserId: scope.userId,
        tenantId: scope.tenantId,
        ...profileValues,
      });
  const selectedAsset = await selectResumeAsset({
    assetId: selectedResumeAssetId,
    claimResumeAsset: collections.claimResumeAsset,
    collection: collections.resumeAssets,
    profile: savedProfile,
    subject: requireCandidateProfileSubject({
      ...scope,
      profileId: stringValue(savedProfile.id, 160),
    }),
  });
  await savedProfile.save();

  const answers = (input.reusableAnswers ?? []).slice(0, MAX_REUSABLE_ANSWERS);
  let savedForReuse = 0;
  for (const answer of answers) {
    if (!answer.saveForReuse) continue;
    const label = stringValue(answer.label, 500);
    const value = stringValue(answer.value, MAX_REUSABLE_ANSWER_LENGTH);
    if (!label || !value) continue;
    await saveExplicitReusableAnswer({
      collection: collections.candidateAnswers,
      label,
      subject: requireCandidateProfileSubject({
        ...scope,
        profileId: stringValue(savedProfile.id, 160),
      }),
      value,
    });
    savedForReuse += 1;
  }

  return {
    profile: savedProfile,
    savedForReuse,
    selectedResumeAssetId: selectedAsset,
  };
}

/**
 * Persist onboarding inside one database transaction. Resume ownership is a
 * private relationship, so a failed competing claim must roll back the
 * profile reference as well as the asset mutation.
 */
export async function saveCandidateOnboarding(
  input: CandidateOnboardingInput,
  subject: CandidateOnboardingSubject,
  suppliedCollections?: CandidateOnboardingCollections,
): Promise<CandidateOnboardingResult> {
  if (suppliedCollections) {
    return await persistCandidateOnboarding(
      input,
      subject,
      suppliedCollections,
    );
  }

  const options = getRequestScopedSmrtOptions();
  const database = (await resolveDatabase(
    options.db ?? getDbConfig(),
  )) as TransactionalOnboardingDatabase;
  if (typeof database.transaction !== 'function') {
    throw new Error('Transactional onboarding storage is required.');
  }

  return await database.transaction(async (transaction) => {
    const collections = await defaultCollections(
      { db: transaction },
      async (assetId, profileId) =>
        await claimResumeAssetAtomically(transaction, assetId, {
          ...subject,
          profileId,
        }),
    );
    return await persistCandidateOnboarding(input, subject, collections);
  });
}
