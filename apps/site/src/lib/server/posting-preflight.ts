import type { User } from '@happyvertical/smrt-users';
import { error } from '@sveltejs/kit';
import { recordAgentAudit } from './application-workflow.js';
import { extractAshbyQuestions } from './ats/ashby.js';
import { parseGreenhouseUrl } from './ats/greenhouse.js';
import { extractLeverQuestions } from './ats/lever.js';

export type PostingPreflightOutcome = 'closed' | 'inconclusive' | 'live';

export type PostingPreflightReason =
  | 'closed_page_marker'
  | 'closed_status'
  | 'fetch_error'
  | 'invalid_url'
  | 'missing_job_id'
  | 'redirected_to_different_posting'
  | 'unsafe_redirect'
  | 'unsupported_posting_host'
  | 'unavailable_status'
  | 'unverified_page'
  | 'verified_live';

/**
 * The archived-opportunity state: `stale` and `archived` are the existing
 * job-search lifecycle states for a posting that is no longer actionable.
 * `routeClosedPostingToExistingState()` applies exactly this triple (plus an
 * optional `archiveReason`), and so must every other automated archive — the
 * batched inactive-source sweep in `opportunity-sweep.ts` included. A spec
 * asserts the two stay identical, so no caller may invent a new state.
 */
export const ARCHIVED_OPPORTUNITY_STATE = {
  freshness: 'stale',
  humanReviewStatus: 'archived',
  status: 'archived',
} as const;

export interface PostingPreflightEvidence {
  checkedAt: string;
  evidenceExcerpt: string;
  finalUrl: string;
  provider: 'ashby' | 'greenhouse' | 'lever' | 'unknown';
  redirected: boolean;
  responseStatus: number | null;
}

export interface PostingPreflightResult {
  evidence: PostingPreflightEvidence;
  outcome: PostingPreflightOutcome;
  reason: PostingPreflightReason;
}

type MutableOpportunity = Record<string, unknown> & {
  save: () => Promise<void>;
};

export interface PostingPreflightOverride {
  /** The actor type is deliberately fixed; the authenticated user supplies identity. */
  actor: 'owner';
  reason: string;
}

export interface PostingPreflightGateResult extends PostingPreflightResult {
  overridden: boolean;
}

interface PostingIdentity {
  board: string;
  jobId: string;
  provider: PostingPreflightEvidence['provider'];
}

const CONCLUSIVE_CLOSED_PAGE_MARKERS = [
  'job not found',
  'job no longer exists',
  'job is no longer available',
  'this job has been closed',
  'this position has been filled',
  "we couldn't find the job",
  'page not found',
  'job has expired',
  'job is expired',
  'job is no longer available',
  'this job is unavailable',
];
const MAX_BODY_BYTES = 98_304;
const MAX_REDIRECTS = 3;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPT_TIMEOUT_MS = 15_000;
const GREENHOUSE_APPLICATION_FORM_RE =
  /<form\b[^>]*\bid=["']application-form["']/i;

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function attemptTimeoutMs(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return DEFAULT_ATTEMPT_TIMEOUT_MS;
  }
  return Math.min(Math.max(1, Math.floor(value)), MAX_ATTEMPT_TIMEOUT_MS);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          onTimeout?.();
          reject(new Error('Posting preflight attempt timed out.'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function urlValue(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password) {
      return null;
    }
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

function requestedPostingUrl(value: string): URL | null {
  const url = urlValue(value);
  if (!url) return null;

  if (postingIdentity(url)?.jobId) return url;

  const greenhouse = parseGreenhouseUrl(value);
  if (greenhouse) {
    return new URL(
      `https://job-boards.greenhouse.io/${encodeURIComponent(
        greenhouse.boardToken,
      )}/jobs/${encodeURIComponent(greenhouse.jobId)}`,
    );
  }

  return url;
}

function postingIdentity(value: URL): PostingIdentity | null {
  const host = value.hostname.toLowerCase();
  const segments = value.pathname.split('/').filter(Boolean);

  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
    const isHostedJobPath = segments.length === 3 && segments[1] === 'jobs';
    return {
      board: isHostedJobPath ? stringValue(segments[0]) : '',
      jobId: isHostedJobPath ? stringValue(segments[2]) : '',
      provider: 'greenhouse',
    };
  }

  if (host === 'jobs.ashbyhq.com') {
    return {
      board: stringValue(segments[0]),
      jobId: stringValue(segments[1]),
      provider: 'ashby',
    };
  }

  if (host === 'jobs.lever.co') {
    return {
      board: stringValue(segments[0]),
      jobId: stringValue(segments[1]),
      provider: 'lever',
    };
  }

  return null;
}

function hasLivePostingEvidence(
  body: string,
  identity: PostingIdentity,
): boolean {
  if (identity.provider === 'greenhouse') {
    return GREENHOUSE_APPLICATION_FORM_RE.test(body);
  }
  if (identity.provider === 'ashby') {
    return (
      hasAshbyJobPostingEvidence(body, identity.jobId) ||
      (extractAshbyQuestions(body)?.length ?? 0) > 0
    );
  }
  if (identity.provider === 'lever') {
    return (extractLeverQuestions(body)?.length ?? 0) > 0;
  }
  return false;
}

function hasAshbyJobPostingEvidence(body: string, jobId: string): boolean {
  const jsonLdScripts = body.matchAll(
    /<script\b[^>]*\btype=(?:"application\/ld\+json"|'application\/ld\+json')[^>]*>([\s\S]*?)<\/script>/gi,
  );

  for (const match of jsonLdScripts) {
    try {
      const parsed: unknown = JSON.parse(match[1]);
      const postings = Array.isArray(parsed) ? parsed : [parsed];
      if (
        postings.some((posting) => {
          if (!posting || typeof posting !== 'object') return false;
          const jobPosting = posting as Record<string, unknown>;
          const identifier = jobPosting.identifier;
          if (!identifier || typeof identifier !== 'object') return false;
          const value = (identifier as Record<string, unknown>).value;
          return (
            jobPosting['@type'] === 'JobPosting' &&
            jobPosting.directApply === true &&
            value === jobId
          );
        })
      ) {
        return true;
      }
    } catch {
      // Ignore malformed metadata and preserve the inconclusive outcome.
    }
  }
  return false;
}

function cancelResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

function remainingTimeoutMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error('Posting preflight deadline exceeded.');
  }
  return remaining;
}

