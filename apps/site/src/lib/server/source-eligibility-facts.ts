import { createHash } from 'node:crypto';
import type { DecisionRequest, DecisionResult } from '@happyvertical/ai';
import {
  type CountryReference,
  countryReferenceFromCode,
  normalizeCountryReference,
} from './country-reference.js';
import type { CandidateWorkEligibility } from './opportunity-assessment.js';
import {
  fingerprintOpportunitySourceContent,
  parseOpportunitySourceContent,
} from './opportunity-source-content.js';

/** Public, source-only fact contract. Candidate data never enters this value. */
export const SOURCE_ELIGIBILITY_FACT_VERSION = 'source-eligibility-facts/v1';
/**
 * Provider-side sidecar for source eligibility. It is intentionally distinct
 * from the requirement-evidence contract: adding it must not reinterpret a
 * previously paid v1/v2 requirement receipt.
 */
export const SOURCE_ELIGIBILITY_AUDIT_VERSION =
  'source-eligibility-audit/v3' as const;
/**
 * Opt-in aggregate sidecar that adds original ATS location metadata. It is
 * intentionally separate from the body-only v3 receipt contract.
 */
export const SOURCE_ELIGIBILITY_CAPTURED_SOURCE_AUDIT_VERSION =
  'source-eligibility-audit/v4-captured-source' as const;
export const SOURCE_ELIGIBILITY_CONFIDENCE = 0.85;

export const SOURCE_ELIGIBILITY_FACT_KINDS = [
  'work_country_allowed',
  'remote_available',
  'remote_worldwide_allowed',
  'work_country_required',
  'existing_authorization_required',
  'sponsorship_offered',
  'sponsorship_denied',
  'relocation_offered',
  'constraint',
] as const;
export type SourceEligibilityFactKind =
  (typeof SOURCE_ELIGIBILITY_FACT_KINDS)[number];

export const SOURCE_ELIGIBILITY_CONSTRAINT_KINDS = [
  'city',
  'subnational_location',
  'timezone',
  'work_arrangement',
] as const;
export type SourceEligibilityConstraintKind =
  (typeof SOURCE_ELIGIBILITY_CONSTRAINT_KINDS)[number];

export type SourceEligibilityCapturedFieldName = 'locationNotes' | 'workMode';

export interface SourceEligibilityClauseCitation {
  clauseId: string;
  end: number;
  hash: string;
  /** Missing on v3 historical receipts; both forms mean descriptionRaw. */
  source?: 'descriptionRaw';
  start: number;
}

/** Exact scalar from the original parsed sourceContentJson, never Opportunity. */
export interface SourceEligibilityCapturedField {
  field: SourceEligibilityCapturedFieldName;
  hash: string;
  id: `source-field:${SourceEligibilityCapturedFieldName}`;
  path: `sourceContentJson.${SourceEligibilityCapturedFieldName}`;
  text: string;
}

export interface SourceEligibilityCapturedFieldCitation {
  field: SourceEligibilityCapturedFieldName;
  hash: string;
  id: `source-field:${SourceEligibilityCapturedFieldName}`;
  path: `sourceContentJson.${SourceEligibilityCapturedFieldName}`;
  source: 'captured_field';
  text: string;
}

export type SourceEligibilityCitation =
  | SourceEligibilityClauseCitation
  | SourceEligibilityCapturedFieldCitation;

export interface SourceEligibilityFact {
  citations: SourceEligibilityCitation[];
  /** Must equal `sourceEligibilityFactKey(fact)`. */
  key: string;
  kind: SourceEligibilityFactKind;
  /** Required only by country-specific fact kinds. */
  country?: CountryReference;
  /** Required only by constraint facts. */
  constraint?: SourceEligibilityConstraintKind;
}

/** Exact, ordered UTF-16 source spans supplied by the canonical source reader. */
export interface SourceEligibilityClause {
  end: number;
  id: string;
  start: number;
  text: string;
}

/**
 * A source-native nomination offers witnesses to a typed decision. It is not
 * itself evidence: resolution additionally requires both an affirmative
 * predicate and a high-confidence choice of one offered exact span.
 */
export interface SourceEligibilityFactOffer {
  clauseIds: string[];
  /** Optional exact original ATS field witnesses in the v4 sidecar only. */
  capturedFieldIds?: Array<SourceEligibilityCapturedField['id']>;
  country?: CountryReference;
  constraint?: SourceEligibilityConstraintKind;
  kind: SourceEligibilityFactKind;
}

export interface PreparedSourceEligibilityAudit {
  auditVersion:
    | typeof SOURCE_ELIGIBILITY_AUDIT_VERSION
    | typeof SOURCE_ELIGIBILITY_CAPTURED_SOURCE_AUDIT_VERSION;
  clauses: SourceEligibilityClause[];
  /** V4-only compact request aliases; canonical IDs remain in `clauses`. */
  clauseAliases?: Record<string, string>;
  context: SourceEligibilityEvidenceContext;
  /** More distinct source-country candidates than the audited cap means unknown. */
  countryOverflow: boolean;
  fingerprint: string;
  offers: SourceEligibilityFactOffer[];
  request: DecisionRequest;
}

/**
 * An explicit source-audit attestation. False means the audit did not inspect
 * that complete scope; absence is never interpreted as no restriction.
 */
export interface SourceEligibilityCoverage {
  authorization: boolean;
  geography: boolean;
  workArrangement: boolean;
}

/** Materialized only after the aggregate reader has verified a GLOBAL receipt. */
export interface SourceEligibilityEvidence {
  aggregateFingerprint: string;
  /** Required when evidence came from the opt-in captured-source v4 sidecar. */
  capturedFieldsFingerprint?: string;
  coverage: SourceEligibilityCoverage;
  facts: SourceEligibilityFact[];
  requestId: string;
  sourceContentFingerprint: string;
  sourceContentVersion: number;
  version: typeof SOURCE_ELIGIBILITY_FACT_VERSION;
}

