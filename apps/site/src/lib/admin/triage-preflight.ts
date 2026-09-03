/**
 * The client-side shape of a recorded posting preflight verdict.
 *
 * `$lib/server/posting-preflight-status` owns the authoritative type, but that
 * module is server-only; this is the structural subset the triage card renders,
 * so the browser bundle never reaches across the server boundary for a type.
 */
export type TriagePreflightState =
  | 'never_preflighted'
  | 'live'
  | 'closed'
  | 'inconclusive';

export interface TriagePreflight {
  state: TriagePreflightState;
  /** ISO timestamp of the recorded check, or null when never preflighted. */
  checkedAt: string | null;
  /** Recorded preflight reason, or '' when never preflighted. */
  reason: string;
}

const PREFLIGHT_LABELS: Record<TriagePreflightState, string> = {
  closed: 'Closed',
  inconclusive: 'Inconclusive',
  live: 'Live',
  never_preflighted: 'Never checked',
};

/** Operator-facing label for a preflight state. */
export function triagePreflightLabel(state: TriagePreflightState): string {
  return PREFLIGHT_LABELS[state] ?? 'Unknown';
}
