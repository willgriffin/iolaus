import {
  aggregateScreeningQuestionAnswers,
  type ScreeningQuestion,
  type ScreeningQuestionAggregate,
  type ScreeningQuestionAnswer,
  type ScreeningSkillMatch,
  validateScreeningQuestion,
} from './opportunity-screening-questions';
export interface QuestionScreeningProjection {
  skillMatches?: ScreeningSkillMatch[];
  rolePreScreen?: {
    title: string;
    targetRoles: string[];
    outcome: 'unrelated' | 'continue';
    confidence: number;
  };
  version: 'opportunity-question-screening-projection/v1';
  sourceStatus: 'current';
  model: 'jev-1.13.0';
  questions: ScreeningQuestion[];
  answers: ScreeningQuestionAnswer[];
  aggregate: ScreeningQuestionAggregate;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
/** Consistency only. The server's current native receipt reader establishes authority. */
export function getCurrentQuestionScreeningProjection(
  value: unknown,
  status?: unknown,
): QuestionScreeningProjection | null {
  if (
    status === 'unknown' ||
    !object(value) ||
    value.version !== 'opportunity-question-screening-projection/v1' ||
    value.sourceStatus !== 'current' ||
    value.model !== 'jev-1.13.0' ||
    !Array.isArray(value.questions) ||
    !Array.isArray(value.answers) ||
    !object(value.aggregate)
  )
    return null;
  try {
    const role = value.rolePreScreen;
    if (
      role !== undefined &&
      (!object(role) ||
        typeof role.title !== 'string' ||
        !Array.isArray(role.targetRoles) ||
        !role.targetRoles.length ||
        !role.targetRoles.every((item) => typeof item === 'string' && !!item) ||
        !['unrelated', 'continue'].includes(String(role.outcome)) ||
        typeof role.confidence !== 'number' ||
        !Number.isFinite(role.confidence) ||
        role.confidence < 0 ||
        role.confidence > 1 ||
        value.answers.length !== 0 ||
        (role.outcome === 'unrelated' && role.confidence < 0.95))
    )
      return null;
    const questions = value.questions.map(validateScreeningQuestion);
    const answers = value.answers;
    if (
      !answers.every(
        (answer) =>
          object(answer) &&
          (answer.attributionConfidence === undefined ||
            (typeof answer.attributionConfidence === 'number' &&
              Number.isFinite(answer.attributionConfidence) &&
              answer.attributionConfidence >= 0 &&
              answer.attributionConfidence <= 1)) &&
          Array.isArray(answer.sourceCitations) &&
          Array.isArray(answer.candidateCitations) &&
          answer.sourceCitations.every(
            (citation) =>
              object(citation) &&
              typeof citation.id === 'string' &&
              !!citation.id &&
              typeof citation.text === 'string' &&
              !!citation.text &&
              Number.isSafeInteger(citation.start) &&
              Number.isSafeInteger(citation.end) &&
              Number(citation.start) >= 0 &&
              Number(citation.end) - Number(citation.start) ===
                citation.text.length,
          ) &&
          answer.candidateCitations.every(
            (citation) =>
              object(citation) &&
              typeof citation.id === 'string' &&
              !!citation.id &&
              typeof citation.title === 'string' &&
              typeof citation.kind === 'string' &&
              typeof citation.text === 'string' &&
              !!citation.text,
          ) &&
          (answer.uncertainty === undefined ||
            typeof answer.uncertainty === 'string'),
      )
    )
      return null;
    if (
      value.skillMatches !== undefined &&
      (!Array.isArray(value.skillMatches) ||
        !value.skillMatches.every(
          (match) =>
            object(match) &&
            typeof match.requirement === 'string' &&
            !!match.requirement.trim() &&
            ['requiredSkills', 'preferredSkills'].includes(
              String(match.sourceField),
            ) &&
            (match.sourceOrigin === undefined ||
              ['captured_field', 'body_literal'].includes(
                String(match.sourceOrigin),
              )) &&
            ['supported', 'partial', 'unknown'].includes(
              String(match.status),
            ) &&
            (match.attributionConfidence === undefined ||
              (typeof match.attributionConfidence === 'number' &&
                Number.isFinite(match.attributionConfidence) &&
                match.attributionConfidence >= 0 &&
                match.attributionConfidence <= 1)) &&
            (match.meaning === undefined ||
              match.meaning === 'named_capability') &&
            typeof match.assessed === 'boolean' &&
            typeof match.confidence === 'number' &&
            Number.isFinite(match.confidence) &&
            match.confidence >= 0 &&
            match.confidence <= 1 &&
            object(match.sourceCitation) &&
            typeof match.sourceCitation.id === 'string' &&
            typeof match.sourceCitation.text === 'string' &&
            !!match.sourceCitation.text &&
            Number.isSafeInteger(match.sourceCitation.start) &&
            Number.isSafeInteger(match.sourceCitation.end) &&
            Number(match.sourceCitation.end) -
              Number(match.sourceCitation.start) ===
              match.sourceCitation.text.length &&
            Number(match.sourceCitation.start) >= 0 &&
            Array.isArray(match.candidateCitations) &&
            match.candidateCitations.every(
              (cite) =>
                object(cite) &&
                typeof cite.id === 'string' &&
                !!cite.id &&
                typeof cite.title === 'string' &&
                typeof cite.kind === 'string' &&
                typeof cite.text === 'string' &&
                !!cite.text,
            ) &&
            (match.status === 'unknown' ||
              (match.assessed &&
                match.confidence >= 0.85 &&
                match.candidateCitations.length > 0)) &&
            (match.assessed ||
              (match.status === 'unknown' &&
                match.candidateCitations.length === 0)),
        ))
    )
      return null;
    const aggregate = aggregateScreeningQuestionAnswers(
      role ? [] : questions,
      answers,
    );
    if (JSON.stringify(aggregate) !== JSON.stringify(value.aggregate))
      return null;
    return value as unknown as QuestionScreeningProjection;
  } catch {
    return null;
  }
}
export function questionScreeningLabel(
  value: QuestionScreeningProjection,
): string {
  if (value.rolePreScreen)
    return value.rolePreScreen.outcome === 'unrelated'
      ? 'Title outside target roles'
      : 'Title pre-screen only';
  return value.aggregate.recommendationPercent === null
    ? 'Recommendation unknown'
    : `Recommendation ${value.aggregate.recommendationPercent.toFixed(1)}%`;
}

export function currentQuestionScreeningRank(record: Record<string, unknown>): {
  enabled: boolean;
  conflictCount: number;
  recommendationPercent: number | null;
  evidenceCoveragePercent: number | null;
} {
  const current = getCurrentQuestionScreeningProjection(
    record.questionScreeningProjection,
    record.questionScreeningStatus,
  );
  return {
    enabled:
      typeof record.questionScreeningEnabled === 'boolean'
        ? record.questionScreeningEnabled
        : record.questionScreeningStatus === 'unknown' ||
          record.questionScreeningProjection != null,
    conflictCount: current?.aggregate.mustHaveConflictIds.length ?? 0,
    recommendationPercent: current?.aggregate.recommendationPercent ?? null,
    evidenceCoveragePercent: current?.aggregate.evidenceCoveragePercent ?? null,
  };
}
