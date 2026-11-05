import type { DatabaseInterface } from '@happyvertical/sql';
import { normalizeCountryReference } from './country-reference.js';
import {
  compileMatchingVocabulary,
  type normalizeMatchingCandidate,
  type normalizeMatchingPosting,
} from './normalized-matching.js';
import {
  fingerprintOpportunitySourceContent,
  parseOpportunitySourceContent,
} from './opportunity-source-content.js';
import { loadMatchingScreeningQuestions } from './screening-question-store.js';
import { SKILL_VOCABULARY_SEED_TERMS } from './skill-vocabulary.js';
import type { CandidateWorkspaceSubject } from './workspace-subject.js';

type Executor = Pick<DatabaseInterface, 'query'>;
type CandidateInput = Parameters<typeof normalizeMatchingCandidate>[0];
type PostingInput = Parameters<typeof normalizeMatchingPosting>[0];

const MAX_PROFILE_EVIDENCE_PER_KIND = 500;
const MAX_VOCABULARY_TERMS = 5000;
export const MATCHING_PREFERENCE_MAX_ITEMS = 12;
export const MATCHING_PREFERENCE_ITEM_MAX_LENGTH = 120;
export const MATCHING_WORK_MODES = ['remote', 'hybrid', 'onsite'] as const;

export interface MatchingPreferences {
  targetRoles: string[];
  locations: string[];
  workModes: string[];
  remoteCountries: string[];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function matchingPreferenceDocument(
  value: unknown,
): Record<string, unknown> | null {
  try {
    return record(JSON.parse(text(value) || '{}'));
  } catch {
    return null;
  }
}

function preferenceList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > MATCHING_PREFERENCE_MAX_ITEMS ||
    value.some(
      (item) =>
        typeof item !== 'string' ||
        item.length > MATCHING_PREFERENCE_ITEM_MAX_LENGTH ||
        Array.from(item).some((character) => {
          const code = character.charCodeAt(0);
          return code <= 0x1f || code === 0x7f;
        }),
    )
  )
    return null;
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

/** Matching has explicit search targets. A current career title is evidence, not intent. */
export function readMatchingPreferences(
  document: Record<string, unknown>,
): MatchingPreferences | null {
  const targetRoles = preferenceList(document.targetRoles);
  const locations = preferenceList(document.locations);
  const workModes = preferenceList(document.workModes)?.map((mode) =>
    mode.toLowerCase().replace(/[- ]/gu, ''),
  );
  const remoteCountries = preferenceList(document.remoteCountries);
  if (
    !targetRoles ||
    !locations ||
    !workModes ||
    !remoteCountries ||
    workModes.some(
      (mode) => !MATCHING_WORK_MODES.some((known) => known === mode),
    )
  )
    return null;
  return { targetRoles, locations, workModes, remoteCountries };
}

export function matchingPostingInput(
  row: Record<string, unknown>,
): PostingInput {
  const rawCapture = text(row.source_content_json).trim();
  const captureVersion = Number(row.source_content_version ?? 0);
  const fingerprint = text(row.source_content_fingerprint);
  if ((rawCapture && rawCapture !== '{}') || captureVersion || fingerprint) {
    const captured = parseOpportunitySourceContent(rawCapture);
    if (
      !captured ||
      !Number.isSafeInteger(captureVersion) ||
      captureVersion < 1 ||
      fingerprintOpportunitySourceContent(captured) !== fingerprint
    )
      return { title: '', description: '', location: '' };
    return {
      title: text(captured.title),
      description: text(captured.descriptionRaw),
      location: text(captured.locationNotes),
      workplaceType: text(captured.workMode),
    };
  }
  return {
    title: text(row.title),
    description: text(row.description_raw),
    location: text(row.location_notes).trim()
      ? text(row.location_notes)
      : text(row.locations),
    workplaceType: text(row.work_mode),
  };
}

const ownedProfileWhere =
  'id = ? AND tenant_id = ? AND owner_user_id = ? AND active = TRUE';
const ownedEvidenceWhere =
  'candidate_profile_id = ? AND tenant_id = ? AND owner_user_id = ?';

