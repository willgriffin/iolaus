export const SCREENING_QUESTION_MAX_ACTIVE = 20;
export interface ScreeningQuestionInput {
  text: string;
  kind: 'source' | 'fit';
  importance: 'must_have' | 'preference' | 'informational';
  desiredAnswer: 'yes' | 'no';
  weight: number;
  active: boolean;
}
export interface ScreeningQuestion extends ScreeningQuestionInput {
  id: string;
  revision: string;
}
export interface ScreeningQuestionAnswer {
  questionId: string;
  questionRevision: string;
  answer: 'yes' | 'no' | 'partial' | 'unknown';
  /** Alignment with the desired answer, not probability or a hiring prediction. */
  alignment: 0 | 1 | 2 | 3 | 4 | null;
  confidence: number;
  /** Evidence selection certainty, separate from semantic rubric confidence. */
  attributionConfidence?: number;
  sourceCitations: Array<{
    id: string;
    text: string;
    start: number;
    end: number;
    sourceFieldPath?: string;
  }>;
  candidateCitations: Array<{
    id: string;
    title: string;
    kind: string;
    text: string;
  }>;
  uncertainty?: string;
}
export interface ScreeningSkillMatch {
  meaning?: 'named_capability';
  requirement: string;
  sourceField: 'requiredSkills' | 'preferredSkills';
  sourceOrigin?: 'captured_field' | 'body_literal';
  status: 'supported' | 'partial' | 'unknown';
  assessed: boolean;
  confidence: number;
  /** Evidence selection certainty, separate from semantic rubric confidence. */
  attributionConfidence?: number;
  sourceCitation: ScreeningQuestionAnswer['sourceCitations'][number];
  candidateCitations: ScreeningQuestionAnswer['candidateCitations'];
}
export interface ScreeningQuestionAggregate {
  recommendationPercent: number | null;
  evidenceCoveragePercent: number | null;
  totalScoringWeight: number;
  ratedScoringWeight: number;
  attributedScoringWeight: number;
  mustHaveConflictIds: string[];
  unknownQuestionIds: string[];
  partialQuestionIds: string[];
  unresolvedMustHaveIds: string[];
}
function hasDisallowedTextControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return (
      (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0x7f
    );
  });
}
function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}
function validateInput(input: ScreeningQuestionInput): ScreeningQuestionInput {
  if (
    !input ||
    typeof input.text !== 'string' ||
    !input.text.trim() ||
    input.text.length > 2000 ||
    hasDisallowedTextControlCharacter(input.text) ||
    !['source', 'fit'].includes(input.kind) ||
    !['must_have', 'preference', 'informational'].includes(input.importance) ||
    !['yes', 'no'].includes(input.desiredAnswer) ||
    !Number.isInteger(input.weight) ||
    input.weight < 1 ||
    input.weight > 10 ||
    typeof input.active !== 'boolean'
  )
    throw new Error('Invalid screening question.');
  return {
    text: input.text,
    kind: input.kind,
    importance: input.importance,
    desiredAnswer: input.desiredAnswer,
    weight: input.weight,
    active: input.active,
  };
}
export function screeningQuestionCanonicalContent(
  input: ScreeningQuestionInput,
): string {
  return JSON.stringify(validateInput(input));
}
async function sha256(text: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
export function screeningQuestionRevision(
  input: ScreeningQuestionInput,
): Promise<string> {
  return sha256(screeningQuestionCanonicalContent(input));
}
export function validateScreeningQuestion(
  question: ScreeningQuestion,
): ScreeningQuestion {
  validateInput(question);
  if (
    typeof question.id !== 'string' ||
    !question.id.trim() ||
    question.id !== question.id.trim() ||
    question.id.length > 200 ||
    hasControlCharacter(question.id) ||
    typeof question.revision !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(question.revision)
  )
    throw new Error('Invalid screening question identity or revision.');
  return {
    id: question.id,
    ...validateInput(question),
    revision: question.revision,
  };
}
export async function createScreeningQuestion(
  input: ScreeningQuestionInput & { id: string },
): Promise<ScreeningQuestion> {
  return validateScreeningQuestion({
    ...input,
    revision: await screeningQuestionRevision(input),
  });
}
export function screeningQuestionSetMaterial(
  questions: ScreeningQuestion[],
): string {
  const canonical = questions
    .map(validateScreeningQuestion)
    .sort((left, right) => left.id.localeCompare(right.id, 'en'));
  if (
    new Set(canonical.map((question) => question.id)).size !== canonical.length
  )
    throw new Error('Duplicate screening question identities.');
  if (
    canonical.filter((question) => question.active).length >
    SCREENING_QUESTION_MAX_ACTIVE
  )
    throw new Error('Too many active screening questions.');
  return JSON.stringify(canonical);
}
export async function screeningQuestionSetFingerprint(
  questions: ScreeningQuestion[],
): Promise<string> {
  for (const question of questions)
    if (question.revision !== (await screeningQuestionRevision(question)))
      throw new Error('Screening question revision is stale.');
  return sha256(screeningQuestionSetMaterial(questions));
}
export function aggregateScreeningQuestionAnswers(
  questions: ScreeningQuestion[],
  answers: ScreeningQuestionAnswer[],
): ScreeningQuestionAggregate {
  screeningQuestionSetMaterial(questions);
  const enabled = questions.filter((question) => question.active);
  if (
    answers.length !== enabled.length ||
    new Set(answers.map((answer) => answer.questionId)).size !== answers.length
  )
    throw new Error('Answers must cover exactly the active question set.');
  let totalScoringWeight = 0,
    ratedScoringWeight = 0,
    attributedScoringWeight = 0,
    earned = 0;
  const mustHaveConflictIds: string[] = [],
    unknownQuestionIds: string[] = [],
    partialQuestionIds: string[] = [],
    unresolvedMustHaveIds: string[] = [];
  for (const question of enabled) {
    const answer = answers.find((item) => item.questionId === question.id);
    if (
      !answer ||
      answer.questionRevision !== question.revision ||
      !['yes', 'no', 'partial', 'unknown'].includes(answer.answer) ||
      (question.kind === 'source' && answer.answer === 'partial') ||
      !Number.isFinite(answer.confidence) ||
      answer.confidence < 0 ||
      answer.confidence > 1 ||
      !Array.isArray(answer.sourceCitations) ||
      !Array.isArray(answer.candidateCitations) ||
      (answer.answer === 'unknown'
        ? answer.alignment !== null
        : !Number.isInteger(answer.alignment) ||
          answer.alignment === null ||
          answer.alignment < 0 ||
          answer.alignment > 4)
    )
      throw new Error('Invalid or stale screening answer.');
    if (answer.answer === 'unknown') unknownQuestionIds.push(question.id);
    if (answer.answer === 'partial') partialQuestionIds.push(question.id);
    if (
      question.importance === 'must_have' &&
      (answer.answer === 'unknown' ||
        answer.answer === 'partial' ||
        answer.confidence < 0.85)
    )
      unresolvedMustHaveIds.push(question.id);
    if (
      answer.answer !== 'unknown' &&
      (!answer.sourceCitations.length ||
        (question.kind === 'fit' && !answer.candidateCitations.length) ||
        (answer.answer === 'partial'
          ? answer.alignment === null ||
            answer.alignment < 1 ||
            answer.alignment > 3
          : answer.alignment !==
            (answer.answer === question.desiredAnswer ? 4 : 0)))
    )
      throw new Error(
        'Screening ratings require attributed evidence and consistent polarity.',
      );
    if (
      question.importance === 'must_have' &&
      (answer.answer === 'yes' || answer.answer === 'no') &&
      answer.answer !== question.desiredAnswer &&
      answer.confidence >= 0.85 &&
      answer.sourceCitations.length
    )
      mustHaveConflictIds.push(question.id);
    if (question.importance === 'informational') continue;
    totalScoringWeight += question.weight;
    if (answer.alignment !== null) {
      ratedScoringWeight += question.weight;
      earned += (question.weight * answer.alignment) / 4;
      if (
        answer.sourceCitations.length &&
        (question.kind === 'source' || answer.candidateCitations.length)
      )
        attributedScoringWeight += question.weight;
    }
  }
  return {
    recommendationPercent:
      totalScoringWeight && ratedScoringWeight
        ? (100 * earned) / totalScoringWeight
        : null,
    evidenceCoveragePercent: totalScoringWeight
      ? (100 * attributedScoringWeight) / totalScoringWeight
      : null,
    totalScoringWeight,
    ratedScoringWeight,
    attributedScoringWeight,
    mustHaveConflictIds,
    unknownQuestionIds,
    partialQuestionIds,
    unresolvedMustHaveIds,
  };
}

/** Suggestions are unsaved preferences from explicit typed profile fields only. */
export function screeningQuestionSuggestions(
  profile: Record<string, unknown>,
): ScreeningQuestionInput[] {
  const suggestions: ScreeningQuestionInput[] = [];
  const add = (text: string, kind: 'source' | 'fit') =>
    suggestions.push({
      text,
      kind,
      importance: 'preference',
      desiredAnswer: 'yes',
      weight: 1,
      active: true,
    });
  const parsed = (value: unknown): Record<string, unknown> | null => {
    try {
      const object: unknown =
        typeof value === 'string' ? JSON.parse(value) : value;
      return object && typeof object === 'object' && !Array.isArray(object)
        ? (object as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  const preferences = parsed(profile.preferencesJson);
  for (const role of Array.isArray(preferences?.targetRoles)
    ? preferences.targetRoles
    : [])
    if (typeof role === 'string' && role.trim())
      add(
        `Do the actual duties belong to the target role ${JSON.stringify(role)}?`,
        'fit',
      );
  for (const mode of Array.isArray(preferences?.workModes)
    ? preferences.workModes
    : [])
    if (typeof mode === 'string' && mode.trim())
      add(
        `Does the posting explicitly offer the work arrangement ${JSON.stringify(mode)}?`,
        'source',
      );
  const target = parsed(profile.targetWorkCountryJson);
  if (
    target &&
    typeof target.code === 'string' &&
    /^[A-Z]{2}$/u.test(target.code)
  )
    add(
      `Does the posting explicitly allow working from ${JSON.stringify(typeof target.label === 'string' && target.label.trim() ? target.label : target.code)}?`,
      'source',
    );
  return suggestions.filter((question) => question.text.length <= 2000);
}
