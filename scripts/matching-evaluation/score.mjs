function scope(candidate, opportunity) {
  const role =
    candidate.targetRole === null || opportunity.role === null
      ? 'unknown'
      : candidate.targetRole === opportunity.role
        ? 'supported'
        : 'absent';
  let location = 'unknown';
  if (opportunity.regions?.size === 0) location = 'supported';
  else if (opportunity.regions && candidate.region !== null) {
    location = opportunity.regions.has(candidate.region)
      ? 'supported'
      : 'absent';
  }
  return [role, location];
}

function requirement(candidate, alternatives) {
  if (alternatives.some((id) => candidate.supported.has(id)))
    return 'supported';
  if (alternatives.every((id) => candidate.absent.has(id))) return 'absent';
  return 'unknown';
}

export function structuredPair(candidate, opportunity) {
  const hard = [
    ...scope(candidate, opportunity),
    ...opportunity.must.map((group) => requirement(candidate, group)),
  ];
  const preferred = opportunity.preferred.map((group) =>
    requirement(candidate, group),
  );
  const hardCoverage =
    hard.filter((value) => value === 'supported').length / hard.length;
  const preferenceCoverage = preferred.length
    ? preferred.filter((value) => value === 'supported').length /
      preferred.length
    : 0;
  let decision = 'eligible';
  if (hard.includes('absent')) decision = 'ineligible';
  else if (hard.includes('unknown')) decision = 'unknown';
  return { decision, score: 0.75 * hardCoverage + 0.25 * preferenceCoverage };
}

export function cosine(left, right) {
  let score = 0;
  for (let index = 0; index < left.length; index++)
    score += left[index] * right[index];
  return Math.max(-1, Math.min(1, score));
}

export function hybridScore(structured, semantic) {
  return 0.5 * structured + 0.5 * ((semantic + 1) / 2);
}

export function rank(items, field) {
  return [...items].sort((left, right) => {
    const difference = right[field] - left[field];
    if (difference) return difference;
    if (left.id === right.id) return 0;
    return left.id < right.id ? -1 : 1;
  });
}

function dcg(grades) {
  return grades.reduce(
    (sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2),
    0,
  );
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

export function measure(judgments, retrieved, admitted, displayed, depth) {
  const ideal = [...judgments.values()]
    .map((label) => label.relevance)
    .sort((a, b) => b - a);
  const positives = ideal.filter((grade) => grade > 0).length;
  const retrievedEligible = retrieved.filter(
    (pair) => judgments.get(pair.id).outcome === 'eligible',
  ).length;
  const admittedEligible = admitted.filter(
    (pair) => judgments.get(pair.id).outcome === 'eligible',
  ).length;
  const admittedUnknown = admitted.filter(
    (pair) => judgments.get(pair.id).outcome === 'unknown',
  ).length;
  const displayedGrades = displayed.map(
    (pair) => judgments.get(pair.id).relevance,
  );
  return {
    positives,
    retrieved: retrieved.length,
    retrievedEligible,
    admitted: admitted.length,
    admittedEligible,
    admittedUnknown,
    admittedIneligible: admitted.length - admittedEligible - admittedUnknown,
    abstained: retrieved.filter((pair) => pair.decision === 'unknown').length,
    rejected: retrieved.filter((pair) => pair.decision === 'ineligible').length,
    displayedEligible: displayedGrades.filter((grade) => grade > 0).length,
    ndcg: ratio(dcg(displayedGrades), dcg(ideal.slice(0, depth))),
  };
}

export function summarize(rows) {
  const total = (key) => rows.reduce((sum, row) => sum + row[key], 0);
  const ranked = rows.filter((row) => row.ndcg !== null);
  return {
    contexts: rows.length,
    rankedContexts: ranked.length,
    positives: total('positives'),
    retrieved: total('retrieved'),
    admitted: total('admitted'),
    falseAdmissions: total('admittedIneligible'),
    unresolvedAdmissions: total('admittedUnknown'),
    abstained: total('abstained'),
    rejected: total('rejected'),
    retrievalRecall: ratio(total('retrievedEligible'), total('positives')),
    admissionPrecision: ratio(total('admittedEligible'), total('admitted')),
    decisionCoverage: ratio(
      total('retrieved') - total('abstained'),
      total('retrieved'),
    ),
    displayedRecall: ratio(total('displayedEligible'), total('positives')),
    ndcg: ratio(
      ranked.reduce((sum, row) => sum + row.ndcg, 0),
      ranked.length,
    ),
  };
}

export const retrievalDepth = 3;
export const displayDepth = 2;

export function compareScenario(scenario, vectors, poolDepth = retrievalDepth) {
  const { candidate, opportunities, judgments } = scenario;
  const query = vectors.get(candidate.id);
  const pairs = opportunities.map((opportunity) => {
    const structured = structuredPair(candidate, opportunity);
    const semantic = cosine(query, vectors.get(opportunity.id));
    return {
      id: opportunity.id,
      structured: structured.score,
      decision: structured.decision,
      semantic,
      hybrid: hybridScore(structured.score, semantic),
    };
  });
  const structuredPool = rank(pairs, 'structured').slice(0, poolDepth);
  const semanticPool = rank(pairs, 'semantic').slice(0, poolDepth);
  const structuredEligible = structuredPool.filter(
    (pair) => pair.decision === 'eligible',
  );
  const semanticEligible = semanticPool.filter(
    (pair) => pair.decision === 'eligible',
  );
  const ungated = semanticPool.map((pair) => ({
    ...pair,
    decision: 'eligible',
  }));
  const arms = {
    structured: [structuredPool, structuredEligible, structuredEligible],
    semantic: [ungated, ungated, ungated],
    gatedSemantic: [semanticPool, semanticEligible, semanticEligible],
    hybrid: [semanticPool, semanticEligible, rank(semanticEligible, 'hybrid')],
  };
  return Object.fromEntries(
    Object.entries(arms).map(([arm, [retrieved, admitted, ordered]]) => {
      const displayed = ordered.slice(0, displayDepth);
      return [
        arm,
        {
          ...measure(judgments, retrieved, admitted, displayed, displayDepth),
          retrievedIds: retrieved.map((pair) => pair.id),
          displayedIds: displayed.map((pair) => pair.id),
        },
      ];
    }),
  );
}
