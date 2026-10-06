import { createHash } from 'node:crypto';
import {
  type CoverageLedger,
  type RequirementCoverageContext,
  validateRequirementCoverageAuditAdmission,
} from './opportunity-requirement-coverage.js';

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

export const QUARANTINED_SOURCE_COVERAGE_VERSION =
  'requirement-coverage-partial-recovery/v3-quarantined-rows';
export interface QuarantinedSourceCoverage {
  version: typeof QUARANTINED_SOURCE_COVERAGE_VERSION;
  originalLedgerFingerprint: string;
  /** Immutable original rows, citation links and exact source manifest. */
  ledger: CoverageLedger;
  quarantinedRequirementIds: string[];
  unresolvedClauses: Array<{
    clauseId: string;
    originalRequirementIds: string[];
    reason:
      | 'broken_reciprocal_requirement_mapping'
      | 'unresolved_clause_disposition'
      | 'unsupported_nonrequirement_exclusion'
      | 'unmapped_material_clause';
  }>;
  fingerprint: string;
}

/** Explicit partial-only view. Bad reciprocal edges quarantine the entire row;
 * no citation link, disposition label, source span or original row is repaired.
 * The caller must independently attest the completed GLOBAL extraction and its
 * original fingerprint before preparing a versioned source evidence request.
 */
export function quarantinePartialRequirementCoverageFromCompletedExtraction(
  context: RequirementCoverageContext,
  original: CoverageLedger,
): QuarantinedSourceCoverage | undefined {
  if (
    context.extractionContract !== 'current' ||
    original.audit !== undefined ||
    original.repair !== undefined
  )
    return undefined;
  const admission = validateRequirementCoverageAuditAdmission(
    context,
    original,
  );
  if (
    admission.structuralComplete ||
    !admission.errors.length ||
    admission.pendingContextClauseIds.length
  )
    return undefined;
  const expectedErrors: string[] = [];
  const quarantined = new Set<string>();
  const unresolved = new Map<
    string,
    QuarantinedSourceCoverage['unresolvedClauses'][number]
  >();
  const clauses = new Map(
    original.clauses.map((clause) => [clause.id, clause]),
  );
  const rows = new Map(original.requirements.map((row) => [row.id, row]));
  const dispositions = new Map(
    original.dispositions.map((row) => [row.clauseId, row]),
  );
  const retain = (
    clauseId: string,
    reason: QuarantinedSourceCoverage['unresolvedClauses'][number]['reason'],
  ) => {
    const disposition = dispositions.get(clauseId);
    if (!disposition) return;
    unresolved.set(clauseId, {
      clauseId,
      originalRequirementIds: [...disposition.requirementIds],
      reason,
    });
  };
  for (const [index, clause] of original.clauses.entries()) {
    const disposition = original.dispositions[index];
    if (
      !disposition ||
      disposition.clauseId !== clause.id ||
      disposition.auditPending !== undefined
    )
      return undefined;
    const exclusion = `Unsupported nonrequirement exclusion: ${clause.id}.`;
    const unmapped = `Material source clause has no lossless mapped requirement: ${clause.id}.`;
    const unknown = `Unresolved clause disposition: ${clause.id}.`;
    if (admission.errors.includes(exclusion)) {
      if (
        disposition.type !== 'nonrequirement' ||
        disposition.requirementIds.length
      )
        return undefined;
      expectedErrors.push(exclusion);
      retain(clause.id, 'unsupported_nonrequirement_exclusion');
    } else if (admission.errors.includes(unmapped)) {
      if (
        !['material_requirement', 'role_duty', 'role_context'].includes(
          disposition.type,
        ) ||
        disposition.requirementIds.length ||
        disposition.exclusionRule !== undefined
      )
        return undefined;
      expectedErrors.push(unmapped);
      retain(clause.id, 'unmapped_material_clause');
    } else if (admission.errors.includes(unknown)) {
      if (
        disposition.type !== 'unknown' ||
        disposition.requirementIds.length ||
        disposition.exclusionRule !== undefined
      )
        return undefined;
      expectedErrors.push(unknown);
      retain(clause.id, 'unresolved_clause_disposition');
    }
    for (const id of disposition.requirementIds) {
      const row = rows.get(id);
      if (!row) return undefined;
      if (row.clauseIds.includes(clause.id)) continue;
      expectedErrors.push(
        `Broken reciprocal requirement mapping: ${clause.id}/${id}.`,
      );
      quarantined.add(id);
      retain(clause.id, 'broken_reciprocal_requirement_mapping');
    }
  }
  for (const row of original.requirements) {
    for (const clauseId of row.clauseIds) {
      if (!clauses.has(clauseId)) return undefined;
      if (dispositions.get(clauseId)?.requirementIds.includes(row.id)) continue;
      expectedErrors.push(
        `Requirement lacks a reciprocal disposition: ${row.id}/${clauseId}.`,
      );
      quarantined.add(row.id);
      retain(clauseId, 'broken_reciprocal_requirement_mapping');
    }
  }
  if (
    !unresolved.size ||
    admission.errors.length !== expectedErrors.length ||
    admission.errors.some((error) => !expectedErrors.includes(error)) ||
    admission.uncoveredClauseIds.some((id) => !unresolved.has(id)) ||
    !original.requirements.some(
      (row) =>
        !quarantined.has(row.id) &&
        row.clauseIds.every((id) =>
          dispositions.get(id)?.requirementIds.includes(row.id),
        ),
    )
  )
    return undefined;
  const ledger = structuredClone(original);
  const { audit: _audit, ...originalMaterial } = original;
  const originalLedgerFingerprint = hash(JSON.stringify(originalMaterial));
  const material: Omit<QuarantinedSourceCoverage, 'fingerprint'> = {
    version: QUARANTINED_SOURCE_COVERAGE_VERSION,
    originalLedgerFingerprint,
    ledger,
    quarantinedRequirementIds: original.requirements
      .filter((row) => quarantined.has(row.id))
      .map((row) => row.id),
    unresolvedClauses: original.clauses.flatMap((clause) => {
      const entry = unresolved.get(clause.id);
      return entry ? [entry] : [];
    }),
  };
  return { ...material, fingerprint: hash(JSON.stringify(material)) };
}