export async function loadMatchingCandidateInput(
  db: Executor,
  subject: CandidateWorkspaceSubject,
): Promise<CandidateInput | null> {
  const args = [subject.profileId, subject.tenantId, subject.userId];
  const {
    rows: [profile],
  } = await db.query(
    `SELECT preferences_json, facts_json, target_work_country_json
     FROM candidate_profiles WHERE ${ownedProfileWhere}`,
    args,
  );
  if (!profile) return null;

  const evidence: Array<CandidateInput['evidence'][number]> = [];
  const questions: Array<NonNullable<CandidateInput['questions']>[number]> = [];
  const preferencesDoc = matchingPreferenceDocument(profile.preferences_json);
  const preferences = preferencesDoc && readMatchingPreferences(preferencesDoc);
  let incomplete = !preferences;

  // A malformed or over-limit question set can never imply zero constraints.
  const screening = await loadMatchingScreeningQuestions(db, subject);
  if (screening.errors.length || screening.invalidQuestions.length)
    incomplete = true;
  for (const invalid of screening.invalidQuestions)
    questions.push({ id: invalid.id, text: '', required: true });
  for (const {
    id,
    text,
    importance,
    desiredAnswer,
    kind,
    active,
  } of screening.questions) {
    if (active)
      questions.push({
        id,
        text,
        required: importance === 'must_have',
        desiredAnswer,
        kind,
      });
  }

  const factsDoc = matchingPreferenceDocument(profile.facts_json);
  const facts = factsDoc?.version === 1 ? record(factsDoc.facts) : null;
  if (!factsDoc || (factsDoc.version !== undefined && !facts))
    incomplete = true;
  const note = record(facts?.skillExperience);
  if (note?.provenance === 'user_verified' && text(note.value).trim())
    evidence.push({
      id: `profile:${subject.profileId}:skillExperience`,
      text: text(note.value),
      kind: 'fact',
    });

  // Read current raw resume records. Historical model-generated skill
  // proposals can contain copied citations from since-deleted resume rows.
  const limit = MAX_PROFILE_EVIDENCE_PER_KIND + 1;
  const read = (
    table:
      | 'resume_skills'
      | 'resume_positions'
      | 'resume_achievements'
      | 'experiences'
      | 'projects'
      | 'achievements'
      | 'duties',
    columns: string,
    resumeSelection = false,
  ) =>
    db.query(
      `SELECT id, ${columns} FROM ${table}
       WHERE ${ownedEvidenceWhere}${resumeSelection ? ' AND use_on_resume = TRUE' : ''}
       ORDER BY id LIMIT ${limit}`,
      args,
    );
  const { rows: skills } = await read('resume_skills', 'label');
  const { rows: positions } = await read(
    'resume_positions',
    'position_id, role, company, blurb, start, end_label',
  );
  const { rows: achievements } = await read(
    'resume_achievements',
    'position_id, title, body, metric',
  );
  // The resume's position key is only usable when it resolves uniquely
  // within the same owned profile. A title or employer is not an activity ID.
  const activities = new Map<string, (typeof positions)[number] | null>();
  for (const row of positions.slice(0, MAX_PROFILE_EVIDENCE_PER_KIND)) {
    const key = text(row.position_id).trim();
    if (key) activities.set(key, activities.has(key) ? null : row);
  }
  for (const [kind, rows] of [
    ['skill', skills],
    ['position', positions],
    ['achievement', achievements],
  ] as const) {
    if (rows.length === limit) incomplete = true;
    for (const row of rows.slice(0, MAX_PROFILE_EVIDENCE_PER_KIND)) {
      const linkedPosition =
        kind === 'achievement'
          ? activities.get(text(row.position_id).trim())
          : undefined;
      const fields =
        kind === 'skill'
          ? [row.label]
          : kind === 'position'
            ? [row.role, row.start, row.end_label, row.company, row.blurb]
            : [row.title, row.body, row.metric];
      const raw = fields
        .map(text)
        .filter((value) => value.trim())
        .join('\n');
      if (raw)
        evidence.push({
          id: `${kind}:${String(row.id)}`,
          text: raw,
          kind: kind === 'skill' ? 'skill' : 'experience',
          activityId:
            kind === 'position'
              ? `position:${String(row.id)}`
              : linkedPosition
                ? `position:${String(linkedPosition.id)}`
                : undefined,
          ...(linkedPosition
            ? {
                activityPosition: {
                  role: text(linkedPosition.role),
                  start: text(linkedPosition.start),
                  end: text(linkedPosition.end_label),
                },
              }
            : {}),
          ...(kind === 'position'
            ? {
                position: {
                  role: text(row.role),
                  start: text(row.start),
                  end: text(row.end_label),
                },
              }
            : {}),
        });
    }
  }

  const { rows: experiences } = await read('experiences', 'summary', true);
  const { rows: projects } = await read(
    'projects',
    'experience_id, name, summary',
    true,
  );
  const { rows: projectAchievements } = await read(
    'achievements',
    'experience_id, project_id, title, body, metric',
    true,
  );
  const { rows: duties } = await read(
    'duties',
    'experience_id, project_id, title, body',
    true,
  );
  const experienceIds = new Set(
    experiences
      .slice(0, MAX_PROFILE_EVIDENCE_PER_KIND)
      .map((row) => String(row.id)),
  );
  const projectParents = new Map(
    projects
      .slice(0, MAX_PROFILE_EVIDENCE_PER_KIND)
      .map((row) => [String(row.id), text(row.experience_id)]),
  );
  for (const [kind, rows] of [
    ['career-experience', experiences],
    ['career-project', projects],
    ['career-achievement', projectAchievements],
    ['career-duty', duties],
  ] as const) {
    if (rows.length === limit) incomplete = true;
    for (const row of rows.slice(0, MAX_PROFILE_EVIDENCE_PER_KIND)) {
      const id = String(row.id);
      const experienceId =
        kind === 'career-experience' ? id : text(row.experience_id);
      const projectId = kind === 'career-project' ? id : text(row.project_id);
      const raw = [row.name, row.summary, row.title, row.body, row.metric]
        .map(text)
        .filter((value) => value.trim())
        .join('\n');
      if (!raw) continue;
      evidence.push({
        id: `${kind}:${id}`,
        text: raw,
        kind: 'experience',
        activityId: experienceIds.has(experienceId)
          ? `career-experience:${experienceId}`
          : undefined,
        projectActivityId:
          projectId && projectParents.get(projectId) === experienceId
            ? `career-project:${projectId}`
            : undefined,
      });
    }
  }

  const targetCountry = normalizeCountryReference(
    matchingPreferenceDocument(profile.target_work_country_json),
  );
  return {
    targetRoles: preferences ? preferences.targetRoles : [],
    locations: preferences?.locations.length
      ? preferences.locations
      : targetCountry
        ? [targetCountry.label]
        : [],
    workModes: preferences?.workModes ?? [],
    remoteCountries: preferences?.remoteCountries ?? [],
    evidence,
    questions,
    incomplete,
  };
}

