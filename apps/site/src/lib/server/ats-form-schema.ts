// Fetch and persist the ATS application form schema during packet generation,
// so the list of required questions (and therefore any missing answers) is
// known during review — not discovered at submit time. Best-effort: a failure
// here never blocks packet generation. See docs/auto-submit-design.md.

import { isIndeedUrl, resolveIndeedApplyUrl } from './ats/indeed.js';
import { getAtsSubmitter } from './ats/index.js';
import type { FetchLike } from './ats/types.js';

export interface PersistApplicationFormSchemaOptions {
  detect?: (url: string) => Promise<{ type?: unknown } | null>;
  fetchImpl?: FetchLike;
  /** Injectable Indeed→ATS resolver; defaults to the real network resolver. */
  resolveAggregator?: (url: string) => Promise<string | null>;
}

export interface PersistApplicationFormSchemaResult {
  persisted: boolean;
  ats: string;
  questionCount: number;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function defaultDetect(url: string): Promise<{ type?: unknown } | null> {
  const { detectJobBoard } = await import('./opportunity-source-crawler.js');
  return await detectJobBoard(url);
}

/**
 * Resolve the application form schema and write it onto
 * `application.requiredQuestionsJson`. Mutates but does NOT save — the caller
 * persists. Returns a summary; on any miss it leaves the field untouched.
 */
export async function persistApplicationFormSchema(
  application: Record<string, unknown>,
  options: PersistApplicationFormSchemaOptions = {},
): Promise<PersistApplicationFormSchemaResult> {
  const miss: PersistApplicationFormSchemaResult = {
    persisted: false,
    ats: '',
    questionCount: 0,
  };

  // Always drop any prior resolved URL up front; only a fresh successful
  // resolution below re-sets it. Otherwise a stale value — from a previous
  // posting, an edit to a non-aggregator URL, a cleared apply URL, or a
  // transient resolver failure — would shadow the current state via
  // effectiveApplyUrl() and drive eligibility/submit toward the wrong job.
  // Cleared before the no-URL early return for exactly that last case.
  if (stringValue(application.resolvedApplyUrl))
    application.resolvedApplyUrl = '';

  const rawApplyUrl =
    stringValue(application.applicationUrl) ||
    stringValue(application.applyUrl);
  if (!rawApplyUrl) return miss;

  // Aggregators (Indeed) don't expose a submittable form themselves, but often
  // redirect to a real ATS. Resolve that canonical URL once here and persist it
  // so the rest of the auto-submit flow (eligibility, submit) acts on the ATS,
  // not the aggregator. Best-effort: a miss leaves the raw URL in play (manual).
  let applyUrl = rawApplyUrl;
  if (isIndeedUrl(rawApplyUrl)) {
    const resolveAggregator =
      options.resolveAggregator ??
      ((url: string) =>
        resolveIndeedApplyUrl({ url, fetchImpl: options.fetchImpl }));
    const resolved = await resolveAggregator(rawApplyUrl).catch(() => null);
    if (resolved) {
      application.resolvedApplyUrl = resolved;
      applyUrl = resolved;
    }
  }

  const detect = options.detect ?? defaultDetect;
  const detection = await detect(applyUrl).catch(() => null);
  const detectionType = stringValue(detection?.type);
  const submitter = getAtsSubmitter(detectionType);
  if (!submitter) return miss;

  const schema = await submitter
    .fetchFormSchema({ applyUrl, fetchImpl: options.fetchImpl })
    .catch(() => null);
  if (!schema) return miss;

  application.requiredQuestionsJson = JSON.stringify(schema);
  return {
    persisted: true,
    ats: submitter.ats,
    questionCount: schema.questions.length,
  };
}
