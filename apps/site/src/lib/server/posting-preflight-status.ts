import { getCollection } from './smrt.js';

/**
 * Agent-visible posting preflight state. `never_preflighted` means no
 * `posting_preflight` audit exists for the opportunity; the other three mirror
 * the recorded `PostingPreflightOutcome` of the most recent check.
 */
export type PostingPreflightState =
  | 'never_preflighted'
  | 'live'
  | 'closed'
  | 'inconclusive';

export interface PostingPreflightStatus {
  state: PostingPreflightState;
  /** ISO timestamp of the recorded check, or null when never preflighted. */
  checkedAt: string | null;
  /** Recorded `PostingPreflightReason`, or '' when never preflighted. */
  reason: string;
  evidence: {
    finalUrl: string;
    provider: string;
    redirected: boolean;
    responseStatus: number | null;
    excerpt: string;
  } | null;
  /** Durable audit reference for the recorded verdict. */
  evidenceRef: { agentRunId: string; adminUrl: string } | null;
}

const POSTING_PREFLIGHT_RUN_TYPE = 'posting_preflight';
const EXCERPT_MAX_LENGTH = 240;

type Collection = {
  list: (options?: Record<string, unknown>) => Promise<unknown[]>;
};

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isoTime(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  const raw = stringValue(value);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stateFromOutcome(outcome: string): PostingPreflightState {
  if (outcome === 'live' || outcome === 'closed') return outcome;
  return 'inconclusive';
}

export function neverPreflighted(): PostingPreflightStatus {
  return {
    state: 'never_preflighted',
    checkedAt: null,
    reason: '',
    evidence: null,
    evidenceRef: null,
  };
}

/**
 * Map one `posting_preflight` AgentRun (as recorded by
 * `recordPostingPreflight`) to the bounded agent-visible status. The override
 * audit (`posting_preflight_override`) is deliberately not consulted: a human
 * override is not verification evidence and stays off the WebMCP surface.
 */
export function postingPreflightStatusFromAgentRun(
  run: Record<string, unknown> | null | undefined,
): PostingPreflightStatus {
  if (!run) return neverPreflighted();
  const output = jsonObject(run.outputJson ?? run.output);
  const evidence = jsonObject(output.evidence);
  const agentRunId = stringValue(run.id);
  const outcome = stringValue(output.outcome);
  const responseStatus =
    typeof evidence.responseStatus === 'number' &&
    Number.isFinite(evidence.responseStatus)
      ? evidence.responseStatus
      : null;
  const excerpt = stringValue(evidence.evidenceExcerpt);

  return {
    state: stateFromOutcome(outcome),
    checkedAt:
      isoTime(evidence.checkedAt) ??
      isoTime(run.finishedAt) ??
      isoTime(run.startedAt),
    reason: stringValue(output.reason) || stringValue(run.error),
    evidence: {
      finalUrl: stringValue(evidence.finalUrl),
      provider: stringValue(evidence.provider) || 'unknown',
      redirected: evidence.redirected === true,
      responseStatus,
      excerpt:
        excerpt.length > EXCERPT_MAX_LENGTH
          ? `${excerpt.slice(0, EXCERPT_MAX_LENGTH)}…`
          : excerpt,
    },
    evidenceRef: agentRunId
      ? {
          agentRunId,
          adminUrl: `/admin/agent-runs/${encodeURIComponent(agentRunId)}/`,
        }
      : null,
  };
}

/** Read the most recent recorded preflight verdict for one opportunity. */
export async function latestPostingPreflightStatus(
  opportunityId: string,
): Promise<PostingPreflightStatus> {
  const id = stringValue(opportunityId);
  if (!id) return neverPreflighted();
  const agentRuns = (await getCollection('AgentRun')) as unknown as Collection;
  const [latest] = await agentRuns.list({
    limit: 1,
    orderBy: 'started_at DESC',
    where: { opportunityId: id, runType: POSTING_PREFLIGHT_RUN_TYPE },
  });
  return postingPreflightStatusFromAgentRun(
    latest
      ? (JSON.parse(JSON.stringify(latest)) as Record<string, unknown>)
      : null,
  );
}
