// Native manifests must precede model imports in standalone operator scripts.
import '../src/lib/server/manifest-preload.js';
import { pathToFileURL } from 'node:url';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { enrichMatchEvidence } from '../src/lib/server/opportunity-match-cache.js';
import { matchCandidateEvidence } from '../src/lib/server/opportunity-match-evidence.js';
import {
  evaluateMatchSamples,
  evaluateScoredMatches,
  rankCorrelation,
} from '../src/lib/server/opportunity-match-reranker.js';
import {
  loadMatchingCatalog,
  loadMatchingSkillGraph,
  loadOwnedMatchSamples,
} from '../src/lib/server/opportunity-matching.js';
import { listOwnedOpportunityRecommendationRanks } from '../src/lib/server/opportunity-recommendation-rank.js';
import { requirementCoverageScore } from '../src/lib/server/public-search/match.js';
import { loadWorkspaceCandidateEvidence } from '../src/lib/server/resume-data.js';
import { refreshSkillVocabularyLookup } from '../src/lib/server/skill-vocabulary.js';
import {
  requireCandidateWorkspaceSubject,
  resolveWorkspaceSubjectForProfile,
  verifyWorkspaceSubject,
  withVerifiedWorkspaceSubject,
} from '../src/lib/server/workspace-subject.js';

export function parseMatchEvaluationArguments(args: string[]) {
  const permitted = new Set(['--tenant-id', '--user-id', '--profile-id']);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (
      !permitted.has(args[i]) ||
      !args[i + 1] ||
      args[i + 1].startsWith('--') ||
      values.has(args[i])
    )
      throw new Error('Expected --tenant-id ID --user-id ID --profile-id ID.');
    values.set(args[i], args[i + 1]);
  }
  if (values.size !== 3)
    throw new Error('Expected --tenant-id ID --user-id ID --profile-id ID.');
  return {
    tenantId: values.get('--tenant-id')!,
    userId: values.get('--user-id')!,
    profileId: values.get('--profile-id')!,
  };
}
/** Explicit local operator selection is revalidated against live membership and profile ownership. No writes/provider calls. */
export async function runMatchEvaluation(input: {
  tenantId: string;
  userId: string;
  profileId: string;
}) {
  return withTenant(
    { tenantId: input.tenantId, userId: input.userId },
    async () => {
      const subject = await verifyWorkspaceSubject({
        tenantId: input.tenantId,
        user: { id: input.userId },
      });
      if (!subject)
        throw new Error('Operator subject is not an active workspace member.');
      const selected = await withVerifiedWorkspaceSubject(subject, async () =>
        resolveWorkspaceSubjectForProfile(input.profileId),
      );
      return withVerifiedWorkspaceSubject(selected, async (verified) => {
        const owned = requireCandidateWorkspaceSubject(verified);
        await refreshSkillVocabularyLookup();
        const [candidate, postings, graph] = await Promise.all([
          loadWorkspaceCandidateEvidence(owned),
          loadMatchingCatalog(),
          loadMatchingSkillGraph(),
        ]);
        const matches = matchCandidateEvidence(
          candidate,
          postings,
          Date.now(),
          graph,
        );
        const samples = await loadOwnedMatchSamples(owned, matches, postings);
        const prior = new Map<string, number>();
        for (let offset = 0; offset < postings.length; offset += 200) {
          for (const rank of await listOwnedOpportunityRecommendationRanks(
            owned,
            postings.slice(offset, offset + 200).map((p) => p.id),
          )) {
            if (
              rank.projectionVersion === 'opportunity-recommendation-rank/v2' &&
              rank.recommendationPercent !== null
            )
              prior.set(rank.opportunityId, rank.recommendationPercent / 100);
          }
        }
        const enriched = structuredClone(matches);
        const cache = await enrichMatchEvidence(
          owned,
          candidate,
          enriched,
          postings,
          undefined,
          false,
        );
        const enrichedById = new Map(
          enriched.map((m) => [
            m.id,
            (requirementCoverageScore(m.explanation.requirements) *
              Math.max(0, 1 - m.seniorityDelta * 0.15)) /
              100,
          ]),
        );
        const enrichedSamples = samples.map((sample) => {
          const score = enrichedById.get(sample.id) ?? sample.baseline;
          return {
            ...sample,
            baseline: score,
            features: [score, ...sample.features.slice(1)],
          };
        });
        const comparable = samples.filter((s) => prior.has(s.id));
        const legacy = comparable.length
          ? {
              count: comparable.length,
              ...evaluateScoredMatches(comparable, (s) => prior.get(s.id)!),
              spearmanAgainstStage2: rankCorrelation(
                comparable.map((s) => s.baseline),
                comparable.map((s) => prior.get(s.id)!),
              ),
            }
          : null;
        return {
          version: 'match-evaluation/v1',
          calibrated: false,
          labeledCount: samples.length,
          stage2: evaluateScoredMatches(samples),
          stage2CachedStage3: evaluateScoredMatches(
            samples,
            (s) => enrichedById.get(s.id) ?? s.baseline,
          ),
          stage4Heldout: evaluateMatchSamples(enrichedSamples),
          legacy,
          legacyUnavailableReason: legacy
            ? null
            : 'No comparable owner v2 ranks are available; legacy quality targets remain unverified.',
          stage3: {
            cacheHits: cache.cacheHits,
            cacheLookups: cache.cacheLookups,
            providerCalls: 0,
            tokenSpend: 0,
          },
          realOwnerAcceptance: 'unverified',
        };
      });
    },
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.slice(2).includes('--help'))
    process.stdout.write(
      'match:evaluate --tenant-id ID --user-id ID --profile-id ID\nUses the configured app database. Emits aggregate JSON only; no provider calls or writes.\n',
    );
  else {
    try {
      process.stdout.write(
        `${JSON.stringify(await runMatchEvaluation(parseMatchEvaluationArguments(process.argv.slice(2))))}\n`,
      );
    } catch {
      process.stderr.write(
        'Match evaluation failed. Verify the configured database, active workspace membership, and selected profile.\n',
      );
      process.exitCode = 1;
    }
  }
}