async function boundedBody(
  response: Response,
  deadline: number,
): Promise<{ body: string; readable: boolean }> {
  if (!response.body) return { body: '', readable: false };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  try {
    while (byteCount < MAX_BODY_BYTES) {
      const next = await withTimeout(
        reader.read(),
        remainingTimeoutMs(deadline),
        () => {
          void reader.cancel().catch(() => undefined);
        },
      );
      if (next.done) break;
      const remaining = MAX_BODY_BYTES - byteCount;
      const chunk = next.value.slice(0, remaining);
      chunks.push(chunk);
      byteCount += chunk.byteLength;
      if (chunk.byteLength < next.value.byteLength) break;
    }
  } catch {
    return { body: '', readable: false };
  } finally {
    void reader.cancel().catch(() => undefined);
  }

  const bytes = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: new TextDecoder().decode(bytes), readable: true };
}

async function fetchKnownPosting(
  requestedUrl: URL,
  fetchImpl: typeof fetch,
  deadline: number,
): Promise<{
  finalUrl: URL;
  redirected: boolean;
  response: Response;
  unsafeRedirect: boolean;
} | null> {
  let currentUrl = requestedUrl;
  let redirected = false;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    let response: Response;
    try {
      const abortController = new AbortController();
      const timeoutMs = remainingTimeoutMs(deadline);
      response = await withTimeout(
        fetchImpl(currentUrl, {
          redirect: 'manual',
          signal: abortController.signal,
        }),
        timeoutMs,
        () => abortController.abort(),
      );
    } catch {
      return null;
    }
    if (response.status < 300 || response.status >= 400) {
      return {
        finalUrl: currentUrl,
        redirected,
        response,
        unsafeRedirect: false,
      };
    }

    const location = stringValue(response.headers?.get('location'));
    let nextUrl: URL | null = null;
    if (location) {
      try {
        nextUrl = urlValue(new URL(location, currentUrl).toString());
      } catch {
        nextUrl = null;
      }
    }
    if (!nextUrl || !postingIdentity(nextUrl)) {
      cancelResponseBody(response);
      return {
        finalUrl: currentUrl,
        redirected,
        response,
        unsafeRedirect: true,
      };
    }
    cancelResponseBody(response);
    currentUrl = nextUrl;
    redirected = true;
  }

  return null;
}

function evidence(
  checkedAt: string,
  url: URL | null,
  options: Partial<Omit<PostingPreflightEvidence, 'checkedAt' | 'provider'>> & {
    provider?: PostingPreflightEvidence['provider'];
  } = {},
): PostingPreflightEvidence {
  return {
    checkedAt,
    evidenceExcerpt: options.evidenceExcerpt ?? '',
    finalUrl: options.finalUrl ?? url?.toString() ?? '',
    provider: options.provider ?? 'unknown',
    redirected: options.redirected ?? false,
    responseStatus: options.responseStatus ?? null,
  };
}

