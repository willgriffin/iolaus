import { createHash, randomUUID } from 'node:crypto';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { getRequestScopedDatabase } from '@happyvertical/smrt-users';
import {
  createScreeningQuestion as canonicalQuestion,
  SCREENING_QUESTION_MAX_ACTIVE,
  type ScreeningQuestion,
  type ScreeningQuestionInput,
  screeningQuestionSetFingerprint,
  screeningQuestionSuggestions,
  validateScreeningQuestion,
} from '../opportunity-screening-questions.js';
import { getDbConfig } from './db.js';
import {
  JobWorkspaceSubjectError,
  runAsRevalidatedJobWorkspaceSubject,
} from './job-workspace-subject.js';
import { isOwnerAuthorityDenial } from './owner-principal.js';
import {
  candidateProfileWhere,
  requireWorkspaceSubject,
  type WorkspaceSubject,
} from './private-workspace.js';
import { getCollection } from './smrt.js';
import { WorkspaceSubjectError } from './workspace-subject.js';

export const SCREENING_QUESTION_RULE_CATEGORY = 'screening_questions';
export const SCREENING_QUESTION_RULE_VERSION = 'screening-question-rule/v1';
export const SCREENING_QUESTION_MAX_STORED = 40;
type Database = Pick<Awaited<ReturnType<typeof resolveDatabase>>, 'query'>;
export interface ScreeningQuestionSnapshot {
  questions: ScreeningQuestion[];
  questionSetFingerprint: string;
  errors: string[];
  suggestions?: ScreeningQuestionInput[];
  invalidQuestions: {
    id: string;
    label: string;
    errorCode: 'invalid_question_rule';
    revision: string;
  }[];
}
export interface ScreeningQuestionStoreDependencies {
  db?: Database;
  runFresh?: typeof runAsRevalidatedJobWorkspaceSubject;
  getProfile?: (id: string) => Promise<Record<string, unknown> | null>;
}
export class ScreeningQuestionStoreError extends Error {
  constructor(
    readonly code:
      | 'invalid_question'
      | 'revision_conflict'
      | 'not_found'
      | 'invalid_store',
    readonly status: 400 | 409 | 404,
    message: string,
  ) {
    super(message);
    this.name = 'ScreeningQuestionStoreError';
  }
}
const invalid = () =>
  new ScreeningQuestionStoreError(
    'invalid_store',
    409,
    'Screening question storage is malformed or ambiguous.',
  );
async function database(
  deps: ScreeningQuestionStoreDependencies,
): Promise<Database> {
  return (
    deps.db ??
    getRequestScopedDatabase() ??
    (await resolveDatabase(getDbConfig()))
  );
}
async function ownedProfile(
  subject: WorkspaceSubject,
  deps: ScreeningQuestionStoreDependencies,
): Promise<Record<string, unknown>> {
  const profile = deps.getProfile
    ? await deps.getProfile(subject.profileId)
    : (
        await (
          await getCollection('CandidateProfile')
        ).get({ id: subject.profileId }, { cache: false })
      )?.toJSON();
  if (
    !profile ||
    profile.id !== subject.profileId ||
    profile.active !== true ||
    Object.entries(candidateProfileWhere(subject)).some(
      ([key, value]) => profile[key] !== value,
    )
  )
    throw new WorkspaceSubjectError(
      403,
      'An active profile owned by the current workspace is required.',
    );
  return profile;
}
async function fresh<T>(
  subject: WorkspaceSubject,
  deps: ScreeningQuestionStoreDependencies,
  work: (
    owned: WorkspaceSubject,
    db: Database,
    profile: Record<string, unknown>,
  ) => Promise<T>,
  capability: 'profile.manage' | 'assessment.execute' = 'profile.manage',
): Promise<T> {
  try {
    return await (deps.runFresh ?? runAsRevalidatedJobWorkspaceSubject)(
      requireWorkspaceSubject(subject),
      capability,
      async (owned, run) => {
        await run.assertOperation('workflow', capability);
        const profile = await ownedProfile(owned, deps);
        return await work(owned, await database(deps), profile);
      },
    );
  } catch (cause) {
    if (cause instanceof WorkspaceSubjectError) throw cause;
    if (
      cause instanceof JobWorkspaceSubjectError ||
      isOwnerAuthorityDenial(cause)
    )
      throw new WorkspaceSubjectError(
        403,
        'Current workspace permission is required.',
      );
    throw cause;
  }
}
function ownership(subject: WorkspaceSubject): string[] {
  return [subject.tenantId, subject.userId, subject.profileId];
}
const where =
  'tenant_id = ? AND owner_user_id = ? AND candidate_profile_id = ? AND category = ?';
