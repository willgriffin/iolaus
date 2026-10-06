import { createHash } from 'node:crypto';
import {
  OPPORTUNITY_EXTRACTION_PROMPT_VERSION,
  OPPORTUNITY_EXTRACTION_SCHEMA_VERSION,
} from './opportunity-posting-preparation.js';
import { opportunityWithSourceContent } from './opportunity-source-content.js';

export const REQUIREMENT_COVERAGE_VERSION = 'requirement-coverage/v1';
/** A separate read view for exact introductory duty links in an actual extraction. */
export const RECOVERABLE_PARTIAL_COVERAGE_VERSION =
  'requirement-coverage-partial-recovery/v1-intro-duty-link';
/** Partial-only view that retains unsupported nonrequirement exclusions as unresolved. */
export const RECOVERABLE_CAPTURED_SOURCE_COVERAGE_VERSION =
  'requirement-coverage-partial-recovery/v2-captured-source-unresolved';
export const REQUIREMENT_COVERAGE_REPAIR_VERSION =
  'requirement-coverage-repair/v1-delta4096';
export const REQUIREMENT_COVERAGE_SOURCE_CONTRACT_VERSION =
  'requirement-coverage-source/v6-candidate-context4096-exact-headings';
export const REQUIREMENT_COVERAGE_EXTRACTION_PROMPT_VERSION = `${OPPORTUNITY_EXTRACTION_PROMPT_VERSION}/requirement-coverage-v5-candidate-context4096-exact-headings`;
export const REQUIREMENT_COVERAGE_EXTRACTION_SCHEMA_VERSION = `${OPPORTUNITY_EXTRACTION_SCHEMA_VERSION}/requirement-coverage-v5-candidate-context4096-exact-headings`;
export const REQUIREMENT_COVERAGE_PAID_V4_SOURCE_CONTRACT_VERSION =
  'requirement-coverage-source/v4-coverage-only4096';
export const REQUIREMENT_COVERAGE_PAID_V4_PROMPT_VERSION =
  'opportunity-extraction/v2/requirement-coverage-v3-only4096';
export const REQUIREMENT_COVERAGE_PAID_V4_SCHEMA_VERSION =
  'opportunity-extraction-output/v1/requirement-coverage-v3-only4096';
export type RequirementCoverageExtractionContract =
  | 'current'
  | 'paid-v4-coverage-only4096';
export interface RequirementCoverageContext {
  /** Historical paid receipts retain the parser used for their extraction. */
  extractionContract?: RequirementCoverageExtractionContract;
  sourceText: string;
  sourceFingerprint: string;
  sourceVersion: number;
  extractionFingerprint: string;
  preparedFingerprint?: string;
}
export interface PostingClause {
  id: string;
  section: string;
  kind: 'heading' | 'body';
  /** JavaScript UTF-16 offsets into the unchanged captured sourceText. */
  spanStart: number;
  spanEnd: number;
  text: string;
  hash: string;
}
export interface CoverageRequirement {
  id: string;
  text: string;
  clauseIds: string[];
  importance: 'required' | 'preferred' | 'unknown';
}
export interface CoverageDisposition {
  clauseId: string;
  type:
    | 'material_requirement'
    | 'role_duty'
    | 'role_context'
    | 'source_context'
    | 'nonrequirement'
    | 'unknown';
  requirementIds: string[];
  exclusionRule?: string;
  /** Unresolved context may enter a literal audit; this is never proof. */
  auditPending?: 'nonmaterial';
}
export interface CoverageLedger {
  version: typeof REQUIREMENT_COVERAGE_VERSION;
  sourceFingerprint: string;
  sourceVersion: number;
  extractionFingerprint: string;
  preparedFingerprint?: string;
  clauses: PostingClause[];
  requirements: CoverageRequirement[];
  dispositions: CoverageDisposition[];
  repair?: CoverageRepairProvenance;
  audit?: {
    version: 'requirement-coverage-audit/v6-direct-literal';
    answerProbabilities: Record<string, number>;
    requestFingerprint: string;
    ledgerFingerprint: string;
    sourceFingerprint: string;
    extractionFingerprint: string;
    requestId: string;
    probabilities: Record<string, number>;
    importance: Record<string, 'required' | 'preferred' | 'unknown'>;
    importanceProbabilities: Record<string, number>;
    deterministicHeadingClauseIds: string[];
    fingerprint: string;
  };
}

export interface RecoverablePartialCoverage {
  version: typeof RECOVERABLE_PARTIAL_COVERAGE_VERSION;
  /** Fingerprint of the original native extraction ledger, excluding audit cache. */
  originalLedgerFingerprint: string;
  /** All original source clauses and atomic rows, with only invalid links removed. */
  ledger: CoverageLedger;
  unresolvedClauses: Array<{
    clauseId: string;
    originalRequirementIds: string[];
    reason: 'nonreciprocal_introductory_duty_link';
  }>;
  fingerprint: string;
}

export interface RecoverableCapturedSourceCoverage {
  version: typeof RECOVERABLE_CAPTURED_SOURCE_COVERAGE_VERSION;
  originalLedgerFingerprint: string;
  /** The original manifest and rows; only invalid introductory links may be removed. */
  ledger: CoverageLedger;
  unresolvedClauses: Array<{
    clauseId: string;
    originalRequirementIds: string[];
    reason:
      | 'nonreciprocal_introductory_duty_link'
      | 'unsupported_nonrequirement_exclusion'
      | 'unmapped_material_clause';
  }>;
  fingerprint: string;
}

export interface CoverageRepairProvenance {
  version: typeof REQUIREMENT_COVERAGE_REPAIR_VERSION;
  baseExtractionFingerprint: string;
  baseLedgerFingerprint: string;
  baseRequestId: string;
  feedbackAuditFingerprint: string;
  feedbackRequestId: string;
  targetClauseIds: string[];
  inputFingerprint: string;
  inputTokenCeiling: number;
  maxOutputTokens: number;
  removedRequirementIds: string[];
}
export interface RequirementCoverageRepairFeedback {
  sourceFingerprint: string;
  sourceVersion: number;
  extractionFingerprint: string;
  auditInputFingerprint: string;
  requestId: string;
  probabilities: Record<string, number>;
}
export interface PreparedRequirementCoverageRepair {
  context: RequirementCoverageContext;
  base: CoverageLedger;
  provenance: CoverageRepairProvenance;
}

