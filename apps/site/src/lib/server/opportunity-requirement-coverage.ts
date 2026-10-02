import { createHash } from 'node:crypto';
import {
  OPPORTUNITY_EXTRACTION_PROMPT_VERSION,
  OPPORTUNITY_EXTRACTION_SCHEMA_VERSION,
} from './opportunity-posting-preparation.js';
import { opportunityWithSourceContent } from './opportunity-source-content.js';

export const REQUIREMENT_COVERAGE_VERSION = 'requirement-coverage/v1';
export const REQUIREMENT_COVERAGE_SOURCE_CONTRACT_VERSION =
  'requirement-coverage-source/v4-coverage-only4096';
export const REQUIREMENT_COVERAGE_EXTRACTION_PROMPT_VERSION = `${OPPORTUNITY_EXTRACTION_PROMPT_VERSION}/requirement-coverage-v3-only4096`;
export const REQUIREMENT_COVERAGE_EXTRACTION_SCHEMA_VERSION = `${OPPORTUNITY_EXTRACTION_SCHEMA_VERSION}/requirement-coverage-v3-only4096`;
export interface RequirementCoverageContext {
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
  audit?: {
    version: 'requirement-coverage-audit/v4-keyed-binding';
    ledgerFingerprint: string;
    sourceFingerprint: string;
    extractionFingerprint: string;
    requestId: string;
    probabilities: Record<string, number>;
    importance: Record<string, 'required' | 'preferred' | 'unknown'>;
    importanceProbabilities: Record<string, number>;
    fingerprint: string;
  };
}

/** Derive identity from captured/native source fields, never from a ledger. */
export function requirementCoverageContextForOpportunity(
  opportunity: Record<string, unknown>,
): RequirementCoverageContext {
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
    sourceText,
    sourceFingerprint,
    sourceVersion,
    extractionFingerprint: hash(
      JSON.stringify({
        version: REQUIREMENT_COVERAGE_VERSION,
        sourceContractVersion: REQUIREMENT_COVERAGE_SOURCE_CONTRACT_VERSION,
        sourceFingerprint,
        sourceVersion,
        preparedFingerprint,
        sourceTextHash: hash(sourceText),
        promptVersion: REQUIREMENT_COVERAGE_EXTRACTION_PROMPT_VERSION,
        schemaVersion: REQUIREMENT_COVERAGE_EXTRACTION_SCHEMA_VERSION,
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
const HEADING =
  /^(?:about(?: the)? (?:role|team|company)|about us|who (?:you are|we are)|what you(?:'|’)ll (?:do|bring)|what we(?:'|’)re looking for|what we offer|(?:key )?responsibilities|(?:minimum |preferred |required )?(?:qualifications|requirements)|benefits|perks|compensation|salary|location|how to apply|equal opportunity)\s*:?[\s]*$/i;
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
    const kind = HEADING.test(literal) ? 'heading' : 'body';
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
      HEADING.test(text)) ||
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
        HEADING.test(literalTextForPostingClause(clause))
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
