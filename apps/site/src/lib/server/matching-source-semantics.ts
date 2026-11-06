import { createHash } from 'node:crypto';
import { z } from 'zod';
import { onboardingCountryCodes } from './country-reference.js';
import type { MatchingSourceText } from './matching-source-extraction-contract.js';
import { matchingSourceJevBlocks } from './matching-source-jev-blocks.js';
import { matchingSourceStructureMatches } from './matching-source-jev-structure.js';
import {
  MATCHING_SOURCE_SEMANTIC_UNIT_LIMIT,
  matchingSourceSemanticUnits,
} from './matching-source-units.js';
import {
  compileMatchingVocabulary,
  matchingSourceCapabilityGapAllowed,
  matchingSourceRoleInventory,
  matchingSourceSectionHints,
} from './normalized-matching.js';
import { SKILL_VOCABULARY_SEED_TERMS } from './skill-vocabulary.js';

const MAX_ATOMS = 60;

const unitId = z.string().regex(/^(?:title|location|d[1-9]\d{0,2})$/u);
const atom = z
  .object({
    conceptId: z.string().min(1).max(100).nullable(),
    years: z.number().int().min(1).max(80).nullable(),
    context: z.enum(['professional', 'production']).nullable(),
    unsupportedQualifier: z.boolean(),
  })
  .strict();
const group = z.object({ alternatives: z.array(atom).min(1).max(8) }).strict();
const proposal = z
  .object({
    role: z
      .object({
        family: z.string().min(1).max(100),
        specialty: z.string().min(1).max(100).nullable(),
        level: z
          .enum(['entry', 'mid', 'senior', 'staff', 'principal', 'lead'])
          .nullable(),
        unitId,
      })
      .strict()
      .nullable(),
    geography: z
      .object({
        mode: z.enum(['remote', 'hybrid', 'onsite']).nullable(),
        countries: z.array(z.string().regex(/^[A-Z]{2}$/u)).max(25),
        worldwide: z.boolean(),
        unitId,
      })
      .strict()
      .nullable(),
    ledger: z
      .array(
        z
          .object({
            id: unitId,
            kind: z.enum(['requirement', 'preferred', 'context', 'unresolved']),
            groups: z.array(group).max(12),
          })
          .strict(),
      )
      .max(MATCHING_SOURCE_SEMANTIC_UNIT_LIMIT),
  })
  .strict();
const verification = z
  .object({
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    proposalDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    roleCorrect: z.boolean(),
    geographyCorrect: z.boolean(),
    units: z
      .array(
        z
          .object({
            id: unitId,
            classificationCorrect: z.boolean(),
            allConditionsRepresented: z.boolean(),
            logicAndQualifiersPreserved: z.boolean(),
          })
          .strict(),
      )
      .max(MATCHING_SOURCE_SEMANTIC_UNIT_LIMIT),
  })
  .strict();