function rowRevision(row: Record<string, unknown>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: row.id,
        category: row.category,
        name: row.name,
        description: row.description,
        active: row.active,
        ruleJson: row.rule_json,
      }),
    )
    .digest('hex');
}
function encode(question: ScreeningQuestion): string {
  return JSON.stringify({ version: SCREENING_QUESTION_RULE_VERSION, question });
}
async function decode(
  row: Record<string, unknown>,
  subject: WorkspaceSubject,
): Promise<ScreeningQuestion> {
  if (
    row.tenant_id !== subject.tenantId ||
    row.owner_user_id !== subject.userId ||
    row.candidate_profile_id !== subject.profileId ||
    row.category !== SCREENING_QUESTION_RULE_CATEGORY ||
    typeof row.rule_json !== 'string'
  )
    throw invalid();
  try {
    const value = JSON.parse(row.rule_json);
    if (
      value.version !== SCREENING_QUESTION_RULE_VERSION ||
      !validateScreeningQuestion(value.question) ||
      value.question.id !== String(row.id)
    )
      throw invalid();
    const canonical = await canonicalQuestion(value.question);
    if (
      encode(canonical) !== row.rule_json ||
      row.name !== canonical.text ||
      row.description !== '' ||
      ![true, false, 0, 1].includes(row.active as boolean)
    )
      throw invalid();
    return await canonicalQuestion({
      ...canonical,
      active: canonical.active && (row.active === true || row.active === 1),
    });
  } catch {
    throw invalid();
  }
}
async function storedRows(
  db: Database,
  subject: WorkspaceSubject,
): Promise<Record<string, unknown>[]> {
  const found = await db.query(
    `SELECT id, tenant_id, owner_user_id, candidate_profile_id, category, name, description, active, rule_json FROM preference_rules WHERE ${where} ORDER BY id ASC`,
    [...ownership(subject), SCREENING_QUESTION_RULE_CATEGORY],
  );
  if (
    found.rows.some(
      (row) =>
        row.tenant_id !== subject.tenantId ||
        row.owner_user_id !== subject.userId ||
        row.candidate_profile_id !== subject.profileId ||
        row.category !== SCREENING_QUESTION_RULE_CATEGORY,
    ) ||
    new Set(found.rows.map((row) => row.id)).size !== found.rows.length
  )
    throw invalid();
  return found.rows;
}
async function snapshot(
  db: Database,
  subject: WorkspaceSubject,
): Promise<ScreeningQuestionSnapshot> {
  const questions: ScreeningQuestion[] = [];
  const invalidQuestions: ScreeningQuestionSnapshot['invalidQuestions'] = [];
  for (const row of await storedRows(db, subject)) {
    try {
      questions.push(await decode(row, subject));
    } catch {
      invalidQuestions.push({
        id: String(row.id),
        label:
          typeof row.name === 'string'
            ? row.name.slice(0, 200)
            : 'Invalid screening question',
        errorCode: 'invalid_question_rule',
        revision: rowRevision(row),
      });
    }
  }
  const errors: string[] = [];
  if (
    questions.length + invalidQuestions.length >
    SCREENING_QUESTION_MAX_STORED
  )
    errors.push(
      `Keep at most ${SCREENING_QUESTION_MAX_STORED} saved screening questions.`,
    );
  if (
    questions.filter((question) => question.active).length >
    SCREENING_QUESTION_MAX_ACTIVE
  )
    errors.push(
      `Enable at most ${SCREENING_QUESTION_MAX_ACTIVE} screening questions.`,
    );
  return {
    questions,
    // Over-limit material cannot authorize a cached result. Preserve every question for repair.
    questionSetFingerprint: errors.length
      ? ''
      : await screeningQuestionSetFingerprint(questions),
    invalidQuestions,
    errors,
  };
}
/** Defaults are suggestions, never persisted by this read. */
export async function listScreeningQuestions(
  subject: WorkspaceSubject,
  deps: ScreeningQuestionStoreDependencies = {},
): Promise<ScreeningQuestionSnapshot> {
  return await fresh(subject, deps, async (owned, db, profile) => ({
    ...(await snapshot(db, owned)),
    suggestions: screeningQuestionSuggestions(profile),
  }));
}
/** Read-only assessment seam uses its own native capability; it cannot edit preferences. */
export async function listAssessmentScreeningQuestions(
  subject: WorkspaceSubject,
  deps: ScreeningQuestionStoreDependencies = {},
): Promise<ScreeningQuestionSnapshot> {
  return await fresh(
    subject,
    deps,
    (owned, db) => snapshot(db, owned),
    'assessment.execute',
  );
}
async function makeQuestion(
  input: unknown,
  id: string,
): Promise<ScreeningQuestion> {
  try {
    if (!input || typeof input !== 'object') throw invalid();
    const value = input as Record<string, unknown>;
    if (
      typeof value.text !== 'string' ||
      !['source', 'fit'].includes(String(value.kind)) ||
      !['must_have', 'preference', 'informational'].includes(
        String(value.importance),
      ) ||
      !['yes', 'no'].includes(String(value.desiredAnswer)) ||
      typeof value.weight !== 'number' ||
      !Number.isInteger(value.weight) ||
      value.weight < 1 ||
      value.weight > 10 ||
      typeof value.active !== 'boolean'
    )
      throw invalid();
    return await canonicalQuestion({
      id,
      text: value.text,
      kind: value.kind as ScreeningQuestionInput['kind'],
      importance: value.importance as ScreeningQuestionInput['importance'],
      desiredAnswer:
        value.desiredAnswer as ScreeningQuestionInput['desiredAnswer'],
      weight: value.weight,
      active: value.active,
    });
  } catch {
    throw new ScreeningQuestionStoreError(
      'invalid_question',
      400,
      'Screening question fields are invalid.',
    );
  }
}
export async function createScreeningQuestion(
  subject: WorkspaceSubject,
  input: unknown,
  deps: ScreeningQuestionStoreDependencies = {},
): Promise<ScreeningQuestionSnapshot> {
  const question = await makeQuestion(input, randomUUID());
  return await fresh(subject, deps, async (owned, db) => {
    const changed = await db.query(
      `INSERT INTO preference_rules (id, slug, context, tenant_id, owner_user_id, candidate_profile_id, category, name, description, weight, is_hard_filter, rule_json, active) SELECT ?, ?, '', ?, ?, ?, ?, ?, '', 0, FALSE, ?, TRUE WHERE (SELECT COUNT(*) FROM preference_rules WHERE ${where}) < ? RETURNING id`,
      [
        question.id,
        `screening-question-${question.id}`,
        ...ownership(owned),
        SCREENING_QUESTION_RULE_CATEGORY,
        question.text,
        encode(question),
        ...ownership(owned),
        SCREENING_QUESTION_RULE_CATEGORY,
        SCREENING_QUESTION_MAX_STORED,
      ],
    );
    if (changed.rows.length !== 1)
      throw new ScreeningQuestionStoreError(
        'invalid_question',
        400,
        `Keep at most ${SCREENING_QUESTION_MAX_STORED} saved screening questions.`,
      );
    return await snapshot(db, owned);
  });
}
async function currentQuestion(
  db: Database,
  subject: WorkspaceSubject,
  id: string,
  expectedRevision: string,
) {
  const row = (await storedRows(db, subject)).find((row) => row.id === id);
  if (!row)
    throw new ScreeningQuestionStoreError(
      'not_found',
      404,
      'Screening question was not found in this workspace.',
    );
  let question: ScreeningQuestion | null = null;
  try {
    question = await decode(row, subject);
  } catch {
    /* Visible invalid rows can be explicitly repaired or deleted under their opaque CAS revision. */
  }
  if ((question?.revision ?? rowRevision(row)) !== expectedRevision)
    throw new ScreeningQuestionStoreError(
      'revision_conflict',
      409,
      'Screening question changed; reload before saving.',
    );
  return { row, question };
}
const currentRowWhere =
  'rule_json = ? AND name = ? AND description = ? AND active = ?';