/** Recheck a server-attested preparation against fresh canonical source before
 * reserving a provider request; a changed target or base cannot reuse its key.
 */
export function validatePreparedRequirementCoverageRepair(
  context: RequirementCoverageContext,
  prepared: PreparedRequirementCoverageRepair,
): boolean {
  const p = prepared.provenance;
  if (
    !validateRequirementCoverageAuditAdmission(context, prepared.base)
      .structuralComplete ||
    prepared.context.sourceText !== context.sourceText ||
    prepared.context.extractionFingerprint !== context.extractionFingerprint ||
    p.version !== REQUIREMENT_COVERAGE_REPAIR_VERSION ||
    p.baseExtractionFingerprint !== context.extractionFingerprint ||
    p.inputTokenCeiling !== 6000 ||
    p.maxOutputTokens !== 4096 ||
    !identifiers(p.targetClauseIds) ||
    !p.targetClauseIds.length ||
    p.targetClauseIds.some(
      (id) =>
        !prepared.base.clauses.some(
          (clause) => clause.id === id && clause.kind === 'body',
        ),
    ) ||
    !identifier(p.baseRequestId) ||
    !identifier(p.feedbackRequestId) ||
    !identifier(p.feedbackAuditFingerprint) ||
    p.removedRequirementIds.length
  )
    return false;
  const { audit: _audit, ...baseMaterial } = prepared.base;
  const seed = {
    version: p.version,
    sourceFingerprint: context.sourceFingerprint,
    sourceVersion: context.sourceVersion,
    preparedFingerprint: context.preparedFingerprint,
    baseExtractionFingerprint: context.extractionFingerprint,
    baseLedgerFingerprint: hash(JSON.stringify(baseMaterial)),
    baseRequestId: p.baseRequestId,
    feedbackAuditFingerprint: p.feedbackAuditFingerprint,
    feedbackRequestId: p.feedbackRequestId,
    targetClauseIds: p.targetClauseIds,
    inputTokenCeiling: p.inputTokenCeiling,
    maxOutputTokens: p.maxOutputTokens,
  };
  return (
    p.baseLedgerFingerprint === seed.baseLedgerFingerprint &&
    p.inputFingerprint === hash(JSON.stringify(seed))
  );
}

/** Pure preparation, not receipt authority. The runtime must first resolve the
 * completed global base request and failed literal audit from native storage.
 */
export function prepareRequirementCoverageRepair(
  context: RequirementCoverageContext,
  base: CoverageLedger,
  baseRequestId: string,
  feedback: RequirementCoverageRepairFeedback,
  targetClauseIds: string[],
  delivery: { inputTokenCeiling: number; maxOutputTokens: number },
): PreparedRequirementCoverageRepair {
  if (
    !validateRequirementCoverageAuditAdmission(context, base)
      .structuralComplete ||
    !identifier(baseRequestId) ||
    !identifier(feedback.requestId) ||
    !identifier(feedback.auditInputFingerprint) ||
    feedback.sourceFingerprint !== context.sourceFingerprint ||
    feedback.sourceVersion !== context.sourceVersion ||
    feedback.extractionFingerprint !== context.extractionFingerprint ||
    base.clauses.some(
      (clause) =>
        clause.kind === 'body' &&
        !Object.hasOwn(feedback.probabilities, clause.id),
    ) ||
    !identifiers(targetClauseIds) ||
    !targetClauseIds.length ||
    targetClauseIds.some(
      (id) =>
        !base.clauses.some(
          (clause) => clause.id === id && clause.kind === 'body',
        ),
    ) ||
    delivery.inputTokenCeiling !== 6000 ||
    delivery.maxOutputTokens !== 4096
  ) {
    throw new Error(
      'Source repair requires exact current source, base receipt, feedback identity and bounded body targets.',
    );
  }
  for (const [id, probability] of Object.entries(feedback.probabilities)) {
    if (
      !base.clauses.some((clause) => clause.id === id) ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1
    )
      throw new Error('Invalid source repair literal audit feedback.');
  }
  const { audit: _audit, ...baseMaterial } = base;
  const seed = {
    version:
      REQUIREMENT_COVERAGE_REPAIR_VERSION as typeof REQUIREMENT_COVERAGE_REPAIR_VERSION,
    sourceFingerprint: context.sourceFingerprint,
    sourceVersion: context.sourceVersion,
    preparedFingerprint: context.preparedFingerprint,
    baseExtractionFingerprint: context.extractionFingerprint,
    baseLedgerFingerprint: hash(JSON.stringify(baseMaterial)),
    baseRequestId,
    feedbackAuditFingerprint: feedback.auditInputFingerprint,
    feedbackRequestId: feedback.requestId,
    targetClauseIds,
    ...delivery,
  };
  return {
    context: structuredClone(context),
    base: structuredClone(base),
    provenance: {
      ...seed,
      inputFingerprint: hash(JSON.stringify(seed)),
      removedRequirementIds: [],
    },
  };
}

/** A delta cannot rewrite surviving paid rows or silently drop non-target data.
 * Explicitly removed context rows remain in the immutable original receipt;
 * the independent audit must certify the complete merged candidate meaning.
 */