const decisionIdentifier = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_./:-]{0,127}$/u);
const decisionProfile = z.strictObject({
  provider: z.enum(['typesafe', 'laya']),
  transport: z.enum(['direct', 'bifrost']),
  model: decisionIdentifier,
  revision: decisionIdentifier,
  maxInputBytes: z.number().int().min(256).max(8192),
  preparationVersion: decisionIdentifier,
});
export type MatchingSourceDecisionProfile = z.infer<typeof decisionProfile>;
const capabilityGap = z.strictObject({
  unitId,
  qualifier: z.enum([
    'scale',
    'depth',
    'production',
    'illustrative',
    'unmapped',
    'scope',
  ]),
  conceptIds: z.array(z.string().min(1).max(100)).max(8),
});
export type MatchingSourceDecisionCapabilityGap = z.infer<typeof capabilityGap>;
const sourceBlock = z.strictObject({
  anchorId: unitId,
  unitIds: z.array(unitId).min(3).max(9),
  kind: z.enum(['requirement', 'preferred']),
  operator: z.enum(['all', 'any']),
});
export type MatchingSourceDecisionBlock = z.infer<typeof sourceBlock>;
const decisionProvenance = decisionProfile.extend({
  observedModels: z.array(decisionIdentifier).min(1).max(16),
  assessmentVersion: z.literal(1).optional(),
  blocks: z.array(sourceBlock).max(16).optional(),
  capabilityGaps: z.array(capabilityGap).max(MAX_ATOMS).optional(),
  structures: z
    .record(
      z.string().regex(/^d[1-9]\d{0,2}$/u),
      z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u),
    )
    .optional(),
  diagnostics: z
    .strictObject({
      draftCalls: z.number().int().min(0).max(100),
      draftFailures: z.number().int().min(1).max(100).optional(),
      assessedGaps: z.number().int().min(1).max(MAX_ATOMS).optional(),
      verifiedBlocks: z.number().int().min(1).max(16).optional(),
      verificationCalls: z.number().int().min(0).max(100),
      unasked: z.number().int().min(0).max(MATCHING_SOURCE_SEMANTIC_UNIT_LIMIT),
      declined: z
        .number()
        .int()
        .min(0)
        .max(MATCHING_SOURCE_SEMANTIC_UNIT_LIMIT),
      failed: z.number().int().min(0).max(MATCHING_SOURCE_SEMANTIC_UNIT_LIMIT),
      verified: z
        .number()
        .int()
        .min(0)
        .max(MATCHING_SOURCE_SEMANTIC_UNIT_LIMIT),
      classificationPasses: z
        .number()
        .int()
        .min(0)
        .max(MATCHING_SOURCE_SEMANTIC_UNIT_LIMIT)
        .optional(),
      coveragePasses: z
        .number()
        .int()
        .min(0)
        .max(MATCHING_SOURCE_SEMANTIC_UNIT_LIMIT)
        .optional(),
      logicPasses: z
        .number()
        .int()
        .min(0)
        .max(MATCHING_SOURCE_SEMANTIC_UNIT_LIMIT)
        .optional(),
      rolePasses: z.number().int().min(0).max(1).optional(),
      geographyPasses: z.number().int().min(0).max(1).optional(),
    })
    .optional(),
});
const proof = z
  .object({
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    proposal,
    verification,
    decision: decisionProvenance.optional(),
  })
  .strict();

export type MatchingSourceSemanticProposal = z.infer<typeof proposal>;
export type MatchingSourceSemanticProof = z.infer<typeof proof>;

const ontology = compileMatchingVocabulary(SKILL_VOCABULARY_SEED_TERMS);
const concepts = [...ontology.labels].map(([id, label]) => ({
  id,
  label,
  ...(ontology.definitions.has(id)
    ? { scope: ontology.definitions.get(id) }
    : {}),
  ...(ontology.qualitative.has(id) ? { qualitative: true } : {}),
}));
const { roles, levels } = matchingSourceRoleInventory;
const roleFamilies = [...new Set(roles.map(({ family }) => family))];
const specialties = [
  ...new Set(roles.flatMap(({ specialty }) => specialty ?? [])),
];

function transportSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _metaSchema, ...result } = z.toJSONSchema(schema);
  return result;
}

/** Give the gateway the same bounded IDs checked again after transport. */
export function matchingSourceSemanticProposalSchema(
  material: ReturnType<typeof matchingSourceSemanticMaterial>,
) {
  const ids = material.units.map(({ id }) => id);
  const exactId = z.enum(ids);
  const leaf = atom.extend({
    conceptId: z.enum(concepts.map(({ id }) => id)).nullable(),
  });
  const ledgerUnit = proposal.shape.ledger.element;
  const interpretedGroup = group.extend({
    alternatives: z.array(leaf).min(1).max(8),
  });
  const contextUnit = ledgerUnit.extend({
    id: exactId,
    kind: z.enum(['context', 'unresolved']),
    // No items are possible on this branch. Repeating the full concept enum
    // in an unreachable item schema consumes the governed input budget.
    groups: z.array(z.string()).max(0),
  });
  const predicateUnit = ledgerUnit.extend({
    id: z.enum(
      material.units
        .filter(({ field }) => field === 'description')
        .map(({ id }) => id),
    ),
    kind: z.enum(['requirement', 'preferred']),
    groups: z.array(interpretedGroup).min(1).max(12),
  });
  return transportSchema(
    proposal.extend({
      role: proposal.shape.role
        .unwrap()
        .extend({
          family: z.enum(roleFamilies),
          specialty: z.enum(specialties).nullable(),
          unitId: z.enum(
            material.units
              .filter(({ field }) => field !== 'location')
              .map(({ id }) => id),
          ),
        })
        .nullable(),
      geography: proposal.shape.geography
        .unwrap()
        .extend({
          countries: z.array(z.enum([...onboardingCountryCodes])).max(25),
          unitId: z.enum(
            material.units
              .filter(({ field }) => field !== 'title')
              .map(({ id }) => id),
          ),
        })
        .nullable(),
      ledger: z.array(z.union([contextUnit, predicateUnit])).length(ids.length),
    }),
  );
}

