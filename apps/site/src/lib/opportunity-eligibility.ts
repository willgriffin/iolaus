/** Posting facts describe the employer's stated geography, never the candidate's legal status. */
export const ELIGIBILITY_FLAGS = {
  CANADA: 1,
  SPONSORSHIP: 2,
  US_RESIDENCE: 4,
  INCOMPATIBLE: 8,
  CONFLICTING: 16,
  UNKNOWN: 32,
} as const;
export const ELIGIBILITY_BUCKETS = [
  'canada_eligible',
  'sponsorship_possible',
  'us_residence_required',
  'unknown',
  'conflicting',
  'incompatible',
] as const;
export type EligibilityBucket = (typeof ELIGIBILITY_BUCKETS)[number];
export const eligibilityBucketLabels: Record<EligibilityBucket, string> = {
  canada_eligible: 'Canada eligible',
  sponsorship_possible: 'Visa sponsorship possible',
  us_residence_required: 'US residence required',
  unknown: 'Unknown',
  conflicting: 'Conflicting evidence',
  incompatible: 'Canada work location excluded',
};
export const POSTING_ELIGIBILITY_VERSION = 'posting-eligibility/v1';
export type EligibilityAssertionKind =
  | 'canada_supported'
  | 'worldwide_supported'
  | 'canada_excluded'
  | 'us_residence_required'
  | 'region_restricted'
  | 'conditional_geography'
  | 'sponsorship_offered'
  | 'sponsorship_denied'
  | 'conditional_sponsorship'
  | 'eor_offered'
  | 'eor_denied'
  | 'authorization_us_required'
  | 'authorization_canada_required';