export function mergeRequirementCoverageRepair(
  prepared: PreparedRequirementCoverageRepair,
  output: unknown,
): CoverageLedger {
  const root = record(output);
  const proposal = record(root?.requirementCoverage);
  if (
    !root ||
    Object.keys(root).some((key) => key !== 'requirementCoverage') ||
    !proposal ||
    Object.keys(proposal).some(
      (key) =>
        !['requirements', 'dispositions', 'removedRequirementIds'].includes(
          key,
        ),
    ) ||
    !Array.isArray(proposal.requirements) ||
    !Array.isArray(proposal.dispositions) ||
    !identifiers(proposal.removedRequirementIds)
  )
    throw new Error('Invalid bounded source repair schema.');
  const targets = new Set(prepared.provenance.targetClauseIds);
  const delta = buildRequirementCoverage(prepared.context, [proposal]);
  const baseIds = new Set(prepared.base.requirements.map((row) => row.id));
  if (
    delta.requirements.some(
      (row) =>
        !record(row) ||
        !identifier(row.id) ||
        !identifiers(row.clauseIds) ||
        baseIds.has(row.id) ||
        row.clauseIds.some((id) => !targets.has(id)),
    )
  )
    throw new Error(
      'Source repair cannot replace paid rows or introduce non-target requirements.',
    );
  const aliases = new Map(
    prepared.base.clauses.map((clause, index) => [`c${index}`, clause.id]),
  );
  const explicitIds = proposal.dispositions.map((entry) => {
    const row = record(entry);
    return typeof row?.clauseId === 'string'
      ? (aliases.get(row.clauseId) ?? row.clauseId)
      : '';
  });
  if (!identifiers(explicitIds))
    throw new Error('Source repair dispositions must be explicit and unique.');
  const changed = delta.dispositions.filter((row) =>
    explicitIds.includes(row.clauseId),
  );
  if (
    changed.length !== proposal.dispositions.length ||
    changed.some((row) => !targets.has(row.clauseId) || row.type === 'unknown')
  )
    throw new Error(
      'Source repair cannot change non-target or unresolved dispositions.',
    );
  const changedIds = new Set(changed.map((row) => row.clauseId));
  const removed = new Set(proposal.removedRequirementIds);
  for (const id of removed) {
    const row = prepared.base.requirements.find((entry) => entry.id === id);
    if (
      !row ||
      row.clauseIds.some(
        (clauseId) => !targets.has(clauseId) || !changedIds.has(clauseId),
      ) ||
      changed.some((entry) => entry.requirementIds.includes(id))
    )
      throw new Error(
        'Context reclassification must be explicit and confined to updated source targets.',
      );
  }
  const ledger: CoverageLedger = {
    ...structuredClone(prepared.base),
    audit: undefined,
    requirements: [
      ...prepared.base.requirements.filter((row) => !removed.has(row.id)),
      ...delta.requirements,
    ],
    dispositions: prepared.base.dispositions.map(
      (row) => changed.find((entry) => entry.clauseId === row.clauseId) ?? row,
    ),
    repair: { ...prepared.provenance, removedRequirementIds: [...removed] },
  };
  const validation = validateRequirementCoverageAuditAdmission(
    prepared.context,
    ledger,
  );
  if (!validation.structuralComplete)
    throw new Error(
      `Source repair is incomplete: ${validation.errors.join(' ')}`,
    );
  return ledger;
}

/** Derive identity from captured/native source fields, never from a ledger. */
export function requirementCoverageContextForOpportunity(
  opportunity: Record<string, unknown>,
  contract: RequirementCoverageExtractionContract = 'current',
): RequirementCoverageContext {
  if (contract !== 'current' && contract !== 'paid-v4-coverage-only4096')
    throw new Error('Unknown source extraction contract.');
  const historical = contract === 'paid-v4-coverage-only4096';
  const source = opportunityWithSourceContent(opportunity);
  const sourceText =
    typeof source.descriptionRaw === 'string' && source.descriptionRaw.trim()
      ? source.descriptionRaw
      : '';
  const sourceFingerprint =
    typeof opportunity.sourceContentFingerprint === 'string'
      ? opportunity.sourceContentFingerprint
      : '';
  const sourceVersion = Number(opportunity.sourceContentVersion) || 0;
  const preparedFingerprint =
    typeof opportunity.preparedPostingFingerprint === 'string'
      ? opportunity.preparedPostingFingerprint
      : '';
  return {
    extractionContract: contract,
    sourceText,
    sourceFingerprint,
    sourceVersion,
    extractionFingerprint: hash(
      JSON.stringify({
        version: REQUIREMENT_COVERAGE_VERSION,
        sourceContractVersion: historical
          ? REQUIREMENT_COVERAGE_PAID_V4_SOURCE_CONTRACT_VERSION
          : REQUIREMENT_COVERAGE_SOURCE_CONTRACT_VERSION,
        sourceFingerprint,
        sourceVersion,
        preparedFingerprint,
        sourceTextHash: hash(sourceText),
        promptVersion: historical
          ? REQUIREMENT_COVERAGE_PAID_V4_PROMPT_VERSION
          : REQUIREMENT_COVERAGE_EXTRACTION_PROMPT_VERSION,
        schemaVersion: historical
          ? REQUIREMENT_COVERAGE_PAID_V4_SCHEMA_VERSION
          : REQUIREMENT_COVERAGE_EXTRACTION_SCHEMA_VERSION,
      }),
    ),
    ...(preparedFingerprint ? { preparedFingerprint } : {}),
  };
}

/** Short request-local citations; the durable ledger retains exact spans/hash. */
export function requirementCoverageExtractionClauses(ledger: CoverageLedger) {
  return ledger.clauses.map((clause, index) => ({
    id: `c${index}`,
    text: clause.text,
  }));
}

/** Native heading evidence, never a fabricated semantic probability. Every
 * field must match the exact captured source before any heading is certified.
 */