export function matchingSourceSemanticVerificationSchema(
  material: ReturnType<typeof matchingSourceSemanticMaterial>,
) {
  const ids = material.units.map(({ id }) => id);
  return transportSchema(
    verification.extend({
      units: z
        .array(verification.shape.units.element.extend({ id: z.enum(ids) }))
        .length(ids.length),
    }),
  );
}

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export const matchingSourceSemanticOntologyDigest = digest([
  concepts,
  roles,
  levels,
]);

export function matchingSourceSemanticMaterial(source: MatchingSourceText) {
  const units = matchingSourceSemanticUnits(source);
  const sectionHints = matchingSourceSectionHints(source.description);
  return {
    sourceDigest: digest([source.title, source.description, source.location]),
    units: units.map(({ id, field, quote, start }) => ({
      id,
      field,
      quote,
      ...(field === 'description' ? sectionHints.get(start) : undefined),
    })),
    concepts,
    rolePairs: roles.map(({ family, specialty }) => ({
      family,
      specialty: specialty ?? null,
    })),
    levels,
  };
}

export class MatchingSourceSemanticError extends Error {
  constructor(
    readonly reason:
      | 'unit_set'
      | 'predicate'
      | 'concept'
      | 'role'
      | 'geography'
      | 'digest',
  ) {
    super(`Invalid public source interpretation: ${reason}.`);
  }
}

function assertExactUnitSet(ids: string[], sourceIds: ReadonlySet<string>) {
  if (
    ids.length !== sourceIds.size ||
    new Set(ids).size !== sourceIds.size ||
    ids.some((id) => !sourceIds.has(id))
  )
    throw new MatchingSourceSemanticError('unit_set');
}

export function parseMatchingSourceSemanticProposal(
  value: unknown,
  source: MatchingSourceText,
): MatchingSourceSemanticProposal {
  const parsed = proposal.parse(value);
  const units = matchingSourceSemanticUnits(source);
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  assertExactUnitSet(
    parsed.ledger.map(({ id }) => id),
    new Set(byId.keys()),
  );
  const claims = parsed.ledger.flatMap(({ id, kind, groups }) => {
    const predicates = groups.flatMap(({ alternatives }) => alternatives);
    if (
      (kind === 'requirement' || kind === 'preferred') !==
        Boolean(predicates.length) ||
      (predicates.length > 0 && byId.get(id)?.field !== 'description')
    )
      throw new MatchingSourceSemanticError('predicate');
    return predicates;
  });
  if (
    claims.length > MAX_ATOMS ||
    claims.some(({ conceptId }) => conceptId && !ontology.labels.has(conceptId))
  )
    throw new MatchingSourceSemanticError('concept');
  const role = parsed.role;
  if (
    role &&
    (byId.get(role.unitId)?.field === 'location' ||
      !byId.has(role.unitId) ||
      !roles.some(
        ({ family, specialty }) =>
          family === role.family && (specialty ?? null) === role.specialty,
      ))
  )
    throw new MatchingSourceSemanticError('role');
  const geography = parsed.geography;
  if (
    geography &&
    (!byId.has(geography.unitId) ||
      byId.get(geography.unitId)?.field === 'title' ||
      (geography.worldwide
        ? geography.mode !== 'remote' || geography.countries.length > 0
        : !geography.countries.length ||
          geography.countries.some(
            (code) => !onboardingCountryCodes.has(code),
          ) ||
          new Set(geography.countries).size !== geography.countries.length))
  )
    throw new MatchingSourceSemanticError('geography');
  // Canonicalize row order so both invocations bind the same host unit set.
  const byLedgerId = new Map(parsed.ledger.map((unit) => [unit.id, unit]));
  return {
    ...parsed,
    ledger: units.map(
      ({ id }) => byLedgerId.get(id) as (typeof parsed.ledger)[number],
    ),
  };
}

export function matchingSourceSemanticProposalDigest(
  value: MatchingSourceSemanticProposal,
) {
  return digest(value);
}