/**
 * Fetch a canonical, known-ATS posting without credentials and classify only
 * conclusive failures as closed. Unknown providers and transport failures fail
 * safely as inconclusive so callers must not treat them as verified live.
 */
export async function preflightPosting(options: {
  checkedAt?: Date;
  fetchImpl?: typeof fetch;
  postingUrl: string;
  timeoutMs?: number;
}): Promise<PostingPreflightResult> {
  const checkedAt = (options.checkedAt ?? new Date()).toISOString();
  const timeoutMs = attemptTimeoutMs(options.timeoutMs);
  const deadline = Date.now() + timeoutMs;
  const requestedUrl = requestedPostingUrl(stringValue(options.postingUrl));
  if (!requestedUrl) {
    return {
      evidence: evidence(checkedAt, null),
      outcome: 'inconclusive',
      reason: 'invalid_url',
    };
  }

  const requestedIdentity = postingIdentity(requestedUrl);
  if (!requestedIdentity) {
    return {
      evidence: evidence(checkedAt, requestedUrl),
      outcome: 'inconclusive',
      reason: 'unsupported_posting_host',
    };
  }
  if (!requestedIdentity.jobId) {
    return {
      evidence: evidence(checkedAt, requestedUrl, {
        provider: requestedIdentity.provider,
      }),
      outcome: 'inconclusive',
      reason: 'missing_job_id',
    };
  }

  const fetched = await fetchKnownPosting(
    requestedUrl,
    options.fetchImpl ?? fetch,
    deadline,
  );
  if (!fetched) {
    return {
      evidence: evidence(checkedAt, requestedUrl, {
        provider: requestedIdentity.provider,
      }),
      outcome: 'inconclusive',
      reason: 'fetch_error',
    };
  }

  const finalIdentity = postingIdentity(fetched.finalUrl);
  const responseEvidence = evidence(checkedAt, requestedUrl, {
    finalUrl: fetched.finalUrl.toString(),
    provider: requestedIdentity.provider,
    redirected: fetched.redirected,
    responseStatus: fetched.response.status,
  });

  if (fetched.unsafeRedirect) {
    cancelResponseBody(fetched.response);
    return {
      evidence: responseEvidence,
      outcome: 'inconclusive',
      reason: 'unsafe_redirect',
    };
  }
  if (!finalIdentity?.jobId) {
    cancelResponseBody(fetched.response);
    return {
      evidence: responseEvidence,
      outcome: 'closed',
      reason: 'redirected_to_different_posting',
    };
  }
  if (
    finalIdentity.provider !== requestedIdentity.provider ||
    finalIdentity.board !== requestedIdentity.board ||
    finalIdentity.jobId !== requestedIdentity.jobId
  ) {
    cancelResponseBody(fetched.response);
    return {
      evidence: responseEvidence,
      outcome: 'inconclusive',
      reason: 'redirected_to_different_posting',
    };
  }
  if (fetched.response.status === 404 || fetched.response.status === 410) {
    cancelResponseBody(fetched.response);
    return {
      evidence: responseEvidence,
      outcome: 'closed',
      reason: 'closed_status',
    };
  }
  if (!fetched.response.ok) {
    cancelResponseBody(fetched.response);
    return {
      evidence: responseEvidence,
      outcome: 'inconclusive',
      reason: 'unavailable_status',
    };
  }
  const bodyResult = await boundedBody(fetched.response, deadline);
  if (!bodyResult.readable) {
    return {
      evidence: responseEvidence,
      outcome: 'inconclusive',
      reason: 'fetch_error',
    };
  }
  const normalizedBody = bodyResult.body.toLowerCase();
  if (
    CONCLUSIVE_CLOSED_PAGE_MARKERS.some((marker) =>
      normalizedBody.includes(marker),
    )
  ) {
    responseEvidence.evidenceExcerpt = 'Closed-page marker detected.';
    return {
      evidence: responseEvidence,
      outcome: 'closed',
      reason: 'closed_page_marker',
    };
  }
  if (hasLivePostingEvidence(bodyResult.body, finalIdentity)) {
    return {
      evidence: responseEvidence,
      outcome: 'live',
      reason: 'verified_live',
    };
  }
  return {
    evidence: responseEvidence,
    outcome: 'inconclusive',
    reason: 'unverified_page',
  };
}

