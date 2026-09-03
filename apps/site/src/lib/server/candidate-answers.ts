// Reusable candidate answers: conservative seeding of ATS application forms
// from the private candidate profile facts and the explicitly reusable answer
// library (CandidateAnswer rows saved by the user via "save for reuse").
//
// Safety rules (see issue #356 and docs/auto-submit-design.md):
// - Only stable identity/contact fields map from profile facts, via exact
//   normalized label matches — no fuzzy or substring matching, no invented
//   values. A missing profile value simply leaves the question unanswered.
// - Library answers match only on the exact normalized question label.
// - Every seeded value is copied onto the specific Application's
//   `requiredAnswersJson` and never overwrites an existing answer. A later
//   profile or library edit cannot mutate an application that already holds
//   the copied value.
// - Narrative/role-specific judgment stays per-application: only what the user
//   explicitly saved for reuse is reused.

import { createHash } from 'node:crypto';
import { isAtsFileQuestion, parseAtsFormSchema } from './ats/index.js';
import type { AtsFormSchema } from './ats/types.js';
import { parseRequiredAnswers } from './auto-submit-eligibility.js';
import { getCollection } from './smrt.js';

/** Profile facts that may seed ATS identity/contact questions. */
export interface CandidateProfileFacts {
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string;
  location: string;
  workAuthorization: string;
  linkedinUrl: string;
  githubUrl: string;
}

export type CandidateAnswerSource = 'application' | 'library' | 'profile';

export interface SeededApplicationAnswers {
  /** Final answer map: existing answers preserved, seeds only fill gaps. */
  answers: Record<string, string>;
  /** Where each seeded (non-pre-existing) answer came from. */
  seededFrom: Record<string, CandidateAnswerSource>;
}

type ProfileFactKey = keyof CandidateProfileFacts;

interface ProfileSeedTarget {
  fact: ProfileFactKey;
  labels: readonly string[];
}

// Conservative alias table: a question label maps to a profile fact only when
// its normalized form equals one of these entries.
const profileSeedTargets: readonly ProfileSeedTarget[] = [
  { fact: 'firstName', labels: ['first name', 'given name'] },
  { fact: 'lastName', labels: ['last name', 'family name', 'surname'] },
  { fact: 'fullName', labels: ['full name', 'name', 'your name'] },
  {
    fact: 'email',
    labels: ['email', 'email address', 'e%2dmail address', 'e mail address'],
  },
  {
    fact: 'phone',
    labels: [
      'phone',
      'phone number',
      'mobile',
      'mobile number',
      'mobile phone',
      'cell',
      'cell phone',
      'telephone',
      'telephone number',
      'primary phone',
      'primary phone number',
    ],
  },
  { fact: 'location', labels: ['location', 'current location'] },
  {
    fact: 'workAuthorization',
    labels: [
      'work authorization',
      'work authorization status',
      'work eligibility',
    ],
  },
  {
    fact: 'linkedinUrl',
    labels: [
      'linkedin',
      'linkedin url',
      'linkedin profile',
      'linkedin profile url',
      'linkedin page',
    ],
  },
  {
    fact: 'githubUrl',
    labels: ['github', 'github url', 'github profile', 'github profile url'],
  },
];

const profileSeedIndex: Map<string, ProfileFactKey> = new Map(
  profileSeedTargets.flatMap((target) =>
    target.labels.map((label) => [label, target.fact]),
  ),
);

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Normalize an ATS question label (or library label) for conservative exact
 * matching. Lowercase and collapse whitespace, then percent-encode every
 * punctuation character so the key is injective: labels that differ in any
 * symbol — including trailing symbols such as "C++" and "C#" — can never
 * collapse into one key and cross-seed each other.
 */