export interface EligibilityAssertion {
  kind: EligibilityAssertionKind;
  excerpt: string;
  sectionId: string;
  sectionKind: string;
  sourceLineStart: number;
  sourceLineEnd: number;
  method: 'explicit-posting-clause';
  condition?: string;
}
export interface OpportunityEligibilityPayload {
  version: typeof POSTING_ELIGIBILITY_VERSION;
  sourceContentFingerprint: string;
  sourceContentVersion: number;
  assertions: EligibilityAssertion[];
}
export interface OpportunityEligibilityDecision {
  flags: number;
  buckets: EligibilityBucket[];
  assertions: EligibilityAssertion[];
  status: 'current' | 'missing' | 'stale' | 'invalid';
  reason: string;
}
const bucketFlags: Record<EligibilityBucket, number> = {
  canada_eligible: 1,
  sponsorship_possible: 2,
  us_residence_required: 4,
  incompatible: 8,
  conflicting: 16,
  unknown: 32,
};
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function object(value: unknown): Record<string, unknown> | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}
function sourceText(record: Record<string, unknown>): string {
  const source = object(record.sourceContentJson);
  // Only captured source text can establish an assertion. Missing source text is unknown.
  return text(source?.descriptionRaw);
}
function sourceLines(record: Record<string, unknown>): string[] {
  return sourceText(record)
    .replace(/<\/?(?:br|div|h[1-6]|li|p|section|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(
      /&(?:nbsp|amp|quot|apos|lt|gt);/gi,
      (entity) =>
        ({
          '&nbsp;': ' ',
          '&amp;': '&',
          '&quot;': '"',
          '&apos;': "'",
          '&lt;': '<',
          '&gt;': '>',
        })[entity.toLowerCase()] ?? ' ',
    )
    .split(/\r?\n/)
    .map((line) => line.normalize('NFKC').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}
const CANADA = /\bcanada\b/i;
const US = /\b(?:united states|u\.?s\.?a?\.?)\b/i;
const PROVINCE =
  /\b(?:ontario|quebec|québec|alberta|british columbia|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland|prince edward island|yukon|nunavut|northwest territories)\b/i;
const ROLE =
  /\b(?:this (?:role|position|job)|candidates?|applicants?|location|reside|residence|based|located|remote|work (?:from|in)|employment geography)\b/i;
const WORLD =
  /\b(?:worldwide|globally|anywhere in (?:the )?world|any country|all countries)\b/i;
const QUALIFIER =
  /\b(?:except|excluding|unless|subject to|case.by.case|depending on|certain|selected|some countries)\b/i;

/** Token-free extraction scans complete bounded source, not historical derived fields. */
export function buildOpportunityEligibility(
  record: Record<string, unknown>,
): OpportunityEligibilityPayload {
  const payload: OpportunityEligibilityPayload = {
    version: POSTING_ELIGIBILITY_VERSION,
    sourceContentFingerprint: text(record.sourceContentFingerprint),
    sourceContentVersion: Number(record.sourceContentVersion) || 0,
    assertions: [],
  };
  if (
    !payload.sourceContentFingerprint ||
    payload.sourceContentVersion < 1 ||
    sourceText(record).length > 200_000
  )
    return payload;
  const lines = sourceLines(record);
  if (lines.length > 2_000) return payload; // Never ignore a possible later contradiction.
  let sectionKind = 'summary';
  let sectionStart = 1;
  const seen = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (
      /^(?:benefits|perks|about (?:us|the company)|our company|corporate information)\s*:\s*\S/i.test(
        line,
      )
    )
      continue;
    if (
      /^(?:benefits|perks|about (?:us|the company)|our company|equal opportunity|corporate information)\s*:?$/i.test(
        line,
      )
    ) {
      sectionKind = 'boilerplate';
      sectionStart = index + 1;
      continue;
    }
    if (
      /^(?:location|work location|workplace|where you.?ll work|eligibility|requirements|qualifications)\s*:?$/i.test(
        line,
      )
    ) {
      sectionKind = /requirements|qualifications/i.test(line)
        ? 'qualifications'
        : 'location';
      sectionStart = index + 1;
      continue;
    }
    if (sectionKind === 'boilerplate') continue;
    for (const clause of line.split(/(?<=[.!?;])\s+(?=[A-Z])/)) {
      if (clause.length > 600) return { ...payload, assertions: [] }; // No partial positive scan.
      const add = (kind: EligibilityAssertionKind, condition?: string) => {
        const key = `${kind}:${index}:${clause}`;
        if (seen.has(key)) return;
        seen.add(key);
        payload.assertions.push({
          kind,
          excerpt: clause,
          sectionId: `eligibility:${sectionStart}`,
          sectionKind,
          sourceLineStart: index + 1,
          sourceLineEnd: index + 1,
          method: 'explicit-posting-clause',
          ...(condition ? { condition } : {}),
        });
      };
      const role = ROLE.test(clause) || sectionKind === 'location';
      const conditional = QUALIFIER.test(clause);
      const sponsorCondition =
        conditional ||
        /\b(?:only|already|if|provided that|must)\b/i.test(clause);
      const canada = CANADA.test(clause);
      const us = US.test(clause);
      const countryScope =
        role &&
        /\b(?:remote|work|resid|based|located|location|open to|eligible|applicants|candidates)\b/i.test(
          clause,
        );
      const canadaDenied =
        canada &&
        /(?:\b(?:not|no|cannot|can't|unable|excluding|except)\b.{0,45}\b(?:canada|canadian)\b|\bcanada\b.{0,30}\b(?:excluded|not (?:eligible|supported|available))\b)/i.test(
          clause,
        );
      if (countryScope && canadaDenied) add('canada_excluded');
      else if (countryScope && (canada || WORLD.test(clause))) {
        if (PROVINCE.test(clause))
          add(
            'region_restricted',
            'Posting specifies a Canadian province or territory; candidate region is not supplied.',
          );
        else if (conditional) add('conditional_geography', clause);
        else add(canada ? 'canada_supported' : 'worldwide_supported');
      }
      if (
        countryScope &&
        us &&
        !canada &&
        /\b(?:must|only|required|restricted|reside|residence|based in|located in)\b/i.test(
          clause,
        )
      )
        add('us_residence_required');
      const visa =
        /\b(?:visa|immigration|work permit|sponsor(?:ship)?)\b/i.test(clause);
      const denial =
        /\b(?:no|not|cannot|can't|unable|do not|don't|without|never)\b.{0,55}\b(?:sponsor|visa|work permit)|\b(?:sponsorship|visa)\b.{0,35}\b(?:not available|not provided|unavailable|not offered|denied|not supported)\b/i.test(
          clause,
        );
      const offered =
        /\b(?:offers?|offered|provides?|provided|available|supports?|sponsors?|consider(?:s|ed)?)\b/i.test(
          clause,
        );
      if (visa && denial) add('sponsorship_denied');
      else if (visa && offered)
        add(
          sponsorCondition ? 'conditional_sponsorship' : 'sponsorship_offered',
          sponsorCondition ? clause : undefined,
        );
      if (/\b(?:employer of record|eor)\b/i.test(clause)) {
        if (/\b(?:no|not|cannot|unavailable)\b/i.test(clause))
          add('eor_denied');
        else if (
          /\b(?:offer|provide|available|support|use|hire through)\b/i.test(
            clause,
          )
        )
          add('eor_offered');
      }
      if (
        (role || sectionKind === 'qualifications') &&
        /\b(?:must|required|require)\b.{0,50}\b(?:authori[sz]ed|authorization|right to work|work permit)\b|\b(?:authori[sz]ation|right to work)\b.{0,40}\b(?:required|must)\b/i.test(
          clause,
        )
      ) {
        if (us) add('authorization_us_required');
        if (canada) add('authorization_canada_required');
      }
    }
  }
  return payload;
}

export function decideOpportunityEligibility(
  payload: OpportunityEligibilityPayload,
): { flags: number; reason: string } {
  const kinds = new Set(payload.assertions.map((assertion) => assertion.kind));
  const supported =
    kinds.has('canada_supported') || kinds.has('worldwide_supported');
  const sponsor = kinds.has('sponsorship_offered');
  const us = kinds.has('us_residence_required');
  const excluded = kinds.has('canada_excluded');
  const conflict =
    (supported && (excluded || us || kinds.has('authorization_us_required'))) ||
    (sponsor && kinds.has('sponsorship_denied')) ||
    (kinds.has('eor_offered') && kinds.has('eor_denied'));
  if (conflict)
    return {
      flags: ELIGIBILITY_FLAGS.CONFLICTING,
      reason:
        'Posting clauses conflict; positive eligibility and sponsorship claims are withheld.',
    };
  const conditional =
    kinds.has('region_restricted') || kinds.has('conditional_geography');
  let flags = 0;
  if (supported && !conditional) flags |= ELIGIBILITY_FLAGS.CANADA;
  if (sponsor) flags |= ELIGIBILITY_FLAGS.SPONSORSHIP;
  if (us) flags |= ELIGIBILITY_FLAGS.US_RESIDENCE;
  if (excluded || us) flags |= ELIGIBILITY_FLAGS.INCOMPATIBLE;
  if (!flags) flags = ELIGIBILITY_FLAGS.UNKNOWN;
  return {
    flags,
    reason: conditional
      ? 'Location eligibility has an unresolved condition or Canadian region restriction.'
      : flags & ELIGIBILITY_FLAGS.CANADA
        ? 'Posting explicitly supports working from Canada; stated authorization and sponsorship requirements remain separate facts.'
        : flags & ELIGIBILITY_FLAGS.SPONSORSHIP
          ? 'Posting explicitly offers visa sponsorship; this is a possible option, not an authorization or relocation guarantee.'
          : us
            ? 'Posting requires US residence; an offered sponsorship option is shown independently.'
            : excluded
              ? 'Posting explicitly excludes work from Canada.'
              : 'No current explicit posting clause establishes Canada eligibility or a visa sponsorship option.',
  };
}

/** Revalidate against independent current record identity AND freshly scanned source clauses. */
export function getOpportunityEligibility(
  record: Record<string, unknown>,
): OpportunityEligibilityDecision {
  const current = buildOpportunityEligibility(record);
  const persisted = object(record.postingEligibilityJson);
  let status: OpportunityEligibilityDecision['status'] = 'current';
  if (
    !persisted ||
    !current.sourceContentFingerprint ||
    current.sourceContentVersion < 1
  )
    status = 'missing';
  else if (
    persisted.sourceContentFingerprint !== current.sourceContentFingerprint ||
    persisted.sourceContentVersion !== current.sourceContentVersion
  )
    status = 'stale';
  else if (
    persisted.version !== POSTING_ELIGIBILITY_VERSION ||
    JSON.stringify(persisted.assertions) !== JSON.stringify(current.assertions)
  )
    status = 'invalid';
  const decision =
    status === 'current'
      ? decideOpportunityEligibility(current)
      : {
          flags: ELIGIBILITY_FLAGS.UNKNOWN,
          reason: `Eligibility evidence is ${status}; refresh it from the current posting source.`,
        };
  return {
    ...decision,
    assertions: status === 'current' ? current.assertions : [],
    status,
    buckets: ELIGIBILITY_BUCKETS.filter((bucket) =>
      Boolean(decision.flags & bucketFlags[bucket]),
    ),
  };
}
export function opportunityEligibilityProjection(
  record: Record<string, unknown>,
  _payload?: OpportunityEligibilityPayload,
) {
  const payload = buildOpportunityEligibility(record);
  return {
    postingEligibilityJson: JSON.stringify(payload),
    eligibilityFlags: decideOpportunityEligibility(payload).flags,
    eligibilitySourceFingerprint: payload.sourceContentFingerprint,
    eligibilitySourceVersion: payload.sourceContentVersion,
  };
}
export function eligibilityRank(record: Record<string, unknown>): number {
  const { flags } = getOpportunityEligibility(record);
  return flags & ELIGIBILITY_FLAGS.CANADA
    ? 0
    : flags & ELIGIBILITY_FLAGS.SPONSORSHIP
      ? 1
      : flags &
          (ELIGIBILITY_FLAGS.US_RESIDENCE | ELIGIBILITY_FLAGS.INCOMPATIBLE)
        ? 3
        : 2;
}
