/** Local private learning only. Logistic outputs are scores until calibration is independently established. */
export type MatchSample = {
  id: string;
  at: number;
  label: 0 | 0.5 | 1;
  features: number[];
  baseline: number;
};
export type PrivateMatchModel = {
  weights: number[];
  intercept: number;
  trained: boolean;
};
const sigmoid = (value: number) =>
  1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));
function validateSamples(samples: readonly MatchSample[]) {
  const width = samples[0]?.features.length ?? 0;
  const ids = new Set<string>();
  for (const row of samples) {
    if (
      ids.has(row.id) ||
      !Number.isFinite(row.at) ||
      ![0, 0.5, 1].includes(row.label) ||
      !Number.isFinite(row.baseline) ||
      row.baseline < 0 ||
      row.baseline > 1 ||
      row.features.length !== width ||
      row.features.some(
        (value) => !Number.isFinite(value) || Math.abs(value) > 1,
      )
    )
      throw new Error('Invalid private matching evaluation sample.');
    ids.add(row.id);
  }
}
export function trainPrivateReranker(
  samples: readonly MatchSample[],
): PrivateMatchModel {
  validateSamples(samples);
  if (samples.length < 5 || new Set(samples.map((s) => s.label)).size < 2)
    return { weights: [], intercept: 0, trained: false };
  const weights = Array<number>(samples[0].features.length).fill(0);
  let intercept = 0;
  // Full-batch L2 regularization avoids order-dependent updates and constrains sparse labels.
  for (let step = 0; step < 160; step++) {
    const gradient = weights.map(() => 0);
    let bias = 0;
    for (const sample of samples) {
      const error =
        sample.label -
        sigmoid(
          intercept +
            sample.features.reduce(
              (sum, value, i) => sum + value * weights[i],
              0,
            ),
        );
      bias += error;
      for (let i = 0; i < weights.length; i++)
        gradient[i] += error * sample.features[i];
    }
    intercept += (0.2 * bias) / samples.length;
    for (let i = 0; i < weights.length; i++)
      weights[i] += 0.2 * (gradient[i] / samples.length - 0.05 * weights[i]);
  }
  return { weights, intercept, trained: true };
}
export function rankWithPrivateModel(
  features: readonly number[],
  model: PrivateMatchModel,
): number {
  if (!model.trained) return 0;
  if (
    features.length !== model.weights.length ||
    features.some((value) => !Number.isFinite(value))
  )
    throw new Error('Private reranker feature contract changed.');
  return sigmoid(
    model.intercept +
      features.reduce(
        (sum, value, index) => sum + value * model.weights[index],
        0,
      ),
  );
}
/** Pearson correlation of average ranks, including ties; constants have no correlation. */
export function rankCorrelation(
  left: readonly number[],
  right: readonly number[],
): number | null {
  if (left.length !== right.length || left.length < 2) return null;
  const ranks = (values: readonly number[]) => {
    const ordered = values
      .map((value, index) => ({ value, index }))
      .sort((a, b) => a.value - b.value);
    const result = Array<number>(values.length);
    for (let start = 0; start < ordered.length; ) {
      let end = start + 1;
      while (
        end < ordered.length &&
        ordered[end].value === ordered[start].value
      )
        end++;
      for (let i = start; i < end; i++)
        result[ordered[i].index] = (start + end + 1) / 2;
      start = end;
    }
    return result;
  };
  const a = ranks(left),
    b = ranks(right),
    mean = (left.length + 1) / 2;
  const varianceA = a.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  const varianceB = b.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  return varianceA && varianceB
    ? a.reduce((sum, value, i) => sum + (value - mean) * (b[i] - mean), 0) /
        Math.sqrt(varianceA * varianceB)
    : null;
}
export function evaluateScoredMatches(
  samples: readonly MatchSample[],
  score: (sample: MatchSample) => number = (sample) => sample.baseline,
) {
  validateSamples(samples);
  const scored = samples.map((sample) => ({ sample, score: score(sample) }));
  if (
    scored.some(
      (row) => !Number.isFinite(row.score) || row.score < 0 || row.score > 1,
    )
  )
    throw new Error('Invalid matching evaluation score.');
  const ranked = [...scored].sort(
    (a, b) => b.score - a.score || a.sample.id.localeCompare(b.sample.id),
  );
  const top = ranked.slice(0, 10);
  const dcg = (rows: readonly MatchSample[]) =>
    rows.reduce(
      (sum, row, i) => sum + (2 ** row.label - 1) / Math.log2(i + 2),
      0,
    );
  const ideal = dcg(
    [...samples].sort((a, b) => b.label - a.label).slice(0, 10),
  );
  const positives = samples.filter((row) => row.label === 1).length;
  return {
    ndcg10: ideal ? dcg(top.map((row) => row.sample)) / ideal : null,
    p10: top.length
      ? top.filter((row) => row.sample.label === 1).length / top.length
      : null,
    recall50: positives
      ? ranked.slice(0, 50).filter((row) => row.sample.label === 1).length /
        positives
      : null,
    brier: scored.length
      ? scored.reduce(
          (sum, row) => sum + (row.score - row.sample.label) ** 2,
          0,
        ) / scored.length
      : null,
    spearman: rankCorrelation(
      samples.map((row) => row.label),
      scored.map((row) => row.score),
    ),
  };
}
export function evaluateMatchSamples(samples: readonly MatchSample[]) {
  validateSamples(samples);
  const ordered = [...samples].sort(
    (a, b) => a.at - b.at || a.id.localeCompare(b.id),
  );
  const split = Math.floor(ordered.length * 0.8);
  const boundary = ordered[split]?.at ?? Infinity;
  // Decisions sharing a timestamp remain together in held-out data.
  const train = ordered.filter((row) => row.at < boundary);
  const heldout = ordered.filter((row) => row.at >= boundary);
  const model = trainPrivateReranker(train);
  return {
    total: ordered.length,
    train: train.length,
    heldout: heldout.length,
    trained: model.trained,
    calibrated: false as const,
    ...evaluateScoredMatches(heldout, (row) =>
      model.trained ? rankWithPrivateModel(row.features, model) : row.baseline,
    ),
    baseline: evaluateScoredMatches(heldout),
  };
}
export function shouldUsePrivateReranker(
  samples: readonly MatchSample[],
): boolean {
  const result = evaluateMatchSamples(samples);
  return (
    result.trained &&
    result.heldout >= 10 &&
    result.p10 !== null &&
    result.baseline.p10 !== null &&
    result.p10 > result.baseline.p10
  );
}
