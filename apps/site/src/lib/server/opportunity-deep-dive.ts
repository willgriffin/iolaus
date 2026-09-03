import type { User } from '@happyvertical/smrt-users';
import { error } from '@sveltejs/kit';
import type { PostingPreflightStatus } from './posting-preflight-status.js';
import { getCollection } from './smrt.js';

/**
 * "Dig deeper" — the right-swipe of the one-at-a-time triage view (issue #425).
 *
 * Triage decides what deserves a *deeper look*, not what to apply to. The
 * verdict it records is therefore always `maybe`, through the same
 * `updateOpportunityReview()` writer the list and the record page use, and the
 * agentic follow-up is queued in the same request:
 *
 * 1. the opportunity intelligence job (idempotent — an active job for the same
 *    content fingerprint is reused, never duplicated),
 * 2. one bounded live-posting preflight, recorded as its own `AgentRun` —
 *    unless a recorded verdict for this opportunity is still fresh, in which
 *    case that verdict is reused and nothing is fetched,
 * 3. a `research_company` task for the opportunity's company, through
 *    `ensureCompanyResearch()` — the one helper that creates those tasks, keyed
 *    on `company-research:company:<id>` so an already-open task is reused.
 *
 * **The verdict is not contingent on the follow-up.** It is written first, and
 * each queue step is then run under its own guard: a step that throws is
 * reported as a failed step, never as a failed decision. An operator who swiped
 * right has decided; losing that because a queue was unreachable would silently
 * re-serve the card.
 */

/** The queue steps, in the order they run. */
export const DEEP_DIVE_STEPS = ['intelligence', 'verify', 'research'] as const;

export type DeepDiveStepName = (typeof DEEP_DIVE_STEPS)[number];

/**
 * `queued` — work was created or an equivalent one was already in flight.
 * `recent` — recorded work is fresh enough to reuse; nothing was run.
 * `skipped` — the step does not apply to this record (no company linked yet).
 * `error` — the step failed; the verdict still stands.
 */
export type DeepDiveStepStatus = 'queued' | 'recent' | 'skipped' | 'error';

/**
 * How long a recorded posting check stands in for a fresh one.
 *
 * The preflight is the only step that leaves this system on the request path:
 * it fetches the employer's posting. Keyboard triage can put several right
 * swipes per second through here, and a backlog is often several roles at one
 * employer, so an unthrottled check would hammer that host. A verdict this
 * young cannot have changed in a way a decision depends on, so it is reused —
 * the operator can always force a fresh one with the card's Verify action,
 * which is an explicit request and deliberately not throttled.
 */
export const DEEP_DIVE_PREFLIGHT_MAX_AGE_MS = 15 * 60 * 1000;

/** Milliseconds since a recorded check, or `null` when it is unusable. */
function preflightAgeMs(
  status: PostingPreflightStatus | null,
  now: number,
): number | null {
  if (!status || status.state === 'never_preflighted') return null;
  const checkedAt = status.checkedAt
    ? Date.parse(status.checkedAt)
    : Number.NaN;
  if (!Number.isFinite(checkedAt)) return null;
  const age = now - checkedAt;
  return age >= 0 ? age : 0;
}

export interface DeepDiveStep {
  message: string;
  name: DeepDiveStepName;
  status: DeepDiveStepStatus;
}

export interface DeepDiveResult {
  /** Steps that failed, for a caller that only wants the exceptions. */
  failed: DeepDiveStep[];
  humanReviewStatus: 'maybe';
  opportunityId: string;
  /** Verdict recorded by the posting check, when it ran. */
  preflight: PostingPreflightStatus | null;
  steps: DeepDiveStep[];
  title: string;
}

export interface DigDeeperOptions {
  /**
   * Review notes to record. Omit (not `''`) to keep the notes the opportunity
   * already carries — `updateOpportunityReview()` overwrites the column with
   * whatever is passed, so an absent field must not erase them.
   */
  humanReviewNotes?: string;
  /** Rating to record, or omit to keep the recorded one. */
  humanRating?: unknown;
  opportunityId: string;
  reviewedByProfileId?: string;
  user?: Pick<User, 'id'> | null;
}

type MutableRecord = Record<string, unknown> & { id?: string };

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  const body = (cause as { body?: { message?: unknown } } | null)?.body;
  const message = stringValue(body?.message);
  return message || 'Unknown error.';
}

