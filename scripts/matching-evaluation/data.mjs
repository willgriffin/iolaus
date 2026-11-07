import { createHash } from 'node:crypto';

export const model = 'sentence-transformers/all-MiniLM-L6-v2';
export const revision = '1110a243fdf4706b3f48f1d95db1a4f5529b4d41';
export const dimensions = 384;

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireValue(condition, description) {
  if (!condition)
    throw new Error(`Invalid matching evaluation: ${description}`);
}

function rows(value, field) {
  requireValue(Array.isArray(value), field);
  return value;
}

function string(value, field) {
  requireValue(typeof value === 'string' && value.trim(), field);
  return value;
}

function unique(map, key, value, field) {
  requireValue(!map.has(key), `duplicate ${field} ${key}`);
  map.set(key, value);
}

function index(value, field) {
  const byId = new Map();
  for (const row of rows(value, field)) {
    unique(byId, string(row?.id, `${field} ID`), row, field);
  }
  return byId;
}

const token = (value) => value.trim().toLowerCase();
function nullableToken(value, field) {
  return value === null ? null : token(string(value, field));
}

export function normalizeText(value) {
  return string(value, 'embedding text')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function prepareFixtures(fixtures) {
  const aliases = new Map();
  const ancestors = new Map();
  for (const [id, concept] of index(fixtures?.concepts, 'concept')) {
    requireValue(id === token(id), `canonical concept ID ${id}`);
    ancestors.set(id, new Set());
    for (const alias of [id, ...rows(concept.aliases, 'aliases')]) {
      const normalized = token(string(alias, 'alias'));
      requireValue(
        !aliases.has(normalized) || aliases.get(normalized) === id,
        `ambiguous alias ${normalized}`,
      );
      aliases.set(normalized, id);
    }
  }
  function conceptId(value) {
    const id = aliases.get(token(string(value, 'concept reference')));
    requireValue(id, `unknown concept ${value}`);
    return id;
  }
  for (const relation of rows(fixtures.relations, 'relations')) {
    const { from, to, kind } = relation;
    requireValue(
      ancestors.has(from) && ancestors.has(to) && from !== to,
      'relation endpoints',
    );
    requireValue(kind === 'narrower' || kind === 'related', 'relation kind');
    if (kind === 'narrower') ancestors.get(from).add(to);
  }
  // Expand the directional implication once, outside pair scoring.
  for (const [id, targets] of ancestors) {
    for (const target of targets) {
      requireValue(target !== id, `cyclic narrower relation for ${id}`);
      for (const ancestor of ancestors.get(target)) targets.add(ancestor);
    }
  }

  function evidence(items) {
    const states = new Map();
    for (const item of rows(items, 'candidate evidence')) {
      const id = conceptId(item.value);
      requireValue(
        ['supported', 'absent', 'unknown'].includes(item.state),
        'evidence state',
      );
      string(item.evidence, 'evidence citation');
      unique(states, id, item.state, 'evidence');
    }
    const supported = new Set();
    for (const [id, state] of states) {
      if (state !== 'supported') continue;
      supported.add(id);
      for (const ancestor of ancestors.get(id)) supported.add(ancestor);
    }
    const absent = new Set();
    for (const [id, targets] of ancestors) {
      if (
        states.get(id) === 'absent' ||
        [...targets].some((target) => states.get(target) === 'absent')
      ) {
        requireValue(!supported.has(id), `contradictory evidence for ${id}`);
        absent.add(id);
      }
    }
    return { supported, absent };
  }

  function groups(value, field) {
    return rows(value, field).map((group) => {
      const options = rows(group, field).map(conceptId);
      requireValue(options.length > 0, `empty ${field} alternatives`);
      requireValue(
        new Set(options).size === options.length,
        `duplicate ${field} alternatives`,
      );
      return options;
    });
  }

  const texts = new Map();
  function register(row, role) {
    const id = string(row?.id, `${role} ID`);
    unique(
      texts,
      id,
      { id, role, text: normalizeText(row.text) },
      'embedding ID',
    );
    return id;
  }

  const families = new Map();
  const scenarios = [...index(fixtures.scenarios, 'scenario').values()].map(
    (scenario) => {
      const { id, candidate, split } = scenario;
      const family = string(scenario.family, 'family');
      requireValue(split === 'development' || split === 'held-out', 'split');
      requireValue(
        !families.has(family) || families.get(family) === split,
        `family leakage for ${family}`,
      );
      families.set(family, split);
      const preparedCandidate = {
        id: register(candidate, 'candidate'),
        ...evidence(candidate.concepts),
        targetRole: nullableToken(candidate.targetRole, 'target role'),
        region: nullableToken(candidate.region, 'candidate region'),
      };
      const opportunities = new Map();
      for (const row of rows(scenario.opportunities, 'opportunities')) {
        const opportunityId = register(row, 'opportunity');
        string(row.source, 'opportunity source');
        string(row.version, 'opportunity version');
        opportunities.set(opportunityId, {
          id: opportunityId,
          role: nullableToken(row.role, 'opportunity role'),
          regions:
            row.regions === null
              ? null
              : new Set(
                  rows(row.regions, 'opportunity regions').map((region) =>
                    token(string(region, 'opportunity region')),
                  ),
                ),
          must: groups(row.must, 'must'),
          preferred: groups(row.preferred, 'preferred'),
        });
      }
      requireValue(opportunities.size > 0, 'empty scenario');
      const judgments = new Map();
      for (const judgment of rows(scenario.judgments, 'judgments')) {
        const { opportunityId, outcome, relevance, reason } = judgment;
        requireValue(
          opportunities.has(opportunityId),
          `unexpected judgment ID ${opportunityId}`,
        );
        requireValue(
          ['eligible', 'ineligible', 'unknown'].includes(outcome),
          'judgment outcome',
        );
        requireValue(
          (outcome === 'eligible' ? [1, 2] : [0]).includes(relevance),
          'judgment relevance',
        );
        string(reason, 'judgment reason');
        unique(judgments, opportunityId, { outcome, relevance }, 'judgment');
      }
      requireValue(
        judgments.size === opportunities.size,
        `incomplete judgments for ${id}`,
      );
      return {
        id,
        split,
        candidate: preparedCandidate,
        opportunities: [...opportunities.values()],
        judgments,
      };
    },
  );
  requireValue(new Set(families.values()).size === 2, 'both splits required');
  const inputs = JSON.stringify([...texts.values()]) + '\n';
  return { scenarios, inputs, ids: new Set(texts.keys()) };
}

export function loadVectors(cache, { inputs, ids }) {
  requireValue(
    cache?.model === model &&
      cache.revision === revision &&
      cache.dimensions === dimensions,
    'embedding provenance',
  );
  requireValue(
    cache.inputSha256 === sha256(inputs),
    'embedding input fingerprint (regenerate cache)',
  );
  const vectors = new Map();
  for (const record of rows(cache.vectors, 'vectors')) {
    const { id, values } = record;
    requireValue(ids.has(id), `unexpected vector ${id}`);
    const bytes = Buffer.from(string(values, 'packed vector'), 'base64');
    requireValue(
      bytes.length === dimensions * 4 && bytes.toString('base64') === values,
      `malformed vector ${id}`,
    );
    const vector = Float32Array.from({ length: dimensions }, (_, index) =>
      bytes.readFloatLE(index * 4),
    );
    requireValue(vector.every(Number.isFinite), `nonfinite vector ${id}`);
    const norm = vector.reduce((sum, value) => sum + value * value, 0);
    requireValue(Math.abs(norm - 1) < 1e-4, `non-unit vector ${id}`);
    unique(vectors, id, vector, 'vector');
  }
  requireValue(vectors.size === ids.size, 'missing vectors');
  return vectors;
}