export function verifyMatchingSourceSemanticProposal(
  value: unknown,
  source: MatchingSourceText,
  draft: MatchingSourceSemanticProposal,
): MatchingSourceSemanticProof {
  const sourceDigest = digest([
    source.title,
    source.description,
    source.location,
  ]);
  const parsed = parseMatchingSourceSemanticProposal(draft, source);
  const report = verification.parse(value);
  assertExactUnitSet(
    report.units.map(({ id }) => id),
    new Set(parsed.ledger.map(({ id }) => id)),
  );
  if (
    report.sourceDigest !== sourceDigest ||
    report.proposalDigest !== matchingSourceSemanticProposalDigest(parsed)
  )
    throw new MatchingSourceSemanticError('digest');
  return { sourceDigest, proposal: parsed, verification: report };
}

export function parseMatchingSourceSemanticProof(
  value: unknown,
  source: MatchingSourceText,
) {
  const parsed = proof.parse(value);
  const verified = verifyMatchingSourceSemanticProposal(
    parsed.verification,
    source,
    parsed.proposal,
  );
  const units = new Map(
    matchingSourceSemanticUnits(source).map((unit) => [unit.id, unit]),
  );
  const ledger = new Map(
    verified.proposal.ledger.map((unit) => [unit.id, unit]),
  );
  const reviewed = new Set(
    verified.verification.units
      .filter(
        (unit) =>
          unit.classificationCorrect &&
          unit.allConditionsRepresented &&
          unit.logicAndQualifiersPreserved,
      )
      .map(({ id }) => id),
  );
  if (
    parsed.decision &&
    (Boolean(parsed.decision.assessmentVersion) !==
      Boolean(parsed.decision.blocks) ||
      Boolean(parsed.decision.assessmentVersion) !==
        Boolean(parsed.decision.capabilityGaps))
  )
    throw new MatchingSourceSemanticError('predicate');
  const gapIds = new Set<string>();
  for (const gap of parsed.decision?.capabilityGaps ?? []) {
    const unit = units.get(gap.unitId);
    const entry = ledger.get(gap.unitId);
    const known = new Set(
      entry?.groups.flatMap(({ alternatives }) =>
        alternatives.flatMap(({ conceptId }) => (conceptId ? [conceptId] : [])),
      ),
    );
    if (
      unit?.field !== 'description' ||
      !entry ||
      !reviewed.has(gap.unitId) ||
      (entry.kind !== 'requirement' && entry.kind !== 'preferred') ||
      gapIds.has(gap.unitId) ||
      !matchingSourceCapabilityGapAllowed(unit.quote, gap.qualifier) ||
      gap.conceptIds.length !== new Set(gap.conceptIds).size ||
      gap.conceptIds.some((conceptId) => !known.has(conceptId))
    )
      throw new MatchingSourceSemanticError('predicate');
    gapIds.add(gap.unitId);
  }
  if (parsed.decision?.blocks) {
    const expected = new Map(
      matchingSourceJevBlocks(
        source,
        matchingSourceSectionHints(source.description),
      ).map((block) => [block.anchorId, block]),
    );
    const claimed = new Set<string>();
    for (const block of parsed.decision.blocks) {
      const original = expected.get(block.anchorId);
      if (
        !original ||
        original.kind !== block.kind ||
        original.operator !== block.operator ||
        original.unitIds.join(',') !== block.unitIds.join(',') ||
        ledger.get(block.anchorId)?.kind !== 'context' ||
        block.unitIds.some((id) => !reviewed.has(id) || claimed.has(id)) ||
        block.unitIds.slice(1).some((id) => {
          const entry = ledger.get(id);
          const atom = entry?.groups[0]?.alternatives[0];
          return (
            entry?.kind !== block.kind ||
            (!gapIds.has(id) &&
              (entry.groups.length !== 1 ||
                entry.groups[0]?.alternatives.length !== 1 ||
                !atom?.conceptId ||
                atom.unsupportedQualifier))
          );
        })
      )
        throw new MatchingSourceSemanticError('predicate');
      for (const id of block.unitIds) claimed.add(id);
    }
  }
  if (parsed.decision?.structures) {
    for (const [id, structure] of Object.entries(parsed.decision.structures)) {
      const unit = units.get(id);
      const entry = ledger.get(id);
      if (
        unit?.field !== 'description' ||
        !entry ||
        (entry.kind !== 'requirement' && entry.kind !== 'preferred') ||
        !matchingSourceStructureMatches(unit.quote, structure, entry.groups)
      )
        throw new MatchingSourceSemanticError('predicate');
    }
  }
  if (parsed.sourceDigest !== verified.sourceDigest)
    throw new MatchingSourceSemanticError('digest');
  return parsed.decision
    ? { ...verified, decision: parsed.decision }
    : verified;
}