/** Current captured source used to revalidate exact, public citations. */
export interface SourceEligibilityEvidenceContext {
  /** Present only on the opt-in captured-source v4 context. */
  capturedFields?: SourceEligibilityCapturedField[];
  capturedFieldsFingerprint?: string;
  sourceContentFingerprint: string;
  sourceContentVersion: number;
  sourceText: string;
}

export interface SourceEligibilityCapturedEvidenceContext
  extends SourceEligibilityEvidenceContext {
  capturedFields: SourceEligibilityCapturedField[];
  capturedFieldsFingerprint: string;
}

/**
 * Constraint satisfaction may be supplied only by a verified, typed profile
 * adapter. The raw profile location and free-text work authorization are not
 * accepted here.
 */
export interface SourceEligibilityCandidateContext {
  satisfiedConstraintFactKeys?: readonly string[];
}

/**
 * A source-cited path that remains useful even when the candidate's primary
 * work-location result is restrictive. It never establishes authorization or
 * relocation approval.
 */
export interface SourceEligibilityConditionalPath {
  facts: Array<Pick<SourceEligibilityFact, 'citations' | 'key'>>;
  kind: 'sponsorship';
  status: 'conflicting' | 'denied' | 'offered';
}

export type SourceEligibilityVerdict =
  | 'eligible_without_sponsorship'
  | 'sponsorship_possible'
  | 'location_restriction'
  | 'incompatible'
  | 'unknown'
  | 'conflicting';

export interface SourceEligibilityProjection {
  conditionalPaths: SourceEligibilityConditionalPath[];
  factKeys: string[];
  reason: string;
  unresolvedConstraintFactKeys: string[];
  verdict: SourceEligibilityVerdict;
}