export function canonicalHeadingClauseIds(
  context: RequirementCoverageContext,
  value: unknown,
): string[] {
  const ledger = record(value);
  const canonical = buildRequirementCoverageSource(context);
  const clauses = ledger?.clauses;
  const dispositions = ledger?.dispositions;
  if (
    !ledger ||
    ledger.version !== canonical.version ||
    ledger.sourceFingerprint !== canonical.sourceFingerprint ||
    ledger.sourceVersion !== canonical.sourceVersion ||
    ledger.extractionFingerprint !== canonical.extractionFingerprint ||
    ledger.preparedFingerprint !== canonical.preparedFingerprint ||
    !Array.isArray(clauses) ||
    clauses.length !== canonical.clauses.length ||
    !identifier(context.sourceFingerprint) ||
    !identifier(context.extractionFingerprint) ||
    !Number.isSafeInteger(context.sourceVersion) ||
    context.sourceVersion < 1 ||
    canonical.clauses.some((clause, index) => {
      const stored = record(clauses[index]);
      return (
        !stored ||
        Object.keys(clause).some(
          (key) => stored[key] !== clause[key as keyof PostingClause],
        )
      );
    })
  )
    return [];
  return canonical.clauses
    .filter(
      (clause) =>
        clause.kind === 'heading' &&
        isPostingHeading(literalTextForPostingClause(clause), context) &&
        Array.isArray(dispositions) &&
        dispositions.filter((row) => record(row)?.clauseId === clause.id)
          .length === 1 &&
        dispositions.some((row) => {
          const disposition = record(row);
          return (
            disposition?.clauseId === clause.id &&
            disposition.type === 'nonrequirement' &&
            disposition.exclusionRule === 'section_heading' &&
            Array.isArray(disposition.requirementIds) &&
            disposition.requirementIds.length === 0 &&
            disposition.auditPending === undefined
          );
        }),
    )
    .map((clause) => clause.id);
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    value.trim() === value &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  );
}
function identifiers(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(identifier) &&
    new Set(value).size === value.length
  );
}

/** Display only. Ledger text and hashes always use the original raw slice. */
export function literalTextForPostingClause(
  clause: Pick<PostingClause, 'text'>,
): string {
  return clause.text
    .replace(/<[^>]*>/g, ' ')
    .replace(
      /&(?:amp|nbsp|quot|apos|lt|gt);/gi,
      (entity) =>
        ({
          '&amp;': '&',
          '&nbsp;': ' ',
          '&quot;': '"',
          '&apos;': "'",
          '&lt;': '<',
          '&gt;': '>',
        })[entity.toLowerCase()] ?? entity,
    )
    .replace(/\s+/g, ' ')
    .trim();
}
const LEGACY_HEADING =
  /^(?:about(?: the)? (?:role|team|company)|about us|who (?:you are|we are)|what you(?:'|’)ll (?:do|bring)|what we(?:'|’)re looking for|what we offer|(?:key )?responsibilities|(?:minimum |preferred |required )?(?:qualifications|requirements)|benefits|perks|compensation|salary|location|how to apply|equal opportunity)\s*:?[\s]*$/i;
const HEADING =
  /^(?:skills you bring|what will you do\?|about you|nice to have)\s*:?[\s]*$/i;
/** Current exact standalone heading grammar, without certifying a ledger. */
export function isCurrentPostingHeading(literal: string): boolean {
  return LEGACY_HEADING.test(literal) || HEADING.test(literal);
}
function isPostingHeading(
  literal: string,
  context?: RequirementCoverageContext,
) {
  return (
    LEGACY_HEADING.test(literal) ||
    (context?.extractionContract !== 'paid-v4-coverage-only4096' &&
      HEADING.test(literal))
  );
}
const NAVIGATION =
  /^(?:apply now|back to (?:jobs|openings)|privacy policy|cookie (?:policy|settings)|sign in|skip to (?:content|main))\s*[→›»]*$/i;
const EQUAL_OPPORTUNITY =
  /^(?:we are|[A-Za-z][A-Za-z &.-]{0,60} is) an equal opportunity employer\.?$/i;

/** Exhaustive nonempty raw blocks, including About/team prose and duplicates.
 * Block delimiters are structural markup/newlines, not semantic exclusions.
 * Inline markup/entities stay verbatim so offsets never refer to normalized text.
 */
export function buildPostingClauses(
  context: RequirementCoverageContext,
): PostingClause[] {
  const raw = context.sourceText;
  const clauses: PostingClause[] = [];
  let section = 'section:opening';
  const append = (from: number, to: number) => {
    const slice = raw.slice(from, to);
    const leading = slice.length - slice.trimStart().length;
    const trailing = slice.length - slice.trimEnd().length;
    const spanStart = from + leading;
    const spanEnd = to - trailing;
    if (spanEnd <= spanStart) return;
    const text = raw.slice(spanStart, spanEnd);
    const literal = literalTextForPostingClause({ text });
    if (!literal) return;
    const kind = isPostingHeading(literal, context) ? 'heading' : 'body';
    const id = `clause:${hash(`${context.sourceFingerprint}:${spanStart}:${spanEnd}:${text}`).slice(0, 24)}`;
    if (kind === 'heading') section = `section:${id.slice(7)}`;
    clauses.push({
      id,
      section,
      kind,
      spanStart,
      spanEnd,
      text,
      hash: hash(text),
    });
  };
  let start = 0;
  for (const match of raw.matchAll(
    /<\/?(?:p|div|h[1-6]|li|ul|ol|section|article|br|tr)\b[^>]*>|\r\n|\r|\n/gi,
  )) {
    const offset = match.index ?? 0;
    append(start, offset);
    start = offset + match[0].length;
  }
  append(start, raw.length);
  return clauses;
}

export function buildRequirementCoverageSource(
  context: RequirementCoverageContext,
): CoverageLedger {
  const clauses = buildPostingClauses(context);
  return {
    version: REQUIREMENT_COVERAGE_VERSION,
    sourceFingerprint: context.sourceFingerprint,
    sourceVersion: context.sourceVersion,
    extractionFingerprint: context.extractionFingerprint,
    ...(context.preparedFingerprint
      ? { preparedFingerprint: context.preparedFingerprint }
      : {}),
    clauses,
    requirements: [],
    dispositions: clauses.map((clause) =>
      clause.kind === 'heading'
        ? {
            clauseId: clause.id,
            type: 'nonrequirement',
            requirementIds: [],
            exclusionRule: 'section_heading',
          }
        : { clauseId: clause.id, type: 'unknown', requirementIds: [] },
    ),
  };
}