/** Run one queue step so that its failure cannot unseat the recorded verdict. */
async function step(
  name: DeepDiveStepName,
  run: () => Promise<Omit<DeepDiveStep, 'name'>>,
): Promise<DeepDiveStep> {
  try {
    return { ...(await run()), name };
  } catch (cause) {
    return { message: messageOf(cause), name, status: 'error' };
  }
}

/**
 * Record the `maybe` verdict and queue the deep dive. Callers run this inside
 * the owner principal with `opportunityDigDeeperOperations` asserted; it does
 * no authorization of its own.
 */
export async function digDeeperOnOpportunity(
  options: DigDeeperOptions,
): Promise<DeepDiveResult> {
  const opportunityId = stringValue(options.opportunityId);
  if (!opportunityId) error(400, 'Opportunity id is required.');

  const collection = await getCollection('Opportunity');
  const opportunity = (await collection.get(
    opportunityId,
  )) as unknown as MutableRecord | null;
  if (!opportunity) error(404, 'Opportunity not found.');

  const companyId = stringValue(opportunity.companyId);
  const title = stringValue(opportunity.title);

  // The verdict first, and on its own: everything below is best-effort.
  const { updateOpportunityReview } = await import('./application-package.js');
  await updateOpportunityReview({
    humanRating:
      options.humanRating === undefined
        ? opportunity.humanRating
        : options.humanRating,
    humanReviewNotes:
      options.humanReviewNotes === undefined
        ? stringValue(opportunity.humanReviewNotes)
        : options.humanReviewNotes,
    humanReviewStatus: 'maybe',
    opportunityId,
    reviewedByProfileId: options.reviewedByProfileId,
    user: options.user,
  });

  let preflight: PostingPreflightStatus | null = null;

  const steps: DeepDiveStep[] = [];
  steps.push(
    await step('intelligence', async () => {
      const { enqueueOpportunityIntelligenceWithStatus } = await import(
        './opportunity-intelligence-job.js'
      );
      const result = await enqueueOpportunityIntelligenceWithStatus(
        opportunityId,
        { modes: 'all' },
        { reason: 'triage_dig_deeper', user: options.user },
      );
      return {
        message: result.enqueued
          ? `Opportunity intelligence queued as job ${result.job.id}.`
          : `Opportunity intelligence already queued as job ${result.job.id}.`,
        status: 'queued',
      };
    }),
  );

  steps.push(
    await step('verify', async () => {
      if (!options.user?.id) error(403, 'Forbidden');
      const { latestPostingPreflightStatus } = await import(
        './posting-preflight-status.js'
      );
      const recorded = await latestPostingPreflightStatus(opportunityId);
      const age = preflightAgeMs(recorded, Date.now());
      if (age !== null && age < DEEP_DIVE_PREFLIGHT_MAX_AGE_MS) {
        preflight = recorded;
        return {
          message: `Posting check reused: ${recorded.state.replaceAll('_', ' ')}, checked ${Math.max(1, Math.round(age / 60000))} min ago.`,
          status: 'recent',
        };
      }
      const { verifyJobPosting } = await import('./job-search-webmcp.js');
      const result = await verifyJobPosting({ opportunityId }, options.user);
      preflight = result.preflight;
      return {
        message: `Posting check recorded: ${result.preflight.state.replaceAll('_', ' ')}.`,
        status: 'queued',
      };
    }),
  );

  steps.push(
    await step('research', async () => {
      if (!companyId) {
        return {
          message:
            'No company is linked to this opportunity yet, so there is nothing to research.',
          status: 'skipped',
        };
      }
      const { ensureCompanyResearch } = await import(
        './application-workflow.js'
      );
      const result = await ensureCompanyResearch({
        companyId,
        createdBy: 'owner',
        opportunityId,
        reason: title
          ? `Triage marked "${title}" worth a deeper look.`
          : 'Triage marked this opportunity worth a deeper look.',
      });
      if (!result.researchTaskId) {
        return { message: 'Company not found.', status: 'error' };
      }
      return {
        message: result.careersSourceCreated
          ? 'Company research task ready; added the careers page as a source.'
          : 'Company research task ready.',
        status: 'queued',
      };
    }),
  );

  return {
    failed: steps.filter((entry) => entry.status === 'error'),
    humanReviewStatus: 'maybe',
    opportunityId,
    preflight,
    steps,
    title,
  };
}