const countryFactKinds = new Set<SourceEligibilityFactKind>([
  'work_country_allowed',
  'work_country_required',
  'existing_authorization_required',
]);
const constraintKinds = new Set<string>(SOURCE_ELIGIBILITY_CONSTRAINT_KINDS);
const factKinds = new Set<string>(SOURCE_ELIGIBILITY_FACT_KINDS);

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function identifier(value: unknown): value is string {
  const normalized = text(value);
  return (
    normalized.length > 0 &&
    normalized.length <= 240 &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(normalized)
  );
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function capturedFieldHash(
  path: SourceEligibilityCapturedField['path'],
  value: string,
): string {
  return hash(`${path}\u0000${value}`);
}

/** Stable identity for the exact original ATS metadata supplied to v4. */
export function sourceEligibilityCapturedFieldsFingerprint(
  fields: readonly SourceEligibilityCapturedField[],
): string {
  return stableHash(
    fields.map((field) => ({
      field: field.field,
      hash: field.hash,
      id: field.id,
      path: field.path,
    })),
  );
}

/**
 * Reconstructs attested metadata from the canonical captured source JSON.
 * A caller cannot attach fields from mutable Opportunity columns or silently
 * substitute a body different from the captured description.
 */
export function sourceEligibilityContextFromCapturedSource(
  input: {
    sourceContentFingerprint: string;
    sourceContentVersion: number;
    sourceText?: string;
  },
  sourceContentJson: unknown,
): SourceEligibilityCapturedEvidenceContext | undefined {
  const content = parseOpportunitySourceContent(sourceContentJson);
  if (
    !content ||
    !input.sourceContentFingerprint ||
    !Number.isSafeInteger(input.sourceContentVersion) ||
    input.sourceContentVersion < 1 ||
    fingerprintOpportunitySourceContent(content) !==
      input.sourceContentFingerprint
  )
    return undefined;
  const sourceText =
    typeof content.descriptionRaw === 'string' ? content.descriptionRaw : '';
  if (input.sourceText !== undefined && input.sourceText !== sourceText)
    return undefined;
  const fields: SourceEligibilityCapturedField[] = [];
  for (const field of ['locationNotes', 'workMode'] as const) {
    const value = content[field];
    if (typeof value !== 'string' || !value.trim()) continue;
    const path = `sourceContentJson.${field}` as const;
    fields.push({
      field,
      hash: capturedFieldHash(path, value),
      id: `source-field:${field}`,
      path,
      text: value,
    });
  }
  return {
    capturedFields: fields,
    capturedFieldsFingerprint:
      sourceEligibilityCapturedFieldsFingerprint(fields),
    sourceContentFingerprint: input.sourceContentFingerprint,
    sourceContentVersion: input.sourceContentVersion,
    sourceText,
  };
}

function probability(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function countryForFact(
  fact: Pick<SourceEligibilityFact, 'country'>,
): CountryReference | undefined {
  return normalizeCountryReference(fact.country);
}

/** Stable reserved namespace inside the v2 aggregate; never overlaps row/video keys. */
export function sourceEligibilityFactKey(
  fact: Pick<SourceEligibilityFact, 'kind' | 'country' | 'constraint'>,
): string {
  const country = normalizeCountryReference(fact.country);
  if (countryFactKinds.has(fact.kind) && country)
    return `source_eligibility__${fact.kind}__${country.code}`;
  if (fact.kind === 'constraint' && fact.constraint)
    return `source_eligibility__constraint__${fact.constraint}`;
  return `source_eligibility__${fact.kind}`;
}

/** Alias used by the source-audit writer for its direct predicate key. */
export const sourceEligibilityQuestionKey = sourceEligibilityFactKey;

function sourceEligibilityEvidenceQuestionKey(key: string): string {
  return `${key}__evidence`;
}

const coverageQuestions = {
  authorization:
    'Did this audit inspect every captured clause for explicit work-authorization and sponsorship restrictions for this role? Answer true when the complete captured source was reviewed, whether or not a restriction was stated. This attests source-review coverage only; it does not mean the employer guarantees an absence of restrictions.',
  geography:
    'Did this audit inspect every captured clause for explicit country, province/state, city, and other geographic work-location restrictions for this role? Answer true when the complete captured source was reviewed, whether or not a restriction was stated. This attests source-review coverage only; it does not mean the employer guarantees an absence of restrictions.',
  workArrangement:
    'Did this audit inspect every captured clause for explicit remote, onsite, hybrid, and timezone work-arrangement restrictions for this role? Answer true when the complete captured source was reviewed, whether or not a restriction was stated. This attests source-review coverage only; it does not mean the employer guarantees an absence of restrictions.',
} as const;

const capturedCoverageQuestions = {
  authorization:
    'Did this audit inspect every captured posting clause and supplied original ATS field for explicit work-authorization and sponsorship restrictions? Answer true when the complete captured source was reviewed, whether or not a restriction was stated. This attests source-review coverage only; it does not mean the employer guarantees an absence of restrictions.',
  geography:
    'Did this audit inspect every captured posting clause and supplied original ATS field for explicit country, province/state, city, and other geographic work-location restrictions? Answer true when the complete captured source was reviewed, whether or not a restriction was stated. This attests source-review coverage only; it does not mean the employer guarantees an absence of restrictions.',
  workArrangement:
    'Did this audit inspect every captured posting clause and supplied original ATS field for explicit remote, onsite, hybrid, and timezone work-arrangement restrictions? Answer true when the complete captured source was reviewed, whether or not a restriction was stated. This attests source-review coverage only; it does not mean the employer guarantees an absence of restrictions.',
} as const;

function coverageQuestionsFor(context: SourceEligibilityEvidenceContext) {
  return validCapturedFields(context)
    ? capturedCoverageQuestions
    : coverageQuestions;
}

function factInstructions(fact: SourceEligibilityFactOffer): string {
  const country = countryForFact(fact);
  switch (fact.kind) {
    case 'work_country_allowed':
      return `Does the captured source explicitly allow the role to be worked from ${country?.label ?? 'this country'}? Do not infer permission from company headquarters or a mixed list.`;
    case 'work_country_required':
      return `Does the captured source explicitly require the role to be worked from ${country?.label ?? 'this country'}?`;
    case 'existing_authorization_required':
      return `Does the captured source explicitly require existing authorization to work in ${country?.label ?? 'this country'}?`;
    case 'remote_available':
      return 'Does the captured source explicitly say this role is remote?';
    case 'remote_worldwide_allowed':
      return 'Does the captured source explicitly allow this remote role to be worked worldwide?';
    case 'sponsorship_offered':
      return 'Does the captured source explicitly offer visa or work-authorization sponsorship for this role?';
    case 'sponsorship_denied':
      return 'Does the captured source explicitly deny visa or work-authorization sponsorship for this role?';
    case 'relocation_offered':
      return 'Does the captured source explicitly offer relocation support for this role?';
    case 'constraint':
      return `Does the captured source explicitly state a ${fact.constraint?.replaceAll('_', ' ') ?? 'work'} constraint for this role?`;
  }
}

function validExactClauses(
  context: SourceEligibilityEvidenceContext,
  clauses: SourceEligibilityClause[],
): boolean {
  if (
    !context.sourceContentFingerprint ||
    !Number.isSafeInteger(context.sourceContentVersion) ||
    context.sourceContentVersion < 1 ||
    typeof context.sourceText !== 'string' ||
    clauses.length > 128
  )
    return false;
  if (!clauses.length && !context.capturedFields?.length) return false;
  let cursor = 0;
  const ids = new Set<string>();
  for (const clause of clauses) {
    if (
      !identifier(clause.id) ||
      ids.has(clause.id) ||
      !Number.isSafeInteger(clause.start) ||
      !Number.isSafeInteger(clause.end) ||
      clause.start < cursor ||
      clause.end <= clause.start ||
      clause.end > context.sourceText.length ||
      context.sourceText.slice(clause.start, clause.end) !== clause.text ||
      context.sourceText.slice(cursor, clause.start).trim()
    )
      return false;
    ids.add(clause.id);
    cursor = clause.end;
  }
  return !context.sourceText.slice(cursor).trim();
}

function validCapturedFields(
  context: SourceEligibilityEvidenceContext,
): context is SourceEligibilityCapturedEvidenceContext {
  if (!context.capturedFields || !context.capturedFieldsFingerprint)
    return false;
  const ids = new Set<string>();
  for (const field of context.capturedFields) {
    if (
      !field ||
      (field.field !== 'locationNotes' && field.field !== 'workMode') ||
      field.id !== `source-field:${field.field}` ||
      field.path !== `sourceContentJson.${field.field}` ||
      !field.text.trim() ||
      field.hash !== capturedFieldHash(field.path, field.text) ||
      ids.has(field.id)
    )
      return false;
    ids.add(field.id);
  }
  return (
    context.capturedFieldsFingerprint ===
    sourceEligibilityCapturedFieldsFingerprint(context.capturedFields)
  );
}

function capturedFieldsFor(
  context: SourceEligibilityEvidenceContext,
): SourceEligibilityCapturedField[] {
  return validCapturedFields(context) ? context.capturedFields : [];
}

function clauseAliasesFor(
  context: SourceEligibilityEvidenceContext,
  clauses: SourceEligibilityClause[],
): Record<string, string> | undefined {
  if (!validCapturedFields(context)) return undefined;
  return Object.fromEntries(
    clauses.map((clause, index) => [clause.id, `c${index}`]),
  );
}

function validClauseAliases(
  aliases: Record<string, string> | undefined,
  clauses: SourceEligibilityClause[],
): aliases is Record<string, string> {
  if (!aliases || Object.keys(aliases).length !== clauses.length) return false;
  return clauses.every((clause, index) => aliases[clause.id] === `c${index}`);
}

function validOffer(
  offer: SourceEligibilityFactOffer,
  clauses: SourceEligibilityClause[],
  context: SourceEligibilityEvidenceContext,
): boolean {
  const capturedFieldIds = offer.capturedFieldIds ?? [];
  if (
    !factKinds.has(offer.kind) ||
    (!offer.clauseIds.length && !capturedFieldIds.length)
  )
    return false;
  const fact = { ...offer, key: sourceEligibilityFactKey(offer) };
  if (countryFactKinds.has(offer.kind) && !countryForFact(fact)) return false;
  if (!countryFactKinds.has(offer.kind) && offer.country !== undefined)
    return false;
  if (offer.kind === 'constraint') {
    if (!offer.constraint || !constraintKinds.has(offer.constraint))
      return false;
  } else if (offer.constraint !== undefined) return false;
  const known = new Set(clauses.map((clause) => clause.id));
  const knownFields = new Set(
    capturedFieldsFor(context).map((field) => field.id),
  );
  return (
    offer.clauseIds.length <= clauses.length &&
    new Set(offer.clauseIds).size === offer.clauseIds.length &&
    offer.clauseIds.every((id) => known.has(id)) &&
    capturedFieldIds.length <= knownFields.size &&
    new Set(capturedFieldIds).size === capturedFieldIds.length &&
    capturedFieldIds.every((id) => knownFields.has(id))
  );
}

function escaped(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');
}

function wholeWord(text: string, value: string): boolean {
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${escaped(value)}(?:$|[^\\p{L}\\p{N}])`,
    'iu',
  ).test(text);
}

/**
 * The platform's ICU data provides canonical labels for the validated alpha-2
 * region-code space. We enumerate it rather than maintain a candidate-derived
 * country list. Exact aliases only cover common public posting spellings.
 */
const countryAliases = new Map<string, CountryReference>();
for (let first = 65; first <= 90; first += 1) {
  for (let second = 65; second <= 90; second += 1) {
    const country = countryReferenceFromCode(
      String.fromCharCode(first, second),
    );
    if (
      !country ||
      country.label === country.code ||
      country.label === 'Unknown Region'
    )
      continue;
    const key = country.label.normalize('NFKC').toLocaleLowerCase('en');
    const current = countryAliases.get(key);
    if (!current || country.code < current.code)
      countryAliases.set(key, country);
  }
}
for (const [alias, code] of [
  ['usa', 'US'],
  ['u.s.', 'US'],
  ['u.s.a.', 'US'],
  ['united states of america', 'US'],
  ['uk', 'GB'],
] as const) {
  const country = countryReferenceFromCode(code);
  if (country) countryAliases.set(alias, country);
}

interface SourceEligibilityWitness {
  id: string;
  text: string;
}

function matchingWitnessIds(
  witnesses: SourceEligibilityWitness[],
  matcher: (text: string) => boolean,
): string[] {
  return witnesses
    .filter((witness) => matcher(witness.text))
    .map((witness) => witness.id);
}

/**
 * Derives only source-native candidates. Country labels are offered as typed
 * candidates, never facts; country/state/company ambiguity remains for the
 * provider predicate to reject. Overflow deliberately withholds all positive
 * eligibility by marking scope coverage incomplete in the resolved result.
 */
export function nominateSourceEligibilityFactOffers(
  clauses: SourceEligibilityClause[],
): { countryOverflow: boolean; offers: SourceEligibilityFactOffer[] } {
  return nominateEligibilityFactOffers(
    clauses.map((clause) => ({ id: clause.id, text: clause.text })),
    new Set(clauses.map((clause) => clause.id)),
  );
}

function nominateEligibilityFactOffers(
  witnesses: SourceEligibilityWitness[],
  clauseIds: Set<string>,
): { countryOverflow: boolean; offers: SourceEligibilityFactOffer[] } {
  const countries = new Map<
    string,
    { country: CountryReference; witnessIds: string[] }
  >();
  for (const witness of witnesses) {
    const normalized = witness.text.normalize('NFKC').toLocaleLowerCase('en');
    for (const [label, country] of countryAliases) {
      if (!wholeWord(normalized, label)) continue;
      const current = countries.get(country.code) ?? {
        country,
        witnessIds: [],
      };
      if (!current.witnessIds.includes(witness.id))
        current.witnessIds.push(witness.id);
      countries.set(country.code, current);
    }
  }
  const nominatedCountries = [...countries.values()].sort((left, right) =>
    left.country.code.localeCompare(right.country.code),
  );
  const countryOverflow = nominatedCountries.length > 4;
  const selectedCountries = nominatedCountries.slice(0, 4);
  const offers: SourceEligibilityFactOffer[] = selectedCountries.flatMap(
    ({ country, witnessIds }) => [
      offerFromWitnesses(
        'work_country_allowed',
        country,
        undefined,
        witnessIds,
        clauseIds,
      ),
      offerFromWitnesses(
        'work_country_required',
        country,
        undefined,
        witnessIds,
        clauseIds,
      ),
      offerFromWitnesses(
        'existing_authorization_required',
        country,
        undefined,
        witnessIds,
        clauseIds,
      ),
    ],
  );
  const append = (
    kind: SourceEligibilityFactKind,
    matcher: (text: string) => boolean,
    constraint?: SourceEligibilityConstraintKind,
  ) => {
    const witnessIds = matchingWitnessIds(witnesses, matcher);
    if (witnessIds.length)
      offers.push(
        offerFromWitnesses(kind, undefined, constraint, witnessIds, clauseIds),
      );
  };
  append('remote_available', (value) => /\bremote\b/iu.test(value));
  append('remote_worldwide_allowed', (value) =>
    /\b(?:worldwide|globally|anywhere in (?:the )?world|all countries)\b/iu.test(
      value,
    ),
  );
  append('sponsorship_offered', (value) =>
    /\b(?:visa|work[- ]authorization)\b[^.!?]{0,80}\b(?:sponsor(?:ship)?|available|offered)\b/iu.test(
      value,
    ),
  );
  append('sponsorship_denied', (value) =>
    /\b(?:no|not|without|do not)\b[^.!?]{0,40}\b(?:visa|work[- ]authorization)\b[^.!?]{0,80}\b(?:sponsor(?:ship)?|available)\b/iu.test(
      value,
    ),
  );
  append('relocation_offered', (value) => /\brelocation\b/iu.test(value));
  // Exact witness choice covers every clause because local constraints cannot
  // be safely inferred from a hard-coded city/province list.
  const allWitnessIds = witnesses.map((witness) => witness.id);
  for (const constraint of SOURCE_ELIGIBILITY_CONSTRAINT_KINDS) {
    offers.push(
      offerFromWitnesses(
        'constraint',
        undefined,
        constraint,
        allWitnessIds,
        clauseIds,
      ),
    );
  }
  return { countryOverflow, offers };
}

function offerFromWitnesses(
  kind: SourceEligibilityFactKind,
  country: CountryReference | undefined,
  constraint: SourceEligibilityConstraintKind | undefined,
  witnessIds: string[],
  clauseIds: Set<string>,
): SourceEligibilityFactOffer {
  const sourceClauseIds = witnessIds.filter((id) => clauseIds.has(id));
  const capturedFieldIds = witnessIds.filter(
    (id) => !clauseIds.has(id),
  ) as Array<SourceEligibilityCapturedField['id']>;
  return {
    kind,
    ...(country ? { country } : {}),
    ...(constraint ? { constraint } : {}),
    clauseIds: sourceClauseIds,
    ...(capturedFieldIds.length ? { capturedFieldIds } : {}),
  };
}

/** Canonical source-only factory used by the aggregate provider. */
export function prepareCanonicalSourceEligibilityEvidenceAudit(input: {
  clauses: SourceEligibilityClause[];
  context: SourceEligibilityEvidenceContext;
}): PreparedSourceEligibilityAudit {
  const nomination = nominateSourceEligibilityFactOffers(input.clauses);
  return prepareSourceEligibilityEvidenceAudit({
    ...input,
    offers: nomination.offers,
    countryOverflow: nomination.countryOverflow,
  });
}

/**
 * New opt-in aggregate factory. It adds only attested original ATS fields and
 * intentionally leaves body-only v3 preparation/replay unchanged.
 */
export function prepareCanonicalCapturedSourceEligibilityEvidenceAudit(input: {
  clauses: SourceEligibilityClause[];
  context: SourceEligibilityCapturedEvidenceContext;
}): PreparedSourceEligibilityAudit {
  if (!validCapturedFields(input.context))
    throw new Error(
      'Captured ATS eligibility fields must be exact and current.',
    );
  const witnesses = [
    ...input.clauses.map((clause) => ({ id: clause.id, text: clause.text })),
    ...input.context.capturedFields.map((field) => ({
      id: field.id,
      text: field.text,
    })),
  ];
  const nomination = nominateEligibilityFactOffers(
    witnesses,
    new Set(input.clauses.map((clause) => clause.id)),
  );
  return prepareSourceEligibilityEvidenceAudit({
    ...input,
    offers: nomination.offers,
    countryOverflow: nomination.countryOverflow,
  });
}

/**
 * Pure sidecar preparation. The aggregate provider must independently derive
 * exact clauses and offers from its current native source context; caller
 * supplied JSON has no authority to establish a fact.
 */
export function prepareSourceEligibilityEvidenceAudit(input: {
  clauses: SourceEligibilityClause[];
  context: SourceEligibilityEvidenceContext;
  countryOverflow?: boolean;
  offers: SourceEligibilityFactOffer[];
}): PreparedSourceEligibilityAudit {
  if (!validExactClauses(input.context, input.clauses))
    throw new Error(
      'Eligibility source clauses must losslessly cover current source text.',
    );
  if (
    (input.context.capturedFields !== undefined ||
      input.context.capturedFieldsFingerprint !== undefined) &&
    !validCapturedFields(input.context)
  )
    throw new Error(
      'Captured ATS eligibility fields must be exact and current.',
    );
  if (
    input.offers.length > 24 ||
    input.offers.some(
      (offer) => !validOffer(offer, input.clauses, input.context),
    )
  )
    throw new Error(
      'Eligibility offers must be bounded exact source witnesses.',
    );
  const keys = new Set<string>();
  for (const offer of input.offers) {
    const key = sourceEligibilityFactKey(offer);
    if (keys.has(key))
      throw new Error(`Duplicate eligibility fact offer: ${key}`);
    keys.add(key);
  }
  const selectedCoverageQuestions = coverageQuestionsFor(input.context);
  const capturedSource = validCapturedFields(input.context);
  const auditVersion = capturedSource
    ? SOURCE_ELIGIBILITY_CAPTURED_SOURCE_AUDIT_VERSION
    : SOURCE_ELIGIBILITY_AUDIT_VERSION;
  const clauseAliases = clauseAliasesFor(input.context, input.clauses);
  const request: DecisionRequest = {
    state: {
      sourceEligibilityClauses: input.clauses.map((clause) => ({
        id: clauseAliases?.[clause.id] ?? clause.id,
        text: clause.text,
      })),
      ...(validCapturedFields(input.context)
        ? {
            sourceEligibilityCapturedFields: input.context.capturedFields.map(
              (field) => ({
                id: field.id,
                path: field.path,
                text: field.text,
              }),
            ),
          }
        : {}),
    },
    questions: {
      ...Object.fromEntries(
        Object.entries(selectedCoverageQuestions).map(
          ([scope, instructions]) => [
            `source_eligibility__coverage__${scope}`,
            { type: 'predicate' as const, instructions },
          ],
        ),
      ),
      ...Object.fromEntries(
        input.offers.flatMap((offer) => {
          const key = sourceEligibilityFactKey(offer);
          return [
            [
              key,
              {
                type: 'predicate' as const,
                instructions: factInstructions(offer),
              },
            ],
            [
              sourceEligibilityEvidenceQuestionKey(key),
              {
                type: 'choice' as const,
                instructions: capturedSource
                  ? `Choose the exact supplied source witness ID that explicitly proves ${key}. Body cN is the exact state.sourceEligibilityClauses entry with id cN; source-field IDs name original ATS fields. Choose none if no supplied witness proves it.`
                  : `Choose the exact supplied source clause that explicitly proves ${key}, or none if no supplied clause proves it.`,
                criteria: Object.fromEntries([
                  ...offer.clauseIds.map((id) => [
                    clauseAliases?.[id] ?? id,
                    null,
                  ]),
                  ...(offer.capturedFieldIds ?? []).map((id) => [id, null]),
                  ['none', 'No supplied clause explicitly proves this fact.'],
                ]),
              },
            ],
          ];
        }),
      ),
    },
  };
  const material = {
    version: auditVersion,
    context: input.context,
    clauses: input.clauses,
    ...(clauseAliases ? { clauseAliases } : {}),
    offers: input.offers,
    countryOverflow: input.countryOverflow === true,
    request,
  };
  return {
    ...material,
    auditVersion,
    ...(clauseAliases ? { clauseAliases } : {}),
    fingerprint: stableHash(material),
  };
}

/**
 * Resolves only an exact answer set. A fact needs an affirmative predicate and
 * a high-confidence selected literal witness; omitted/low-confidence facts
 * stay absent rather than becoming negative evidence.
 */
export function resolveSourceEligibilityEvidenceAudit(
  prepared: PreparedSourceEligibilityAudit,
  result: DecisionResult,
  requestId: string,
): SourceEligibilityEvidence {
  const keys = Object.keys(prepared.request.questions);
  if (
    !requestId ||
    !result.answers ||
    Object.keys(result.answers).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(result.answers, key))
  )
    throw new Error(
      'Eligibility evidence answers must exactly match the prepared request.',
    );
  const coverage = {
    authorization: false,
    geography: false,
    workArrangement: false,
  };
  const selectedCoverageQuestions = coverageQuestionsFor(prepared.context);
  if (
    prepared.auditVersion ===
      SOURCE_ELIGIBILITY_CAPTURED_SOURCE_AUDIT_VERSION &&
    !validClauseAliases(prepared.clauseAliases, prepared.clauses)
  )
    throw new Error('Captured-source eligibility aliases must be canonical.');
  for (const scope of Object.keys(selectedCoverageQuestions) as Array<
    keyof typeof selectedCoverageQuestions
  >) {
    const answer = result.answers[`source_eligibility__coverage__${scope}`];
    if (answer?.type !== 'predicate' || !probability(answer.probability))
      throw new Error(`Malformed eligibility coverage answer: ${scope}`);
    coverage[scope === 'workArrangement' ? 'workArrangement' : scope] =
      answer.probability >= SOURCE_ELIGIBILITY_CONFIDENCE;
  }
  const clauses = new Map(
    prepared.clauses.map((clause) => [clause.id, clause]),
  );
  const canonicalClauseIdByAlias = new Map(
    Object.entries(prepared.clauseAliases ?? {}).map(([id, alias]) => [
      alias,
      id,
    ]),
  );
  const capturedFields = new Map(
    capturedFieldsFor(prepared.context).map((field) => [field.id, field]),
  );
  const facts: SourceEligibilityFact[] = [];
  for (const offer of prepared.offers) {
    const key = sourceEligibilityFactKey(offer);
    const predicate = result.answers[key];
    const selected = result.answers[sourceEligibilityEvidenceQuestionKey(key)];
    if (
      predicate?.type !== 'predicate' ||
      !probability(predicate.probability) ||
      selected?.type !== 'choice' ||
      typeof selected.choice !== 'string' ||
      typeof selected.confidence !== 'number' ||
      !probability(selected.confidence)
    )
      throw new Error(`Malformed eligibility fact answer: ${key}`);
    const selectedCanonicalClauseId =
      canonicalClauseIdByAlias.get(selected.choice) ?? selected.choice;
    if (
      selected.choice !== 'none' &&
      !offer.clauseIds.includes(selectedCanonicalClauseId) &&
      !(offer.capturedFieldIds ?? []).includes(
        selected.choice as SourceEligibilityCapturedField['id'],
      )
    )
      throw new Error(`Eligibility fact selected an unoffered clause: ${key}`);
    if (
      predicate.probability < SOURCE_ELIGIBILITY_CONFIDENCE ||
      selected.confidence < SOURCE_ELIGIBILITY_CONFIDENCE ||
      selected.choice === 'none'
    )
      continue;
    const clause = clauses.get(selectedCanonicalClauseId);
    const field = capturedFields.get(
      selected.choice as SourceEligibilityCapturedField['id'],
    );
    if (!clause && !field)
      throw new Error(
        `Eligibility fact selected an unavailable witness: ${key}`,
      );
    facts.push({
      kind: offer.kind,
      ...(offer.country
        ? { country: normalizeCountryReference(offer.country)! }
        : {}),
      ...(offer.constraint ? { constraint: offer.constraint } : {}),
      key,
      citations: clause
        ? [
            {
              clauseId: clause.id,
              start: clause.start,
              end: clause.end,
              hash: hash(clause.text),
              source: 'descriptionRaw' as const,
            },
          ]
        : [
            {
              field: field!.field,
              hash: field!.hash,
              id: field!.id,
              path: field!.path,
              source: 'captured_field' as const,
              text: field!.text,
            },
          ],
    });
  }
  const material = {
    version: SOURCE_ELIGIBILITY_FACT_VERSION,
    aggregateFingerprint: prepared.fingerprint,
    requestId,
    sourceContentFingerprint: prepared.context.sourceContentFingerprint,
    sourceContentVersion: prepared.context.sourceContentVersion,
    ...(validCapturedFields(prepared.context)
      ? {
          capturedFieldsFingerprint: prepared.context.capturedFieldsFingerprint,
        }
      : {}),
    coverage: prepared.countryOverflow
      ? { authorization: false, geography: false, workArrangement: false }
      : coverage,
    facts,
  } as const;
  return material;
}

function validCitation(
  citation: unknown,
  context: SourceEligibilityEvidenceContext,
): citation is SourceEligibilityCitation {
  if (!citation || typeof citation !== 'object' || Array.isArray(citation))
    return false;
  const value = citation as Record<string, unknown>;
  if (value.source === 'captured_field') {
    const field = capturedFieldsFor(context).find(
      (candidate) => candidate.id === value.id,
    );
    return (
      field !== undefined &&
      value.field === field.field &&
      value.path === field.path &&
      value.text === field.text &&
      value.hash === field.hash
    );
  }
  if (value.source !== undefined && value.source !== 'descriptionRaw')
    return false;
  const start = value.start;
  const end = value.end;
  return (
    identifier(value.clauseId) &&
    typeof start === 'number' &&
    typeof end === 'number' &&
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    end > start &&
    end <= context.sourceText.length &&
    typeof value.hash === 'string' &&
    /^[a-f0-9]{64}$/iu.test(value.hash) &&
    Boolean(context.sourceText.slice(start, end).trim()) &&
    hash(context.sourceText.slice(start, end)) === value.hash
  );
}

/**
 * Pure source integrity validation. The caller separately proves that the
 * aggregate/request identity is an actual completed GLOBAL provider receipt.
 */
export function validateSourceEligibilityEvidence(
  context: SourceEligibilityEvidenceContext,
  evidence: SourceEligibilityEvidence,
): boolean {
  if (
    evidence?.version !== SOURCE_ELIGIBILITY_FACT_VERSION ||
    !identifier(evidence.aggregateFingerprint) ||
    !identifier(evidence.requestId) ||
    evidence.sourceContentFingerprint !== context.sourceContentFingerprint ||
    evidence.sourceContentVersion !== context.sourceContentVersion ||
    !context.sourceContentFingerprint ||
    context.sourceContentVersion < 1 ||
    (context.capturedFields === undefined) !==
      (context.capturedFieldsFingerprint === undefined) ||
    (context.capturedFields !== undefined && !validCapturedFields(context)) ||
    (validCapturedFields(context) &&
      evidence.capturedFieldsFingerprint !==
        context.capturedFieldsFingerprint) ||
    (!validCapturedFields(context) &&
      evidence.capturedFieldsFingerprint !== undefined) ||
    !evidence.coverage ||
    typeof evidence.coverage.geography !== 'boolean' ||
    typeof evidence.coverage.workArrangement !== 'boolean' ||
    typeof evidence.coverage.authorization !== 'boolean' ||
    typeof context.sourceText !== 'string' ||
    !Array.isArray(evidence.facts) ||
    evidence.facts.length > 32
  )
    return false;

  const keys = new Set<string>();
  for (const fact of evidence.facts) {
    if (
      !fact ||
      !factKinds.has(fact.kind) ||
      !identifier(fact.key) ||
      fact.key !== sourceEligibilityFactKey(fact) ||
      keys.has(fact.key) ||
      !Array.isArray(fact.citations) ||
      fact.citations.length < 1 ||
      fact.citations.length > 12 ||
      !fact.citations.every((citation) => validCitation(citation, context))
    )
      return false;
    keys.add(fact.key);
    const country = countryForFact(fact);
    if (countryFactKinds.has(fact.kind)) {
      if (!country || fact.constraint !== undefined) return false;
    } else if (fact.country !== undefined) {
      return false;
    }
    if (fact.kind === 'constraint') {
      if (!fact.constraint || !constraintKinds.has(fact.constraint))
        return false;
    } else if (fact.constraint !== undefined) {
      return false;
    }
  }
  return true;
}

export interface VerifiedSourceEligibilityProjectionInput {
  candidate: CandidateWorkEligibility;
  candidateContext?: SourceEligibilityCandidateContext;
  evidence: SourceEligibilityEvidence;
  sourceContext: SourceEligibilityEvidenceContext;
}

/**
 * Source readers should use this entry point after proving the evidence came
 * from an actual GLOBAL receipt. It refuses stale or source-injected facts
 * before profile policy is evaluated.
 */
export function projectVerifiedSourceEligibility(
  input: VerifiedSourceEligibilityProjectionInput,
): SourceEligibilityProjection {
  if (!validateSourceEligibilityEvidence(input.sourceContext, input.evidence)) {
    return {
      conditionalPaths: [],
      factKeys: [],
      reason: 'Posting eligibility evidence is missing, stale, or invalid.',
      unresolvedConstraintFactKeys: [],
      verdict: 'unknown',
    };
  }
  return projectSourceEligibility(
    input.evidence,
    input.candidate,
    input.candidateContext,
  );
}

function hasCountryWideAuthorization(
  candidate: CandidateWorkEligibility,
  country: CountryReference,
): boolean {
  return candidate.authorizedWorkCountries.some(
    (authorization) =>
      normalizeCountryReference(authorization.country)?.code === country.code &&
      authorization.scope === 'country' &&
      !text(authorization.condition),
  );
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/**
 * Preserve source-cited sponsorship facts independently of a candidate's
 * primary location result. Callers must still apply their own authorization
 * and location checks before treating a path as actionable.
 */
export function sourceEligibilityConditionalPaths(
  evidence: Pick<SourceEligibilityEvidence, 'facts'>,
): SourceEligibilityConditionalPath[] {
  const sponsorOffered = evidence.facts.some(
    (fact) => fact.kind === 'sponsorship_offered',
  );
  const sponsorDenied = evidence.facts.some(
    (fact) => fact.kind === 'sponsorship_denied',
  );
  if (!sponsorOffered && !sponsorDenied) return [];
  return [
    {
      kind: 'sponsorship',
      status:
        sponsorOffered && sponsorDenied
          ? 'conflicting'
          : sponsorOffered
            ? 'offered'
            : 'denied',
      facts: evidence.facts
        .filter(
          (fact) =>
            fact.kind === 'sponsorship_offered' ||
            fact.kind === 'sponsorship_denied',
        )
        .map((fact) => ({ key: fact.key, citations: fact.citations })),
    },
  ];
}

/**
 * Reusable posting evidence becomes a profile result only here. This makes no
 * immigration-law inference and deliberately treats unsatisfied local/timezone
 * or onsite/hybrid constraints as unknown rather than eligible.
 */
export function projectSourceEligibility(
  evidence: SourceEligibilityEvidence,
  candidate: CandidateWorkEligibility,
  context: SourceEligibilityCandidateContext = {},
): SourceEligibilityProjection {
  const facts = evidence.facts;
  const target = normalizeCountryReference(candidate.targetWorkCountry);
  const factKeys = facts.map((fact) => fact.key).sort();
  const allowedCountries = facts
    .filter((fact) => fact.kind === 'work_country_allowed')
    .map(countryForFact)
    .filter((country): country is CountryReference => Boolean(country));
  const requiredCountries = facts
    .filter((fact) => fact.kind === 'work_country_required')
    .map(countryForFact)
    .filter((country): country is CountryReference => Boolean(country));
  const authorizationCountries = facts
    .filter((fact) => fact.kind === 'existing_authorization_required')
    .map(countryForFact)
    .filter((country): country is CountryReference => Boolean(country));
  const worldwide = facts.some(
    (fact) => fact.kind === 'remote_worldwide_allowed',
  );
  const remote =
    worldwide || facts.some((fact) => fact.kind === 'remote_available');
  const sponsorOffered = facts.some(
    (fact) => fact.kind === 'sponsorship_offered',
  );
  const sponsorDenied = facts.some(
    (fact) => fact.kind === 'sponsorship_denied',
  );
  const satisfied = new Set(context.satisfiedConstraintFactKeys ?? []);
  const conditionalPaths = sourceEligibilityConditionalPaths(evidence);
  const unresolvedConstraintFactKeys = facts
    .filter((fact) => fact.kind === 'constraint' && !satisfied.has(fact.key))
    .map((fact) => fact.key)
    .sort();

  const result = (
    verdict: SourceEligibilityVerdict,
    reason: string,
  ): SourceEligibilityProjection => ({
    conditionalPaths,
    factKeys,
    reason,
    unresolvedConstraintFactKeys,
    verdict,
  });

  if (!target) return result('unknown', 'Target work country is not verified.');
  if (sponsorOffered && sponsorDenied)
    return result('conflicting', 'Posting sponsorship evidence conflicts.');
  const required = unique(requiredCountries.map((country) => country.code));
  if (required.length > 1)
    return result(
      'conflicting',
      'Posting has incompatible required work countries.',
    );
  if (required.length === 1 && required[0] !== target.code)
    return result(
      'location_restriction',
      'Posting requires work from a different country than the target country.',
    );
  const targetAllowed =
    worldwide ||
    required[0] === target.code ||
    allowedCountries.some((country) => country.code === target.code);
  if (!targetAllowed)
    return result(
      'unknown',
      'Posting has no explicit current allowance for the target work country.',
    );
  const targetAuthorizationRequirements = unique(
    authorizationCountries.map((country) => country.code),
  );
  if (
    targetAuthorizationRequirements.length > 0 &&
    !targetAuthorizationRequirements.includes(target.code)
  )
    return result(
      'conflicting',
      'Posting country allowance conflicts with its work-authorization requirement.',
    );
  if (
    !evidence.coverage.geography ||
    !evidence.coverage.workArrangement ||
    !evidence.coverage.authorization
  )
    return result(
      'unknown',
      'Posting eligibility coverage is incomplete for geography, work arrangement, or authorization restrictions.',
    );
  if (!remote)
    return result(
      'unknown',
      'Posting does not explicitly confirm that the target-country role is remote.',
    );
  if (unresolvedConstraintFactKeys.length)
    return result(
      'unknown',
      'Posting has unresolved local, timezone, or work-arrangement constraints.',
    );
  if (hasCountryWideAuthorization(candidate, target))
    return result(
      'eligible_without_sponsorship',
      'Target country is explicitly allowed and the profile has country-wide authorization.',
    );
  if (candidate.sponsorshipRequired === true) {
    if (sponsorOffered)
      return result(
        'sponsorship_possible',
        'Posting explicitly offers sponsorship for a candidate who needs it.',
      );
    if (sponsorDenied)
      return result(
        'incompatible',
        'Posting denies sponsorship and the profile says sponsorship is needed.',
      );
  }
  return result(
    'unknown',
    'Work authorization or sponsorship evidence is insufficient for this profile.',
  );
}