/** Only merge requirement/disposition proposals. Provider identity, source
 * spans, hashes and any provider-supplied audit verdict are never authoritative.
 */
export function buildRequirementCoverage(
  context: RequirementCoverageContext,
  outputs: readonly unknown[],
): CoverageLedger {
  const ledger = buildRequirementCoverageSource(context);
  const requirements: CoverageRequirement[] = [];
  const dispositions: CoverageDisposition[] = [];
  const seenRequirements = new Set<string>();
  const seenDispositions = new Set<string>();
  const aliases = new Map(
    ledger.clauses.map((clause, index) => [`c${index}`, clause.id]),
  );
  const canonicalId = (id: unknown) =>
    typeof id === 'string' ? (aliases.get(id) ?? id) : id;
  for (const output of outputs) {
    const root = record(output);
    const proposal = record(root?.requirementCoverage) ?? root;
    for (const rawRequirement of Array.isArray(proposal?.requirements)
      ? proposal.requirements
      : []) {
      const row = record(rawRequirement);
      const requirement =
        row && Array.isArray(row.clauseIds)
          ? { ...row, clauseIds: row.clauseIds.map(canonicalId) }
          : rawRequirement;
      const key = JSON.stringify(requirement);
      if (!seenRequirements.has(key)) {
        seenRequirements.add(key);
        requirements.push(requirement);
      }
    }
    for (const rawDisposition of Array.isArray(proposal?.dispositions)
      ? proposal.dispositions
      : []) {
      const row = record(rawDisposition);
      const disposition = row
        ? { ...row, clauseId: canonicalId(row.clauseId) }
        : rawDisposition;
      const key = JSON.stringify(disposition);
      if (!seenDispositions.has(key)) {
        seenDispositions.add(key);
        dispositions.push(disposition);
      }
    }
  }
  ledger.requirements = requirements;
  ledger.dispositions = ledger.clauses.flatMap((clause) => {
    const proposed = dispositions.filter(
      (entry) => record(entry)?.clauseId === clause.id,
    );
    return proposed.length
      ? proposed
      : ledger.dispositions.filter((entry) => entry.clauseId === clause.id);
  });
  // Unknown external clause references remain visible to the validator.
  ledger.dispositions.push(
    ...dispositions.filter(
      (entry) =>
        !ledger.clauses.some((clause) => clause.id === record(entry)?.clauseId),
    ),
  );
  return ledger;
}

function validExclusion(clause: PostingClause, rule: unknown): boolean {
  const text = literalTextForPostingClause(clause);
  // This rule only admits a proposal for independent literal audit. It cannot
  // establish semantic completeness on its own (see provider's verified gate).
  return (
    rule === 'literal_nonmaterial_audit' ||
    (rule === 'section_heading' &&
      clause.kind === 'heading' &&
      isPostingHeading(text)) ||
    (rule === 'navigation_label' && NAVIGATION.test(text)) ||
    (rule === 'equal_opportunity_statement' && EQUAL_OPPORTUNITY.test(text))
  );
}

/** Normalize proposal syntax only, retaining every literal clause and row.
 * Only the recorded nonmaterial suffix becomes an independent-audit question;
 * other invalid rules remain rejected. Empty context stays unresolved.
 */
export function normalizeRequirementCoverageForAudit(
  context: RequirementCoverageContext,
  ledger: CoverageLedger,
): CoverageLedger {
  const canonical = buildPostingClauses(context);
  return {
    ...ledger,
    audit: undefined,
    dispositions: ledger.dispositions.map((disposition) => {
      const clause = canonical.find(
        (entry) => entry.id === disposition.clauseId,
      );
      const stored = ledger.clauses.find(
        (entry) => entry.id === disposition.clauseId,
      );
      if (
        !clause ||
        !stored ||
        Object.keys(clause).some(
          (key) =>
            stored[key as keyof PostingClause] !==
            clause[key as keyof PostingClause],
        ) ||
        !Array.isArray(disposition.requirementIds)
      )
        return disposition;
      if (
        String(disposition.type) === 'section_heading' &&
        !disposition.requirementIds.length &&
        clause.kind === 'heading' &&
        isPostingHeading(literalTextForPostingClause(clause), context)
      ) {
        return {
          ...disposition,
          type: 'nonrequirement',
          exclusionRule: 'section_heading',
        };
      }
      if (
        disposition.type === 'nonrequirement' &&
        !disposition.requirementIds.length &&
        typeof disposition.exclusionRule === 'string' &&
        disposition.exclusionRule.trim() ===
          'literal_nonmaterial_audit pending independent verification'
      ) {
        return { ...disposition, exclusionRule: 'literal_nonmaterial_audit' };
      }
      if (
        disposition.type === 'role_context' &&
        clause.kind === 'body' &&
        !disposition.requirementIds.length
      ) {
        return { ...disposition, auditPending: 'nonmaterial' };
      }
      return disposition;
    }),
  };
}

/** Structural coverage only. The independent, source-only semantic audit must
 * additionally certify lossless mapped meaning before any private assessment.
 * A provider's summary, nonrequirement label or audit object is not proof.
 */
export function validateRequirementCoverage(
  context: RequirementCoverageContext,
  value: unknown,
): ReturnType<typeof validateCoverageStructure> {
  return validateCoverageStructure(context, value, false);
}

/** Audit admission only. A pending context still fails the strict validator,
 * and requires an independent literal no-material-omission verdict. */
export function validateRequirementCoverageAuditAdmission(
  context: RequirementCoverageContext,
  value: unknown,
): ReturnType<typeof validateCoverageStructure> {
  return validateCoverageStructure(context, value, true);
}