function currentRowValues(row: Record<string, unknown>): unknown[] {
  return [row.rule_json, row.name, row.description, row.active];
}
export async function updateScreeningQuestion(
  subject: WorkspaceSubject,
  input: { id: string; expectedRevision: string; patch: unknown },
  deps: ScreeningQuestionStoreDependencies = {},
): Promise<ScreeningQuestionSnapshot> {
  return await fresh(subject, deps, async (owned, db) => {
    const current = await currentQuestion(
      db,
      owned,
      input.id,
      input.expectedRevision,
    );
    const patch =
      input.patch && typeof input.patch === 'object' ? input.patch : {};
    const next = await makeQuestion(
      { ...current.question, ...patch },
      input.id,
    );
    // Re-enter native authority immediately before the atomic revision/ownership write.
    return await fresh(owned, { ...deps, db }, async (writable, executor) => {
      const changed = await executor.query(
        `UPDATE preference_rules SET rule_json = ?, name = ?, description = '', active = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND ${where} AND ${currentRowWhere} RETURNING id`,
        [
          encode(next),
          next.text,
          input.id,
          ...ownership(writable),
          SCREENING_QUESTION_RULE_CATEGORY,
          ...currentRowValues(current.row),
        ],
      );
      if (changed.rows.length !== 1)
        throw new ScreeningQuestionStoreError(
          'revision_conflict',
          409,
          'Screening question changed; reload before saving.',
        );
      return await snapshot(executor, writable);
    });
  });
}
export async function deleteScreeningQuestion(
  subject: WorkspaceSubject,
  input: { id: string; expectedRevision: string },
  deps: ScreeningQuestionStoreDependencies = {},
): Promise<ScreeningQuestionSnapshot> {
  return await fresh(subject, deps, async (owned, db) => {
    const current = await currentQuestion(
      db,
      owned,
      input.id,
      input.expectedRevision,
    );
    return await fresh(owned, { ...deps, db }, async (writable, executor) => {
      const changed = await executor.query(
        `DELETE FROM preference_rules WHERE id = ? AND ${where} AND ${currentRowWhere} RETURNING id`,
        [
          input.id,
          ...ownership(writable),
          SCREENING_QUESTION_RULE_CATEGORY,
          ...currentRowValues(current.row),
        ],
      );
      if (changed.rows.length !== 1)
        throw new ScreeningQuestionStoreError(
          'revision_conflict',
          409,
          'Screening question changed; reload before deleting.',
        );
      return await snapshot(executor, writable);
    });
  });
}
