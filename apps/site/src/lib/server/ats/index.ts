// ATS submitter registry. Greenhouse, Ashby, and Lever are certified-for-dry-run
// adapters today; other ATSes are deliberate follow-ups (see
// docs/auto-submit-design.md).

import { ashbySubmitter } from './ashby.js';
import { greenhouseSubmitter } from './greenhouse.js';
import { leverSubmitter } from './lever.js';
import type { AtsFormSchema, AtsSubmitter } from './types.js';

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isAtsFormQuestion(
  value: unknown,
): value is AtsFormSchema['questions'][number] {
  if (!value || typeof value !== 'object') return false;
  const question = value as Record<string, unknown>;
  return (
    nonEmptyString(question.id) &&
    typeof question.label === 'string' &&
    typeof question.required === 'boolean' &&
    typeof question.type === 'string'
  );
}

/**
 * Strictly parse a persisted ATS form schema. Requires the identity fields
 * (`ats`, `boardToken`, `jobId`) and a `questions` array — a schema missing any
 * of these is treated as absent, so a stale or malformed schema can never build
 * a payload for the wrong (or undefined) job.
 */
export function parseAtsFormSchema(value: unknown): AtsFormSchema | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AtsFormSchema>;
    if (
      !parsed ||
      !nonEmptyString(parsed.ats) ||
      !nonEmptyString(parsed.boardToken) ||
      !nonEmptyString(parsed.jobId) ||
      !Array.isArray(parsed.questions)
    ) {
      return null;
    }
    if (!parsed.questions.every((question) => isAtsFormQuestion(question))) {
      return null;
    }
    return parsed as AtsFormSchema;
  } catch {
    return null;
  }
}

const SUBMITTERS: readonly AtsSubmitter[] = [
  greenhouseSubmitter,
  ashbySubmitter,
  leverSubmitter,
];

/**
 * Resolve the submitter for a `detectJobBoard()` detection type, or null when
 * the ATS is unsupported. Conservative by design: an unknown type returns null
 * so the caller falls back rather than guesses.
 */
export function getAtsSubmitter(detectionType: unknown): AtsSubmitter | null {
  const type = typeof detectionType === 'string' ? detectionType.trim() : '';
  if (!type) return null;
  return SUBMITTERS.find((submitter) => submitter.supports(type)) ?? null;
}

export function isSupportedAtsForAutoSubmit(detectionType: unknown): boolean {
  return getAtsSubmitter(detectionType) !== null;
}

/**
 * True when `type` denotes a file question (e.g. the resume upload) for the
 * given ATS. Dispatches to the owning adapter so callers don't hardcode one
 * ATS's file-type token across every schema. Unknown ATS → false (conservative:
 * a scalar question is never wrongly dropped from the answers check).
 */
export function isAtsFileQuestion(ats: unknown, type: unknown): boolean {
  const submitter = getAtsSubmitter(ats);
  return submitter ? submitter.isFileQuestion(String(type ?? '')) : false;
}

export const supportedAutoSubmitAtsTypes: readonly string[] = SUBMITTERS.map(
  (submitter) => submitter.ats,
);

export {
  ashbySubmitter,
  extractAshbyQuestions,
  isAshbyFileQuestion,
  parseAshbyUrl,
} from './ashby.js';
export {
  greenhouseSubmitter,
  isGreenhouseFileQuestion,
  parseGreenhouseUrl,
} from './greenhouse.js';
export {
  extractLeverQuestions,
  isLeverFileQuestion,
  leverSubmitter,
  parseLeverUrl,
} from './lever.js';
export type { AtsSubmitter } from './types.js';