/** Persist bounded, non-secret preflight evidence using the existing AgentRun audit. */
export async function recordPostingPreflight(options: {
  checkedAt?: Date;
  fetchImpl?: typeof fetch;
  opportunity: Record<string, unknown>;
  postingUrl?: string;
  user?: Pick<User, 'id'> | null;
}) {
  const postingUrls = [
    stringValue(options.postingUrl),
    stringValue(options.opportunity.canonicalUrl),
    stringValue(options.opportunity.applyUrl),
    stringValue(options.opportunity.postingUrl),
  ];
  const postingUrl =
    postingUrls.find((candidate) => {
      const url = requestedPostingUrl(candidate);
      return Boolean(url && postingIdentity(url)?.jobId);
    }) ??
    postingUrls.find(Boolean) ??
    '';
  const auditedPostingUrl = requestedPostingUrl(postingUrl)?.toString() ?? '';
  const result = await preflightPosting({
    checkedAt: options.checkedAt,
    fetchImpl: options.fetchImpl,
    postingUrl,
  });
  const agentRun = await recordAgentAudit({
    error: result.outcome === 'inconclusive' ? result.reason : '',
    input: { action: 'posting_preflight', postingUrl: auditedPostingUrl },
    opportunity: options.opportunity,
    output: {
      evidence: result.evidence,
      outcome: result.outcome,
      reason: result.reason,
    },
    runType: 'posting_preflight',
    status: result.outcome === 'inconclusive' ? 'failed' : 'completed',
    user: options.user,
  });

  return { agentRun, ...result };
}

function boundedOverride(reason: unknown): PostingPreflightOverride | null {
  const text = stringValue(reason);
  if (!text) return null;
  if (text.length > 2_000) {
    error(
      400,
      'Posting preflight override reason must be 2000 characters or fewer.',
    );
  }
  return { actor: 'owner', reason: text };
}

export type OpportunityArchiveReason = 'not_listed' | 'source_inactive';

export async function routeClosedPostingToExistingState(
  opportunity: MutableOpportunity,
  options: { archiveReason?: OpportunityArchiveReason } = {},
) {
  // `stale` and `archived` are the existing job-search lifecycle states for a
  // posting that is no longer actionable. Keep the bounded preflight evidence
  // in AgentRun rather than overwriting the user’s review notes.
  Object.assign(opportunity, {
    freshness: 'stale',
    humanReviewStatus: 'archived',
    status: 'archived',
    ...(options.archiveReason ? { archiveReason: options.archiveReason } : {}),
  });
  await opportunity.save();
}

/**
 * Runs M2a immediately before a local application-work transition. It never
 * reuses an old AgentRun, so every permitted transition has fresh evidence.
 *
 * A live result is allowed. A conclusively closed posting is moved into the
 * existing stale/archived state. An inconclusive result requires a reason from
 * the authenticated owner; that exception is recorded as a distinct audit and
 * can never be mistaken for verified-live evidence.
 */
export async function requireFreshPostingPreflight(options: {
  action: 'accept_opportunity' | 'create_application_draft' | 'generate_packet';
  /**
   * Lifecycle callers use this to commit the closed/inconclusive audit and
   * state transition before returning the corresponding HTTP failure.
   */
  deferFailure?: boolean;
  fetchImpl?: typeof fetch;
  /**
   * Performs the closed-posting state transition and related local cleanup as
   * one caller-owned transaction. This is used when the lifecycle session lock
   * is held; standalone callers can continue to use `onClosed`.
   */
  onClosedAtomically?: () => Promise<void>;
  onClosed?: () => Promise<void>;
  opportunity: MutableOpportunity;
  overrideReason?: unknown;
  user?: Pick<User, 'id'> | null;
}): Promise<PostingPreflightGateResult> {
  const result = await recordPostingPreflight({
    fetchImpl: options.fetchImpl,
    opportunity: options.opportunity,
    user: options.user,
  });

  if (result.outcome === 'live') {
    return { ...result, overridden: false };
  }

  if (result.outcome === 'closed') {
    if (options.onClosedAtomically) {
      await options.onClosedAtomically();
    } else {
      await routeClosedPostingToExistingState(options.opportunity);
      await options.onClosed?.();
    }
    if (!options.deferFailure) {
      error(
        409,
        'This posting is closed and has been archived. Application work cannot continue.',
      );
    }
    return { ...result, overridden: false };
  }

  const override = boundedOverride(options.overrideReason);
  if (!override || !stringValue(options.user?.id)) {
    if (!options.deferFailure) {
      error(
        409,
        'The posting could not be verified as live. An authenticated owner must enter a reason to override this check.',
      );
    }
    return { ...result, overridden: false };
  }

  await recordAgentAudit({
    input: {
      action: 'override_posting_preflight',
      actor: override.actor,
      overrideReason: override.reason,
      preflightReason: result.reason,
      workflowAction: options.action,
    },
    opportunity: options.opportunity,
    output: {
      outcome: result.outcome,
      overridden: true,
      reason: result.reason,
      verifiedLive: false,
    },
    runType: 'posting_preflight_override',
    status: 'completed',
    user: options.user,
  });

  return { ...result, overridden: true };
}