function validateCoverageStructure(
  context: RequirementCoverageContext,
  value: unknown,
  allowPendingContext: boolean,
): {
  complete: boolean;
  structuralComplete: boolean;
  errors: string[];
  uncoveredClauseIds: string[];
  pendingContextClauseIds: string[];
} {
  const errors: string[] = [];
  const pendingContextClauseIds: string[] = [];
  const canonical = buildRequirementCoverageSource(context);
  const uncovered = new Set(
    canonical.clauses
      .filter((clause) => clause.kind === 'body')
      .map((clause) => clause.id),
  );
  const ledger = record(value);
  const fail = (message: string) => {
    if (errors.length < 100) errors.push(message);
  };
  if (
    !identifier(context.sourceFingerprint) ||
    !identifier(context.extractionFingerprint) ||
    !Number.isSafeInteger(context.sourceVersion) ||
    context.sourceVersion < 1 ||
    !canonical.clauses.length
  )
    fail('Current captured source identity is required.');
  if (
    !ledger ||
    ledger.version !== REQUIREMENT_COVERAGE_VERSION ||
    ledger.sourceFingerprint !== context.sourceFingerprint ||
    ledger.sourceVersion !== context.sourceVersion ||
    ledger.extractionFingerprint !== context.extractionFingerprint ||
    ledger.preparedFingerprint !== canonical.preparedFingerprint
  )
    fail(
      'Coverage identity/version does not match the current source and extraction.',
    );
  const clauses = Array.isArray(ledger?.clauses) ? ledger.clauses : [];
  if (clauses.length !== canonical.clauses.length)
    fail('Coverage clause manifest is not exhaustive.');
  canonical.clauses.forEach((clause, index) => {
    const stored = record(clauses[index]);
    if (
      !stored ||
      Object.keys(clause).some(
        (key) => stored[key] !== clause[key as keyof PostingClause],
      )
    ) {
      fail(`Invalid exact source span/hash/identity: ${clause.id}.`);
    }
  });
  const requirements = Array.isArray(ledger?.requirements)
    ? ledger.requirements
    : [];
  const dispositions = Array.isArray(ledger?.dispositions)
    ? ledger.dispositions
    : [];
  const mapped = new Map<string, CoverageRequirement>();
  const clauseById = new Map(
    canonical.clauses.map((clause) => [clause.id, clause]),
  );
  let textBytes = 0;
  for (const entry of requirements) {
    const requirement = record(entry);
    if (
      !requirement ||
      !identifier(requirement.id) ||
      typeof requirement.text !== 'string' ||
      !requirement.text.trim() ||
      !identifiers(requirement.clauseIds) ||
      !requirement.clauseIds.length ||
      !['required', 'preferred', 'unknown'].includes(
        String(requirement.importance),
      )
    ) {
      fail('Malformed atomic requirement.');
      continue;
    }
    if (mapped.has(requirement.id))
      fail(`Duplicate requirement ID: ${requirement.id}.`);
    mapped.set(requirement.id, requirement as unknown as CoverageRequirement);
    textBytes += Buffer.byteLength(
      JSON.stringify(JSON.stringify(requirement.text)),
      'utf8',
    );
    for (const id of requirement.clauseIds)
      if (!clauseById.has(id))
        fail(`Requirement references unknown source clause: ${id}.`);
  }
  if (
    requirements.length > canonical.clauses.length * 2 ||
    textBytes >
      Buffer.byteLength(
        JSON.stringify(JSON.stringify(context.sourceText)),
        'utf8',
      ) *
        2
  ) {
    fail('Requirement ledger exceeds the lossless source admission bound.');
  }
  const seen = new Set<string>();
  const referenced = new Set<string>();
  let mappedOccurrences = 0;
  let mappedTextBytes = 0;
  for (const entry of dispositions) {
    const disposition = record(entry);
    if (
      !disposition ||
      !identifier(disposition.clauseId) ||
      !identifiers(disposition.requirementIds)
    ) {
      fail('Malformed clause disposition.');
      continue;
    }
    const clause = clauseById.get(disposition.clauseId);
    if (!clause) {
      fail(`Unknown disposition clause: ${disposition.clauseId}.`);
      continue;
    }
    if (seen.has(clause.id))
      fail(`Duplicate clause disposition: ${clause.id}.`);
    seen.add(clause.id);
    const type = disposition.type;
    const pendingContext =
      disposition.auditPending === 'nonmaterial' &&
      type === 'role_context' &&
      clause.kind === 'body' &&
      disposition.requirementIds.length === 0;
    if (disposition.auditPending !== undefined && !pendingContext)
      fail(`Invalid pending context marker: ${clause.id}.`);
    if (
      ![
        'material_requirement',
        'role_duty',
        'role_context',
        'source_context',
        'nonrequirement',
        'unknown',
      ].includes(String(type)) ||
      type === 'unknown'
    ) {
      fail(`Unresolved clause disposition: ${clause.id}.`);
      continue;
    }
    if (type === 'nonrequirement') {
      if (
        disposition.requirementIds.length ||
        !validExclusion(clause, disposition.exclusionRule)
      ) {
        fail(`Unsupported nonrequirement exclusion: ${clause.id}.`);
        continue;
      }
    } else if (type === 'source_context') {
      if (disposition.requirementIds.length) {
        fail(
          `Source context must not create candidate requirement rows: ${clause.id}.`,
        );
        continue;
      }
    } else if (
      !disposition.requirementIds.length &&
      !(allowPendingContext && pendingContext)
    ) {
      fail(
        `Material source clause has no lossless mapped requirement: ${clause.id}.`,
      );
      continue;
    }
    if (allowPendingContext && pendingContext)
      pendingContextClauseIds.push(clause.id);
    let valid = true;
    for (const id of disposition.requirementIds) {
      const requirement = mapped.get(id);
      if (!requirement?.clauseIds.includes(clause.id)) {
        fail(`Broken reciprocal requirement mapping: ${clause.id}/${id}.`);
        valid = false;
      } else {
        referenced.add(`${id}:${clause.id}`);
        mappedOccurrences += 1;
        mappedTextBytes += Buffer.byteLength(
          JSON.stringify(JSON.stringify(requirement.text)),
          'utf8',
        );
      }
    }
    if (valid) uncovered.delete(clause.id);
  }
  for (const clause of canonical.clauses)
    if (!seen.has(clause.id)) fail(`Missing clause disposition: ${clause.id}.`);
  for (const requirement of mapped.values())
    for (const id of requirement.clauseIds) {
      if (!referenced.has(`${requirement.id}:${id}`))
        fail(
          `Requirement lacks a reciprocal disposition: ${requirement.id}/${id}.`,
        );
    }
  if (
    mappedOccurrences > canonical.clauses.length * 2 ||
    mappedTextBytes >
      Buffer.byteLength(
        JSON.stringify(JSON.stringify(context.sourceText)),
        'utf8',
      ) *
        2
  ) {
    fail(
      'Repeated mapped source text exceeds the lossless source admission bound.',
    );
  }
  const complete = errors.length === 0 && uncovered.size === 0;
  return {
    complete,
    structuralComplete: complete,
    errors,
    uncoveredClauseIds: [...uncovered],
    pendingContextClauseIds,
  };
}

