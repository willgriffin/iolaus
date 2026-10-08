import { detectEngine } from '@happyvertical/smrt-core';
import type { OpportunityAnalysisSnapshot } from '../opportunity-analysis-contract.js';
import {
  enrichMatchEvidence,
  MAX_STAGE_THREE_POSTINGS,
} from './opportunity-match-cache.js';
import {
  contentHash,
  MATCH_CONTRACT,
  MATCH_MODEL,
  MATCH_PROJECTION,
  matchCandidateEvidence,
} from './opportunity-match-evidence.js';
import {
  type MatchSample,
  rankWithPrivateModel,
  shouldUsePrivateReranker,
  trainPrivateReranker,
} from './opportunity-match-reranker.js';
import {
  matchTransaction,
  saveOwnedMatchRecord,
} from './opportunity-match-store.js';
import { listPrivateRecords } from './private-workspace.js';
import {
  matchPublicSkills,
  type PublicMatchOpportunity,
  type PublicMatchResult,
  requirementCoverageScore,
} from './public-search/match.js';
import {
  loadWorkspaceCandidateEvidence,
  type WorkspaceCandidateEvidence,
} from './resume-data.js';
import { refreshSkillVocabularyLookup } from './skill-vocabulary.js';
import { getCollection } from './smrt.js';
import {
  requireCandidateWorkspaceSubject,
  type WorkspaceSubject,
  withVerifiedWorkspaceSubject,
} from './workspace-subject.js';

export { MAX_STAGE_THREE_POSTINGS } from './opportunity-match-cache.js';
export const OPPORTUNITY_MATCH_VERSION = MATCH_CONTRACT;
export type OpportunityMatch = PublicMatchResult & {
  scoreKind?: 'coverage' | 'private_reranker';
  calibrated?: false;
};
export type MatchPosting = PublicMatchOpportunity & {
  sourceContentFingerprint: string;
  sourceContentVersion: number;
  analysisId: string;
  analysisFingerprint: string;
  requiredSkillsSnapshot: string;
  preferredSkillsSnapshot: string;
  postedAt: string;
};
export type OpportunityMatchReader = {
  listOpportunities(input: {
    limit: number;
    skills: readonly string[];
  }): Promise<readonly PublicMatchOpportunity[]>;
  loadCandidateSkills(
    subject: Required<WorkspaceSubject>,
  ): Promise<readonly string[]>;
};
export type OpportunityMatchDependencies = { reader: OpportunityMatchReader };
const parse = <T>(value: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
};
/** Batch all current source analyses before recall; never LIMIT an arbitrary first page. */
export async function loadMatchingCatalog(): Promise<MatchPosting[]> {
  const [opportunities, analyses, sources] = await Promise.all(
    ['Opportunity', 'OpportunityAnalysis', 'Source'].map((name) =>
      getCollection(name),
    ),
  );
  const postings = await opportunities.list({
    where: { 'status not in': ['closed', 'archived', 'expired'] },
    limit: 10001,
    cache: false,
  });
  if (postings.length > 10000)
    throw new Error('Matching catalog exceeds the bounded recall window.');
  const currentIds = [
    ...new Set(
      postings
        .map((record) =>
          String(
            (record as unknown as Record<string, unknown>).currentAnalysisId ??
              (record.toJSON() as Record<string, unknown>).currentAnalysisId ??
              '',
          ),
        )
        .filter(Boolean),
    ),
  ];
  const snapshots = [] as Awaited<ReturnType<typeof analyses.list>>;
  // Select referenced analyses, never an arbitrary page of historical analyses.
  for (let offset = 0; offset < currentIds.length; offset += 400)
    snapshots.push(
      ...(await analyses.list({
        where: {
          'id in': currentIds.slice(offset, offset + 400),
          'status in': ['deterministic', 'enriched'],
        },
        limit: 400,
        cache: false,
      })),
    );
  const sourceIds = [
    ...new Set(
      postings
        .map((record) =>
          String((record.toJSON() as Record<string, unknown>).sourceId ?? ''),
        )
        .filter(Boolean),
    ),
  ];
  const sourceRows = [] as Awaited<ReturnType<typeof sources.list>>;
  for (let offset = 0; offset < sourceIds.length; offset += 400)
    sourceRows.push(
      ...(await sources.list({
        where: { 'id in': sourceIds.slice(offset, offset + 400) },
        limit: 400,
        cache: false,
      })),
    );
  const visibleSources = new Set(
    sourceRows
      .filter((r) => {
        const s = r.toJSON() as Record<string, unknown>;
        return s.isActive === true && s.publicListing !== false;
      })
      .map((r) => r.id),
  );
  const analysisById = new Map(
    snapshots.map((r) => [r.id, r.toJSON() as Record<string, unknown>]),
  );
  const rows: MatchPosting[] = [];
  for (const record of postings) {
    const p = record.toJSON() as Record<string, unknown>;
    if (!visibleSources.has(String(p.sourceId))) continue;
    const a = analysisById.get(String(p.currentAnalysisId));
    if (
      !a ||
      a.opportunityId !== p.id ||
      a.sourceContentFingerprint !== p.sourceContentFingerprint ||
      Number(a.sourceContentVersion) !== Number(p.sourceContentVersion)
    )
      continue;
    const skills = parse<OpportunityAnalysisSnapshot['skills']>(
      a.skillsJson,
      [],
    );
    const eligibility = parse<
      NonNullable<PublicMatchOpportunity['eligibility']>
    >(a.eligibilityJson, {});
    rows.push({
      id: String(p.id),
      sourceContentFingerprint: String(p.sourceContentFingerprint),
      sourceContentVersion: Number(p.sourceContentVersion),
      analysisId: String(a.id),
      analysisFingerprint: contentHash([
        a.analysisVersion,
        a.requirementsJson,
        a.skillsJson,
        a.eligibilityJson,
        a.seniority,
      ]),
      requiredSkillsSnapshot: String(p.requiredSkills ?? ''),
      preferredSkillsSnapshot: String(p.preferredSkills ?? ''),
      postedAt: String(p.postedAt ?? p.created_at ?? ''),
      seniority: String(a.seniority),
      eligibility: {
        ...eligibility,
        countries: parse<string[]>(a.countriesJson, []),
      },
      requirements: parse(a.requirementsJson, []),
      skills: {
        required: skills
          .filter((s) => s.kind === 'required')
          .map((s) => s.slug),
        preferred: skills
          .filter((s) => s.kind === 'preferred')
          .map((s) => s.slug),
      },
    });
  }
  return rows;
}
/** Only source/operator-derived public edges contribute partial adjacency. */
export async function loadMatchingSkillGraph(): Promise<
  Map<string, readonly string[]>
