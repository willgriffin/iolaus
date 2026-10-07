import { evaluateMatchSamples, type MatchSample } from '../src/lib/server/opportunity-match-reranker.js';
import { requireCurrentCandidateWorkspaceSubject } from '../src/lib/server/workspace-subject.js';
/** Operator-only aggregate evaluator. Request context must establish subject; it never emits samples. */
export async function evaluateOwnedMatchSamples(load: (subject: ReturnType<typeof requireCurrentCandidateWorkspaceSubject>) => Promise<MatchSample[]>) {
  const subject = requireCurrentCandidateWorkspaceSubject();
  const samples = await load(subject);
  return evaluateMatchSamples(samples);
}
if (import.meta.url === `file://${process.argv[1]}`) throw new Error('match:evaluate requires a verified workspace request context; use the authenticated operator runner.');