/**
 * A partial-only read view for a narrow extraction mistake: a colon-ended
 * introductory duty links to a row whose literal citation is solely the next
 * bullet. The intro stays explicitly unresolved; its link cannot certify the
 * row, and the original extraction ledger remains unchanged and unverified.
 * Callers must independently attest the actual current GLOBAL extraction
 * receipt and compare its original ledger fingerprint before using this view.
 */
export function recoverPartialRequirementCoverageFromCompletedExtraction(
  context: RequirementCoverageContext,
  original: CoverageLedger,
): RecoverablePartialCoverage | undefined {
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

  const unresolvedClauses: RecoverablePartialCoverage['unresolvedClauses'] = [];
  const expectedErrors: string[] = [];
  for (const [index, clause] of original.clauses.entries()) {
    const disposition = original.dispositions[index];
    if (disposition?.clauseId !== clause.id) return undefined;
    for (const requirementId of disposition.requirementIds) {
      const row = original.requirements.find(
        (candidate) => candidate.id === requirementId,
      );
      if (row?.clauseIds.includes(clause.id)) continue;
      const next = original.clauses[index + 1];
      const nextDisposition = original.dispositions[index + 1];
      if (
        !row ||
        disposition.type !== 'role_duty' ||
        disposition.requirementIds.length !== 1 ||
        disposition.exclusionRule !== undefined ||
        disposition.auditPending !== undefined ||
        clause.kind !== 'body' ||
        !/^[^\n•-][^\n]*:$/u.test(clause.text) ||
        !next ||
        next.kind !== 'body' ||
        next.section !== clause.section ||
        next.spanStart <= clause.spanEnd ||
        !/^[-•]\s+\S/u.test(next.text) ||
        row.clauseIds.length !== 1 ||
        row.clauseIds[0] !== next.id ||
        nextDisposition?.clauseId !== next.id ||
        nextDisposition.type !== 'role_duty' ||
        !nextDisposition.requirementIds.includes(requirementId)
      )
        return undefined;
      unresolvedClauses.push({
        clauseId: clause.id,
        originalRequirementIds: [requirementId],
        reason: 'nonreciprocal_introductory_duty_link',
      });
      expectedErrors.push(
        `Broken reciprocal requirement mapping: ${clause.id}/${requirementId}.`,
      );
    }
  }
  if (
    !unresolvedClauses.length ||
    admission.errors.length !== expectedErrors.length ||
    admission.errors.some((error) => !expectedErrors.includes(error)) ||
    admission.uncoveredClauseIds.length !== unresolvedClauses.length ||
    admission.uncoveredClauseIds.some(
      (id) => !unresolvedClauses.some((entry) => entry.clauseId === id),
    )
  )
    return undefined;

  const unresolvedIds = new Set(
    unresolvedClauses.map((entry) => entry.clauseId),
  );
  const ledger: CoverageLedger = {
    ...original,
    clauses: original.clauses.map((clause) => ({ ...clause })),
    requirements: original.requirements.map((row) => ({
      ...row,
      clauseIds: [...row.clauseIds],
    })),
    dispositions: original.dispositions.map((row) => ({
      ...row,
      requirementIds: unresolvedIds.has(row.clauseId)
        ? []
        : [...row.requirementIds],
    })),
  };
  const recoveredAdmission = validateRequirementCoverageAuditAdmission(
    context,
    ledger,
  );
  if (
    recoveredAdmission.structuralComplete ||
    recoveredAdmission.errors.length !== unresolvedClauses.length ||
    recoveredAdmission.errors.some(
      (error) =>
        !unresolvedClauses.some(
          (entry) =>
            error ===
            `Material source clause has no lossless mapped requirement: ${entry.clauseId}.`,
        ),
    )
  )
    return undefined;
  const { audit: _audit, ...originalMaterial } = original;
  const originalLedgerFingerprint = hash(JSON.stringify(originalMaterial));
  const version = RECOVERABLE_PARTIAL_COVERAGE_VERSION;
  return {
    version,
    originalLedgerFingerprint,
    ledger,
    unresolvedClauses,
    fingerprint: hash(
      JSON.stringify({
        version,
        originalLedgerFingerprint,
        ledger,
        unresolvedClauses,
      }),
    ),
  };
}

/**
 * Opt-in partial view over an attested completed extraction. An unsupported
 * nonrequirement exclusion or material clause with no mapped row remains
 * untouched and unresolved; neither is promoted to a heading, context, or
 * criterion. The sole mutable part is the narrow V1 introductory-duty link.
 * Callers must attest the actual current GLOBAL extraction receipt and its
 * original ledger fingerprint before using this view.
 */