> {
  const terms = await getCollection('SkillTerm');
  const rows = await terms.list({
    where: { 'status in': ['seed', 'confirmed'] },
    limit: 10000,
    cache: false,
  });
  const graph = new Map<string, readonly string[]>();
  for (const record of rows) {
    const row = record.toJSON() as Record<string, unknown>;
    const edges = parse<Array<string | { slug: string; weight?: number }>>(
      row.relatedJson,
      [],
    );
    if (!Array.isArray(edges)) continue;
    graph.set(
      String(row.skillSlug),
      edges.flatMap((edge) =>
        typeof edge === 'string'
          ? [edge]
          : typeof edge?.slug === 'string' &&
              (edge.weight === undefined || edge.weight > 0)
            ? [edge.slug]
            : [],
      ),
    );
  }
  return graph;
}
export function matchFeatures(
  match: OpportunityMatch,
  posting?: MatchPosting,
): number[] {
  const ageDays = posting
    ? Math.max(0, (Date.now() - Date.parse(posting.postedAt)) / 86400000)
    : 0;
  return [
    match.score / 100,
    Math.min(1, match.mustHaveConflictCount / 5),
    Math.min(1, match.seniorityDelta / 6),
    Number(
      match.explanation.eligibilityNotes.some((note) =>
        note.startsWith('Explicit conflict'),
      ),
    ),
    Number.isFinite(ageDays) ? Math.min(ageDays / 365, 1) : 0,
  ];
}
export async function loadOwnedMatchSamples(
  subject: WorkspaceSubject,
  matches: readonly OpportunityMatch[],
  postings: readonly MatchPosting[],
): Promise<MatchSample[]> {
  const rows = await listPrivateRecords(
    'Decision',
    requireCandidateWorkspaceSubject(subject),
    {
      where: { 'decision in': ['apply', 'maybe', 'reject'] },
      orderBy: 'created_at ASC',
      limit: 10000,
      cache: false,
    },
  );
  const current = new Map(matches.map((m) => [m.id, m]));
  const latest = new Map<string, Record<string, unknown>>();
  for (const row of rows) latest.set(String(row.opportunityId), row);
  return [...latest.values()].flatMap((row) => {
    const match = current.get(String(row.opportunityId));
    const at = new Date(String(row.created_at)).getTime();
    return match && Number.isFinite(at)
      ? [
          {
            id: match.id,
            at,
            label: (row.decision === 'apply'
              ? 1
              : row.decision === 'maybe'
                ? 0.5
                : 0) as 0 | 0.5 | 1,
            baseline: match.score / 100,
            features: matchFeatures(
              match,
              postings.find((p) => p.id === match.id),
            ),
          },
        ]
      : [];
  });
}
async function publishMatches(
  subject: WorkspaceSubject,
  candidate: WorkspaceCandidateEvidence,
  matches: OpportunityMatch[],
  postings: MatchPosting[],
  materialFingerprint: string,
) {
  return withVerifiedWorkspaceSubject(subject, async (verified) => {
    // Load again at publication; provider calls and learning never hold a transaction open.
    const current = await loadWorkspaceCandidateEvidence(
      requireCandidateWorkspaceSubject(verified),
    );
    if (current.fingerprint !== candidate.fingerprint)
      throw new Error('Candidate changed during matching; retry refresh.');
    return matchTransaction(async (db) => {
      const published = new Set<string>();
      const collection = await getCollection('Opportunity', {
        db: db as never,
      });
      const sources = await getCollection('Source', { db: db as never });
      for (const match of matches) {
        const posting = postings.find((p) => p.id === match.id)!;
        if (db.url && detectEngine(db.url) === 'postgres')
          await db.query(
            'SELECT id FROM opportunities WHERE id = ? FOR SHARE',
            [match.id],
          );
        const live = (
          await collection.list({
            where: { id: match.id },
            cache: false,
            limit: 1,
          })
        )[0]?.toJSON() as Record<string, unknown> | undefined;
        if (
          !live ||
          live.sourceContentFingerprint !== posting.sourceContentFingerprint ||
          Number(live.sourceContentVersion) !== posting.sourceContentVersion ||
          live.currentAnalysisId !== posting.analysisId ||
          ['closed', 'archived', 'expired'].includes(String(live.status))
        )
          continue;
        if (db.url && detectEngine(db.url) === 'postgres')
          await db.query('SELECT id FROM sources WHERE id = ? FOR SHARE', [
            live.sourceId,
          ]);
        const source = (
          await sources.list({
            where: { id: live.sourceId },
            cache: false,
            limit: 1,
          })
        )[0]?.toJSON() as Record<string, unknown> | undefined;
        if (source?.isActive !== true || source.publicListing === false)
          continue;
        await saveOwnedMatchRecord(
          'OpportunityRecommendationRank',
          verified,
          { opportunityId: match.id },
          {
            recommendationPercent: match.score,
            evidenceCoveragePercent: requirementCoverageScore(
              match.explanation.requirements,
            ),
            mustHaveConflictCount: match.mustHaveConflictCount,
            assessmentCompleteness: 'full',
            sourceContentFingerprint: posting.sourceContentFingerprint,
            sourceContentVersion: posting.sourceContentVersion,
            candidateMaterialFingerprint: materialFingerprint,
            questionSetFingerprint: MATCH_CONTRACT,
            requiredSkillsSnapshot: posting.requiredSkillsSnapshot,
            preferredSkillsSnapshot: posting.preferredSkillsSnapshot,
            contractVersion: MATCH_CONTRACT,
            model: MATCH_MODEL,
            projectionVersion: MATCH_PROJECTION,
            assessmentId: posting.analysisId,
            assessmentFingerprint: posting.analysisFingerprint,
            intelligenceRequestId: '',
            intelligenceResultId: '',
            agentRunId: '',
            proofFinishedAt: new Date(),
          },
          db,
        );
        published.add(match.id);
      }
      return published;
    });
  });
}
/** Current source/profile is re-read on each request; no stale private response cache. */
export async function getMyOpportunityMatches(
  subject: WorkspaceSubject,
  input: { limit?: number } = {},
  deps?: OpportunityMatchDependencies,
): Promise<OpportunityMatch[]> {
  return (
    await refreshOpportunityMatches(subject, { limit: input.limit }, deps)
  ).matches;
}
export async function refreshOpportunityMatches(
  subject: WorkspaceSubject,
  options: { enrich?: boolean; limit?: number } = {},
  deps?: OpportunityMatchDependencies,
) {
  const owned = requireCandidateWorkspaceSubject(subject);
  const limit = Math.min(
    100,
    Math.max(
      1,
      Number.isFinite(options.limit) ? Math.floor(options.limit!) : 25,
    ),
  );
  if (deps) {
    const skills = await deps.reader.loadCandidateSkills(owned);
    const rows = await deps.reader.listOpportunities({ limit: 10000, skills });
    const matches = matchPublicSkills({ skills }, rows).slice(0, limit);
    return {
      matches,
      materialFingerprint: contentHash(skills),
      stageThreeCap: MAX_STAGE_THREE_POSTINGS,
      stageThree: { postings: 0, calls: 0, cacheHits: 0, failures: 0 },
    };
  }
  return withVerifiedWorkspaceSubject(owned, async (verified) => {
    await refreshSkillVocabularyLookup();
    const [candidate, postings, _graph] = await Promise.all([
      loadWorkspaceCandidateEvidence(
        requireCandidateWorkspaceSubject(verified),
      ),
      loadMatchingCatalog(),
      loadMatchingSkillGraph(),
    ]);
    // Deterministic coverage over all current catalog rows provides recall before the 300-row rerank budget.
    let matches: OpportunityMatch[] = matchCandidateEvidence(
      candidate,
      postings,
    ).slice(0, 300);
    const stageThree = await enrichMatchEvidence(
      verified,
      candidate,
      matches,
      postings,
      undefined,
      options.enrich === true,
    );
    for (const match of matches) {
      match.mustHaveConflictCount += match.explanation.requirements.filter(
        (r) => r.kind === 'must' && r.decision === 'no',
      ).length;
      match.score = Math.round(
        requirementCoverageScore(match.explanation.requirements) *
          Math.max(0, 1 - match.seniorityDelta * 0.15),
      );
      match.scoreKind = 'coverage';
      match.calibrated = false;
    }
    const samples = await loadOwnedMatchSamples(verified, matches, postings);
    const model = trainPrivateReranker(samples);
    if (model.trained && shouldUsePrivateReranker(samples)) {
      for (const match of matches) {
        match.score = Math.round(
          rankWithPrivateModel(
            matchFeatures(
              match,
              postings.find((p) => p.id === match.id),
            ),
            model,
          ) * 100,
        );
        match.scoreKind = 'private_reranker';
      }
      await matchTransaction(async (db) => {
        await saveOwnedMatchRecord(
          'MatchModel',
          verified,
          { modelVersion: 'match-model/v1' },
          {
            weightsJson: JSON.stringify(model),
            trainingDecisionCount: samples.length,
          },
          db,
        );
      });
    }
    matches.sort(
      (a, b) =>
        a.mustHaveConflictCount - b.mustHaveConflictCount ||
        b.score - a.score ||
        a.id.localeCompare(b.id),
    );
    const materialFingerprint = contentHash([
      candidate.fingerprint,
      MATCH_CONTRACT,
      postings
        .map((p) => [p.id, p.analysisId, p.analysisFingerprint])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      matches.map((m) => [
        m.id,
        m.score,
        m.scoreKind,
        m.mustHaveConflictCount,
        m.explanation.requirements.map((r) => [
          r.hash,
          r.decision,
          r.confidence,
        ]),
      ]),
    ]);
    const published = await publishMatches(
      verified,
      candidate,
      matches,
      postings,
      materialFingerprint,
    );
    matches = matches.filter((match) => published.has(match.id));
    return {
      matches: matches.slice(0, limit),
      materialFingerprint,
      stageThreeCap: MAX_STAGE_THREE_POSTINGS,
      stageThree,
    };
  });
}
