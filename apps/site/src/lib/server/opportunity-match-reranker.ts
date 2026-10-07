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
export function trainPrivateReranker(
  samples: readonly MatchSample[],
): PrivateMatchModel {
  if (samples.length < 5) return { weights: [], intercept: 0, trained: false };
  const width = samples[0]?.features.length ?? 0;
  const weights = Array<number>(width).fill(0);
  let intercept = 0;
  for (let step = 0; step < 160; step += 1)
    for (const sample of samples) {
      const p = sigmoid(
        intercept +
          sample.features.reduce(
            (total, value, index) => total + value * (weights[index] ?? 0),
            0,
          ),
      );
      const error = sample.label - p;
      intercept += 0.03 * error;
      for (let index = 0; index < width; index += 1)
        weights[index] =
          (weights[index] ?? 0) * 0.999 +
          0.03 * error * (sample.features[index] ?? 0);
    }
  return { weights, intercept, trained: true };
}
export function rankWithPrivateModel(
  features: readonly number[],
  model: PrivateMatchModel,
): number {
  return model.trained
    ? sigmoid(
        model.intercept +
          features.reduce(
            (total, value, index) =>
              total + value * (model.weights[index] ?? 0),
            0,
          ),
      )
    : 0;
}
function dcg(values: readonly MatchSample[]): number {
  return values.reduce(
    (total, item, index) =>
      total + (2 ** item.label - 1) / Math.log2(index + 2),
    0,
  );
}
function spearman(
  values: readonly MatchSample[],
  scores: readonly number[],
): number | null {
  if (values.length < 2) return null;
  const ranks = (items: readonly number[]) =>
    items.map((value) => 1 + items.filter((other) => other > value).length);
  const left = ranks(values.map((item) => item.label));
  const right = ranks(scores);
  const n = values.length;
  const sum = left.reduce(
    (total, value, index) => total + (value - (right[index] ?? 0)) ** 2,
    0,
  );
  return 1 - (6 * sum) / (n * (n * n - 1));
}
export function evaluateMatchSamples(samples: readonly MatchSample[]) {
  const ordered = [...samples].sort((a, b) => a.at - b.at);
  const split = Math.max(1, Math.floor(ordered.length * 0.8));
  const train = ordered.slice(0, split);
  const test = ordered.slice(split);
  const model = trainPrivateReranker(train);
  const scored = test
    .map((item) => ({
      item,
      score: rankWithPrivateModel(item.features, model) || item.baseline,
    }))
    .sort((a, b) => b.score - a.score);
  const top10 = scored.slice(0, 10).map((x) => x.item);
  const ideal = [...test].sort((a, b) => b.label - a.label).slice(0, 10);
  const positives = test.filter((x) => x.label === 1);
  const brier = test.length
    ? test.reduce(
        (sum, item) =>
          sum + (rankWithPrivateModel(item.features, model) - item.label) ** 2,
        0,
      ) / test.length
    : null;
  return {
    total: samples.length,
    train: train.length,
    heldout: test.length,
    trained: model.trained,
    ndcg10: dcg(top10) / Math.max(dcg(ideal), 1),
    p10: top10.length
      ? top10.filter((x) => x.label === 1).length / top10.length
      : null,
    recall50: positives.length
      ? scored.slice(0, 50).filter((x) => x.item.label === 1).length /
        positives.length
      : null,
    brier,
    spearman: spearman(
      test,
      scored.map((x) => x.score),
    ),
  };
}