export function recoverPartialRequirementCoverageFromCapturedSource(
  context: RequirementCoverageContext,
  original: CoverageLedger,
): RecoverableCapturedSourceCoverage | undefined {
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

  const unresolvedClauses: RecoverableCapturedSourceCoverage['unresolvedClauses'] =
    [];
  const expectedOriginalErrors: string[] = [];
  for (const [index, clause] of original.clauses.entries()) {
    const disposition = original.dispositions[index];
    if (disposition?.clauseId !== clause.id) return undefined;
    const unsupportedExclusion = `Unsupported nonrequirement exclusion: ${clause.id}.`;
    if (admission.errors.includes(unsupportedExclusion)) {
      if (
        disposition.type !== 'nonrequirement' ||
        disposition.requirementIds.length !== 0 ||
        disposition.auditPending !== undefined
      )
        return undefined;
      unresolvedClauses.push({
        clauseId: clause.id,
        originalRequirementIds: [],
        reason: 'unsupported_nonrequirement_exclusion',
      });
      expectedOriginalErrors.push(unsupportedExclusion);
      continue;
    }
    const unmappedMaterial = `Material source clause has no lossless mapped requirement: ${clause.id}.`;
    if (admission.errors.includes(unmappedMaterial)) {
      if (
        !['material_requirement', 'role_duty', 'role_context'].includes(
          disposition.type,
        ) ||
        disposition.requirementIds.length !== 0 ||
        disposition.exclusionRule !== undefined ||
        disposition.auditPending !== undefined
      )
        return undefined;
      unresolvedClauses.push({
        clauseId: clause.id,
        originalRequirementIds: [],
        reason: 'unmapped_material_clause',
      });
      expectedOriginalErrors.push(unmappedMaterial);
      continue;
    }
    for (const requirementId of disposition.requirementIds) {
      const row = original.requirements.find(
        (candidate) => candidate.id === requirementId,
      );
      if (row?.clauseIds.includes(clause.id)) continue;
      const next = original.clauses[index + 1];
      const nextDisposition = original.dispositions[index + 1];
      if (
        !row ||
        disposition.type !== 'role_duty' ||
        disposition.requirementIds.length !== 1 ||
        disposition.exclusionRule !== undefined ||
        disposition.auditPending !== undefined ||
        clause.kind !== 'body' ||
        !/^[^\n•-][^\n]*:$/u.test(clause.text) ||
        !next ||
        next.kind !== 'body' ||
        next.section !== clause.section ||
        next.spanStart <= clause.spanEnd ||
        !/^[-•]\s+\S/u.test(next.text) ||
        row.clauseIds.length !== 1 ||
        row.clauseIds[0] !== next.id ||
        nextDisposition?.clauseId !== next.id ||
        nextDisposition.type !== 'role_duty' ||
        !nextDisposition.requirementIds.includes(requirementId)
      )
        return undefined;
      unresolvedClauses.push({
        clauseId: clause.id,
        originalRequirementIds: [requirementId],
        reason: 'nonreciprocal_introductory_duty_link',
      });
      expectedOriginalErrors.push(
        `Broken reciprocal requirement mapping: ${clause.id}/${requirementId}.`,
      );
    }
  }
  if (
    !unresolvedClauses.length ||
    !original.requirements.some((row) =>
      row.clauseIds.some((id) =>
        original.dispositions.some(
          (disposition) =>
            disposition.clauseId === id &&
            disposition.requirementIds.includes(row.id),
        ),
      ),
    ) ||
    admission.errors.length !== expectedOriginalErrors.length ||
    admission.errors.some((error) => !expectedOriginalErrors.includes(error)) ||
    admission.uncoveredClauseIds.length !== unresolvedClauses.length ||
    admission.uncoveredClauseIds.some(
      (id) => !unresolvedClauses.some((entry) => entry.clauseId === id),
    )
  )
    return undefined;

  const introIds = new Set(
    unresolvedClauses
      .filter(
        (entry) => entry.reason === 'nonreciprocal_introductory_duty_link',
      )
      .map((entry) => entry.clauseId),
  );
  const ledger: CoverageLedger = {
    ...original,
    clauses: original.clauses.map((clause) => ({ ...clause })),
    requirements: original.requirements.map((row) => ({
      ...row,
      clauseIds: [...row.clauseIds],
    })),
    dispositions: original.dispositions.map((row) => ({
      ...row,
      requirementIds: introIds.has(row.clauseId) ? [] : [...row.requirementIds],
    })),
  };
  const recoveredAdmission = validateRequirementCoverageAuditAdmission(
    context,
    ledger,
  );
  const expectedRecoveredErrors = unresolvedClauses.map((entry) =>
    entry.reason === 'nonreciprocal_introductory_duty_link'
      ? `Material source clause has no lossless mapped requirement: ${entry.clauseId}.`
      : entry.reason === 'unsupported_nonrequirement_exclusion'
        ? `Unsupported nonrequirement exclusion: ${entry.clauseId}.`
        : `Material source clause has no lossless mapped requirement: ${entry.clauseId}.`,
  );
  if (
    recoveredAdmission.structuralComplete ||
    recoveredAdmission.errors.length !== expectedRecoveredErrors.length ||
    recoveredAdmission.errors.some(
      (error) => !expectedRecoveredErrors.includes(error),
    ) ||
    recoveredAdmission.uncoveredClauseIds.length !== unresolvedClauses.length ||
    recoveredAdmission.uncoveredClauseIds.some(
      (id) => !unresolvedClauses.some((entry) => entry.clauseId === id),
    )
  )
    return undefined;
  const { audit: _audit, ...originalMaterial } = original;
  const originalLedgerFingerprint = hash(JSON.stringify(originalMaterial));
  const version = RECOVERABLE_CAPTURED_SOURCE_COVERAGE_VERSION;
  return {
    version,
    originalLedgerFingerprint,
    ledger,
    unresolvedClauses,
    fingerprint: hash(
      JSON.stringify({
        version,
        originalLedgerFingerprint,
        ledger,
        unresolvedClauses,
      }),
    ),
  };
}
