import { isAbsolute, relative, resolve } from 'node:path';
import {
  normalizeAnswerLabel,
  reusableAnswerLabelKey,
} from './candidate-answers.js';
import { getIolausUserAssetsRoot } from './runtime-paths.js';
import { getCollection } from './smrt.js';

export const candidateFactProvenance = [
  'user_verified',
  'safe_derivation',
  'unresolved_question',
] as const;

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

type MutableRecord = Record<string, unknown> & {
  id?: string;
  save: () => Promise<void>;
};

type Collection = {
  create: (payload: Record<string, unknown>) => Promise<MutableRecord>;
  get: (id: string) => Promise<MutableRecord | null>;
  list: (options?: Record<string, unknown>) => Promise<MutableRecord[]>;
};

export interface CandidateOnboardingCollections {
  candidateAnswers: Collection;
  candidateProfiles: Collection;
  resumeAssets: Collection;
}

export interface CandidateOnboardingResult {
  profile: MutableRecord;
  savedForReuse: number;
  selectedResumeAssetId: string;
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

/**
 * Relative destination for a user-owned asset. The active resume filesystem's
 * base is the runtime-owned external data root, so this path never selects a
 * source-tree destination and cannot escape the selected profile directory.
 */
export function candidateAssetPath(
  candidateProfileKey: string,
  fileName: string,
): string {
  const key = profileKey(candidateProfileKey);
  const name = stringValue(fileName, 240);
  if (!name || name.includes('/') || name.includes('\\')) {
    throw new Error('A candidate asset filename must be a single filename.');
  }
  return `profiles/${key}/assets/${name}`;
}

/**
 * Resolve a profile-owned asset below the runtime-selected external asset
 * root. The runtime rejects source-tree roots; this additional boundary check
 * protects this caller if a custom filesystem root is ever supplied.
 */
export function resolveCandidateAssetPath(
  candidateProfileKey: string,
  fileName: string,
  assetsRoot = getIolausUserAssetsRoot(),
): string {
  const root = resolve(assetsRoot);
  const target = resolve(
    root,
    candidateAssetPath(candidateProfileKey, fileName),
  );
  const relativeTarget = relative(root, target);
  if (
    !relativeTarget || // files live below a profile directory, never at root
    relativeTarget.startsWith('..') ||
    isAbsolute(relativeTarget)
  ) {
    throw new Error(
      'A candidate asset must remain below the local asset root.',
    );
  }
  return target;
}

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

async function defaultCollections(): Promise<CandidateOnboardingCollections> {
  const [candidateProfiles, candidateAnswers, resumeAssets] = await Promise.all(
    [
      getCollection('CandidateProfile'),
      getCollection('CandidateAnswer'),
      getCollection('ResumeAsset'),
    ],
  );
  return {
    candidateAnswers: candidateAnswers as unknown as Collection,
    candidateProfiles: candidateProfiles as unknown as Collection,
    resumeAssets: resumeAssets as unknown as Collection,
  };
}

async function findDefaultProfile(
  collection: Collection,
): Promise<MutableRecord | null> {
  const rows = await collection.list({
    limit: 100,
    orderBy: 'updated_at DESC',
    where: { profileKey: PROFILE_KEY },
  });
  return rows.find((row) => row.active !== false) ?? rows[0] ?? null;
}

async function saveExplicitReusableAnswer(options: {
  collection: Collection;
  label: string;
  profileKey: string;
  value: string;
}): Promise<void> {
  const label = stringValue(options.label, 500);
  const value = stringValue(options.value, MAX_REUSABLE_ANSWER_LENGTH);
  const labelKey = normalizeAnswerLabel(label);
  if (!label || !labelKey || !value) return;

  const existing = await options.collection.list({
    limit: 500,
    orderBy: 'updated_at DESC',
    where: { profileKey: options.profileKey },
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
      profileKey: options.profileKey,
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
  collection: Collection;
  profile: MutableRecord;
}): Promise<string> {
  const id = stringValue(options.assetId, 160);
  if (!id) return '';
  const asset = await options.collection.get(id);
  if (!asset || stringValue(asset.assetType) !== 'resume') {
    throw new Error(
      'Select an existing resume asset before saving onboarding.',
    );
  }
  const owner = stringValue(asset.candidateProfileId, 160);
  const profileId = stringValue(options.profile.id, 160);
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
 * Persist first-run candidate data. Only a checked `saveForReuse` answer is
 * copied to the reusable library; all other onboarding facts remain private
 * profile context and are never silently promoted into later applications.
 */
export async function saveCandidateOnboarding(
  input: CandidateOnboardingInput,
  suppliedCollections?: CandidateOnboardingCollections,
): Promise<CandidateOnboardingResult> {
  const collections = suppliedCollections ?? (await defaultCollections());
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

  const profile = await findDefaultProfile(collections.candidateProfiles);
  const savedProfile = profile
    ? Object.assign(profile, profileValues)
    : await collections.candidateProfiles.create({
        active: true,
        ...profileValues,
      });
  await savedProfile.save();

  const selectedAsset = await selectResumeAsset({
    assetId: selectedResumeAssetId,
    collection: collections.resumeAssets,
    profile: savedProfile,
  });

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
      profileKey: key,
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