function vocabularyArray(raw: unknown): unknown[] {
  const values: unknown = JSON.parse(text(raw) || '[]');
  if (!Array.isArray(values) || values.length > 100)
    throw new Error('Matching vocabulary contains an invalid term.');
  return values;
}

export async function loadMatchingVocabulary(db: Executor) {
  const { rows } = await db.query(
    `SELECT skill_slug, label, aliases_json, related_json, parent_slug, status
     FROM skill_terms ORDER BY skill_slug LIMIT ${MAX_VOCABULARY_TERMS + 1}`,
  );
  if (rows.length > MAX_VOCABULARY_TERMS)
    throw new Error('Matching vocabulary exceeds its supported size.');
  if (!rows.length)
    return compileMatchingVocabulary(SKILL_VOCABULARY_SEED_TERMS);
  return compileMatchingVocabulary(
    rows
      .filter((row) => row.status === 'seed' || row.status === 'confirmed')
      .map((row) => {
        const aliases = vocabularyArray(row.aliases_json);
        const related = vocabularyArray(row.related_json).map(
          (edge) => record(edge)?.slug,
        );
        if (
          [...aliases, ...related].some(
            (entry) => typeof entry !== 'string' || !entry.trim(),
          )
        )
          throw new Error(
            'Matching vocabulary contains an invalid relationship.',
          );
        const parent = text(row.parent_slug).trim();
        return {
          slug: text(row.skill_slug),
          label: text(row.label),
          aliases: aliases.map(text),
          related: related.map(text),
          narrowerThan: parent ? [parent] : [],
        };
      }),
  );
}