export function normalizeAnswerLabel(label: unknown): string {
  return stringValue(label)
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Return a reusable answer's canonical, collision-safe key. The human label
 * is authoritative when present so rows saved before a key-format refinement
 * remain usable without falling back to fuzzy matching. A missing label is
 * never guessed: only then is the stored key retained as-is.
 */
export function reusableAnswerLabelKey(row: Record<string, unknown>): string {
  const label = stringValue(row.label);
  return label ? normalizeAnswerLabel(label) : stringValue(row.labelKey);
}

/**
 * Pick the profile whose facts seed applications: the designated default
 * (isDefault, as set by the profile admin) first, then the canonical
 * 'default' profile key, then the newest active record. Callers pass active
 * profiles newest-first.
 */
export function selectSeedingProfile(
  rows: readonly Record<string, unknown>[],
): Record<string, unknown> | null {
  const active = rows.filter((row) => row.active !== false);
  return (
    active.find((row) => row.isDefault === true) ??
    active.find((row) => stringValue(row.profileKey) === 'default') ??
    active[0] ??
    null
  );
}

/** Extract the seedable identity/contact facts from a CandidateProfile record. */
export function candidateProfileFacts(
  profile: Record<string, unknown>,
): CandidateProfileFacts {
  const firstName = stringValue(profile.firstName);
  const lastName = stringValue(profile.lastName);
  return {
    firstName,
    lastName,
    fullName:
      stringValue(profile.name) ||
      [firstName, lastName].filter(Boolean).join(' '),
    email: stringValue(profile.email),
    phone: stringValue(profile.phone),
    location: stringValue(profile.location),
    workAuthorization: stringValue(profile.workAuthorization),
    linkedinUrl: stringValue(profile.linkedinUrl),
    githubUrl: stringValue(profile.githubUrl),
  };
}

/** Map a normalized question label to a profile fact, or null when unmapped. */
export function profileFactForLabel(label: unknown): ProfileFactKey | null {
  return profileSeedIndex.get(normalizeAnswerLabel(label)) ?? null;
}

export interface SeedApplicationAnswersInput {
  schema: AtsFormSchema;
  /** Profile facts for conservative identity/contact mapping. */
  facts: CandidateProfileFacts;
  /**
   * Explicitly reusable library answers keyed by normalized question label
   * (from active CandidateAnswer rows).
   */
  reusableAnswers: Record<string, string>;
  /**
   * The application's own current answers. These always win: seeding only
   * fills gaps and never rewrites application-specific history.
   */
  existingAnswers: Record<string, string>;
}

/**
 * Pure seed computation for one application's persisted form schema. Answers
 * are only produced for scalar questions; a seed never replaces an existing
 * application answer, and unknown/unmapped questions stay unanswered.
 */
export function seedApplicationAnswers(
  input: SeedApplicationAnswersInput,
): SeededApplicationAnswers {
  const answers: Record<string, string> = { ...input.existingAnswers };
  const seededFrom: Record<string, CandidateAnswerSource> = {};

  for (const question of input.schema.questions) {
    if (isAtsFileQuestion(input.schema.ats, question.type)) continue;
    const questionId = stringValue(question.id);
    if (!questionId || stringValue(answers[questionId])) continue;

    // Explicit reusable answers win over profile aliases: the user saved that
    // value deliberately for this exact question.
    const libraryLabel = normalizeAnswerLabel(question.label);
    const libraryValue = stringValue(input.reusableAnswers[libraryLabel]);
    if (libraryValue) {
      answers[questionId] = libraryValue;
      seededFrom[questionId] = 'library';
      continue;
    }

    const fact = profileFactForLabel(question.label);
    if (!fact) continue;
    const factValue =
      fact === 'fullName'
        ? input.facts.fullName
        : stringValue(input.facts[fact]);
    if (!factValue) continue;
    answers[questionId] = factValue;
    seededFrom[questionId] = 'profile';
  }

  return { answers, seededFrom };
}

export interface ApplicationSeedSummary {
  seeded: number;
  seededFrom: Record<string, CandidateAnswerSource>;
}

/**
 * Load the default candidate profile facts and active reusable answers, then
 * fill any missing answers on `application.requiredAnswersJson` for the
 * application's persisted form schema. Mutates only that application record's
 * field; the caller persists. Best-effort by construction: with no profile,
 * no schema, or no matches, nothing changes.
 */
export async function seedApplicationAnswersFromCandidateProfile(
  application: Record<string, unknown>,
): Promise<ApplicationSeedSummary> {
  const empty: ApplicationSeedSummary = { seeded: 0, seededFrom: {} };
  const schema = parseAtsFormSchema(application.requiredQuestionsJson);
  if (!schema) return empty;

  const profiles = await getCollection('CandidateProfile');
  const profileRecords = (await profiles.list({
    limit: 100,
    orderBy: 'updated_at DESC',
    where: { active: true },
  })) as unknown as Record<string, unknown>[];
  const profile = selectSeedingProfile(profileRecords);
  const libraryProfileKey = stringValue(profile?.profileKey) || 'default';

  const answersCollection = await getCollection('CandidateAnswer');
  const reusableAnswers = reusableAnswersFromLibrary(
    ((await answersCollection.list({
      limit: 500,
      orderBy: 'updated_at DESC',
      where: { profileKey: libraryProfileKey, active: true },
    })) as unknown as Record<string, unknown>[]) ?? [],
  );

  const result = seedApplicationAnswers({
    schema,
    facts: profile
      ? candidateProfileFacts(profile)
      : {
          firstName: '',
          lastName: '',
          fullName: '',
          email: '',
          phone: '',
          location: '',
          workAuthorization: '',
          linkedinUrl: '',
          githubUrl: '',
        },
    reusableAnswers,
    existingAnswers: parseRequiredAnswers(application.requiredAnswersJson),
  });

  // Only write when a seed was applied: rewriting identical content (or
  // reformatting the stored JSON) would show up as a spurious application
  // change in the packet-generation concurrency diff.
  if (Object.keys(result.seededFrom).length === 0) {
    return empty;
  }
  application.requiredAnswersJson = JSON.stringify(result.answers);
  return {
    seeded: Object.keys(result.seededFrom).length,
    seededFrom: result.seededFrom,
  };
}

/**
 * Build the reusable-answers lookup keyed by normalized label. Newest row
 * wins, sorted here by (updated_at DESC, id DESC) so the result is
 * deterministic even when the caller's order is unavailable or a concurrent
 * save produced duplicate rows. Handles both Date objects (how SMRT exposes
 * timestamps) and their serialized ISO strings. The persisted human label is
 * normalized when available so legacy key encodings remain compatible without
 * ever matching a different label.
 */
export function reusableAnswersFromLibrary(
  rows: readonly Record<string, unknown>[],
): Record<string, string> {
  const ordered = [...rows].sort((a, b) => {
    const byTime = timestampKey(b.updated_at) - timestampKey(a.updated_at);
    return byTime !== 0
      ? byTime
      : stringValue(b.id).localeCompare(stringValue(a.id));
  });
  const reusable: Record<string, string> = {};
  for (const row of ordered) {
    if (row.active === false) continue;
    const labelKey = reusableAnswerLabelKey(row);
    const value = stringValue(row.value);
    if (labelKey && value && !(labelKey in reusable)) {
      reusable[labelKey] = value;
    }
  }
  return reusable;
}

function timestampKey(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(stringValue(value));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function oneLine(value: unknown): string {
  return stringValue(value).replace(/\s*\n+\s*/g, ' / ');
}

/**
 * Human-readable rendering of the application's captured answers, derived
 * strictly from application fields (schema + answers + free-text notes). It
 * deliberately never reads the profile or library so the answers material
 * fingerprint cannot be invalidated by a profile/library edit.
 */
export function describeApplicationAnswersBody(
  application: Record<string, unknown>,
): string {
  const lines: string[] = [];
  const instructions = oneLine(application.applicationInstructions);
  if (instructions) lines.push(`Instructions: ${instructions}`);
  const requiredAnswers = oneLine(application.requiredAnswers);
  if (requiredAnswers) lines.push(`Required answers: ${requiredAnswers}`);

  const schema = parseAtsFormSchema(application.requiredQuestionsJson);
  if (schema) {
    const answers = parseRequiredAnswers(application.requiredAnswersJson);
    const scalarQuestions = schema.questions.filter(
      (question) => !isAtsFileQuestion(schema.ats, question.type),
    );
    if (scalarQuestions.length > 0) {
      lines.push(``, `## Application form (${stringValue(schema.ats)})`, ``);
      for (const question of scalarQuestions) {
        const label = oneLine(question.label) || question.id;
        const answer = stringValue(answers[question.id]);
        lines.push(
          answer
            ? `- ${label}: ${oneLine(answer)}`
            : `- ${label}: (unanswered)`,
        );
      }
    }
    const fileQuestions = schema.questions.filter((question) =>
      isAtsFileQuestion(schema.ats, question.type),
    );
    if (fileQuestions.length > 0) {
      lines.push(
        ``,
        `File uploads are handled by the selected application artifacts (e.g. the resume).`,
      );
    }
  }
  // The readable rendering above deliberately omits question ids, types,
  // board/job identity, and raw JSON. The answers material fingerprint is
  // computed from this body, so close that gap with a digest of the exact
  // stored schema and answer payloads: any change to either moves the
  // fingerprint and re-triggers review.
  const digest = createHash('sha256')
    .update(
      `${stringValue(application.requiredQuestionsJson)}\n${stringValue(
        application.requiredAnswersJson,
      )}`,
    )
    .digest('hex');
  lines.push(``, `Answers fingerprint digest: ${digest}`);
  return lines.join('\n');
}

export interface ApplicationAnswersEditorQuestion {
  id: string;
  label: string;
  /** Normalized label key identifying this question in the library. */
  labelKey: string;
  required: boolean;
  answered: boolean;
  /** Current stored value, prefilled into the editor field. */
  value: string;
  /** Where the current value came from, or 'missing' when unanswered. */
  source: CandidateAnswerSource | 'missing';
  /** True when a reusable library answer exists for this question label. */
  inLibrary: boolean;
  /** The library copy's value for this label, '' when absent. */
  libraryValue: string;
  /** True when that library copy matches the value shown for this question. */
  savedForReuse: boolean;
}

export interface ApplicationAnswersEditorState {
  ats: string;
  hasSchema: boolean;
  questions: ApplicationAnswersEditorQuestion[];
  /** Number of active reusable answers in the library. */
  reusableAnswerCount: number;
}

/**
 * The profile key that scopes the reusable answer library: the same profile
 * whose facts seed applications (isDefault, else profileKey 'default', else
 * newest active). Keeping one source of truth prevents identity facts and
 * reusable answers from coming from different profiles.
 */
export async function resolveLibraryProfileKey(): Promise<string> {
  const profiles = (await getCollection('CandidateProfile')) as unknown as {
    list: (
      options?: Record<string, unknown>,
    ) => Promise<Record<string, unknown>[]>;
  };
  const rows = await profiles.list({
    limit: 100,
    orderBy: 'updated_at DESC',
    where: { active: true },
  });
  return stringValue(selectSeedingProfile(rows)?.profileKey) || 'default';
}

/**
 * Editor state for the review page's Answers tab: every scalar question of the
 * persisted schema with its current value, source (profile-prefilled,
 * application-specific, missing), and whether the value is already saved for
 * reuse. Reads the profile and library once; this state never feeds material
 * fingerprints.
 */
export async function loadApplicationAnswersEditorState(
  application: Record<string, unknown>,
): Promise<ApplicationAnswersEditorState> {
  const schema = parseAtsFormSchema(application.requiredQuestionsJson);
  if (!schema) {
    return { ats: '', hasSchema: false, questions: [], reusableAnswerCount: 0 };
  }

  const profiles = (await getCollection('CandidateProfile')) as unknown as {
    list: (
      options?: Record<string, unknown>,
    ) => Promise<Record<string, unknown>[]>;
  };
  const profileRows = await profiles.list({
    limit: 100,
    orderBy: 'updated_at DESC',
    where: { active: true },
  });
  const profile = selectSeedingProfile(profileRows);
  const libraryProfileKey = stringValue(profile?.profileKey) || 'default';

  const answersCollection = (await getCollection(
    'CandidateAnswer',
  )) as unknown as {
    list: (
      options?: Record<string, unknown>,
    ) => Promise<Record<string, unknown>[]>;
  };
  const libraryRows = await answersCollection.list({
    limit: 500,
    orderBy: 'updated_at DESC',
    where: { profileKey: libraryProfileKey, active: true },
  });
  const reusableAnswers = reusableAnswersFromLibrary(libraryRows);

  const stored = parseRequiredAnswers(application.requiredAnswersJson);
  // What the seeder would fill from a blank slate: this identifies both the
  // provenance of answers packet generation already stored (stored value still
  // equals the seed) and prefilled suggestions for questions it has not
  // stored yet.
  const seed = seedApplicationAnswers({
    schema,
    facts: profile
      ? candidateProfileFacts(profile)
      : {
          firstName: '',
          lastName: '',
          fullName: '',
          email: '',
          phone: '',
          location: '',
          workAuthorization: '',
          linkedinUrl: '',
          githubUrl: '',
        },
    reusableAnswers,
    existingAnswers: {},
  });

  const questions = schema.questions
    .filter((question) => !isAtsFileQuestion(schema.ats, question.type))
    .map((question) => {
      const id = stringValue(question.id);
      const storedValue = stringValue(stored[id]);
      const seededFrom = seed.seededFrom[id];
      const seededValue = stringValue(seed.answers[id]);
      const source: CandidateAnswerSource | 'missing' = storedValue
        ? seededFrom && seededValue === storedValue
          ? seededFrom
          : 'application'
        : seededFrom
          ? seededFrom
          : 'missing';
      // A profile/library suggestion for an unanswered question prefills the
      // editor but is not yet part of this application's answer record.
      // "Saved for reuse" is only true when the library copy of this label
      // holds the exact value shown, so the UI never claims a reusable copy
      // exists while the library would seed something different.
      const questionLabelKey = normalizeAnswerLabel(question.label);
      const libraryValue = stringValue(reusableAnswers[questionLabelKey]);
      const inLibrary = Boolean(libraryValue);
      return {
        answered: Boolean(storedValue),
        id,
        inLibrary,
        label: stringValue(question.label),
        labelKey: questionLabelKey,
        libraryValue,
        required: Boolean(question.required),
        savedForReuse:
          inLibrary && Boolean(storedValue) && libraryValue === storedValue,
        source,
        value: storedValue || seededValue,
      };
    });

  return {
    ats: stringValue(schema.ats),
    hasSchema: true,
    questions,
    reusableAnswerCount: Object.keys(reusableAnswers).length,
  };
}
