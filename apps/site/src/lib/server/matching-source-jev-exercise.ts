import type { MatchingSourceText } from './matching-source-extraction-contract.js';
import {
  hasAnalysisPII,
  matchingDescriptionUnits,
  matchingSourceDecoration,
  matchingSourceOperatorDirective,
  matchingSourceSemanticUnits,
  matchingSourceTypedPriorExperience,
} from './matching-source-units.js';

export type MatchingSourceJevExerciseScope = {
  anchorId: string;
  closingId: string;
  unitIds: string[];
};

const exerciseName =
  '(?:(?:(?:technical|practical) )?(?:take[-‐‑– ]home (?:assignment|exercise|challenge|assessment|test)|coding (?:assignment|exercise|challenge|assessment|test)|work[- ]sample(?: (?:assignment|exercise|assessment|test))?)|(?:application|hiring|technical|practical) (?:assessment|exercise))';
const exerciseHeading = new RegExp(
  `^(?:(?:required|optional) )?${exerciseName}(?:\\s*\\(step \\d{1,2}(?: of (?:the (?:hiring |interview |application )?process|\\d{1,2}))?\\))?$`,
  'iu',
);
const exerciseEnd = new RegExp(
  `^end of (?:the )?(?:(?:required|optional) )?(?:${exerciseName}|exercise)[.!]?$`,
  'iu',
);
// An exercise's generic Requirements, Deliverables, or Evaluation heading
// does not establish that the surrounding employer posting has resumed.
const closingHeading =
  /^(?:interview(?:ing)? process|hiring process|(?:the )?(?:application|recruitment|selection) process|interview stages|next steps in (?:the )?(?:interview|hiring|recruitment|application) process|how to apply|apply for this (?:role|position)|(?:(?:minimum|basic|required|preferred|candidate|essential|job) )?qualifications|(?:candidate|job|applicant|employment) requirements|required (?:skills|experience)|what you(?:['’]ll| will) need|what you bring|(?:job |role |key )?responsibilities|(?:job |role )?duties|what you(?:['’]ll| will) do|about (?:us|the company|the role)|compensation(?: and benefits)?|(?:pay|salary) range|(?:our )?benefits|equal employment opportunity)$/iu;
const activeMarkup = /<(?:script|style|template)\b|<!--/iu;
const maxScopes = 4;

function heading(text: string) {
  return text
    .trim()
    .replace(/^#{1,6}\s+/u, '')
    .replace(/\s*[:：]$/u, '')
    .replace(/^(\*\*|__)(.+?)\1$/u, '$2')
    .replace(/\s*[:：]$/u, '')
    .trim()
    .replace(/\s+/gu, ' ');
}

/** Find only explicitly named and closed exercise blocks in the host ledger. */
export function matchingSourceJevExerciseBoundaries(
  source: MatchingSourceText,
) {
  const scopes: MatchingSourceJevExerciseScope[] = [];
  const unresolvedUnitIds: string[] = [];
  if (activeMarkup.test(source.description))
    return { scopes, unresolvedUnitIds };
  let units: ReturnType<typeof matchingSourceSemanticUnits>;
  try {
    units = matchingSourceSemanticUnits(source).filter(
      ({ field }) => field === 'description',
    );
  } catch {
    return { scopes, unresolvedUnitIds };
  }
  const labels = new Map(
    matchingDescriptionUnits(source.description).map(({ start, text }) => [
      start,
      heading(text),
    ]),
  );
  let anchorIndex: number | undefined;
  let ambiguous = false;
  for (const [index, unit] of units.entries()) {
    const label = labels.get(unit.start) ?? '';
    if (exerciseHeading.test(label)) {
      if (anchorIndex === undefined) anchorIndex = index;
      else ambiguous = true;
      continue;
    }
    if (
      anchorIndex === undefined ||
      (!closingHeading.test(label) && !exerciseEnd.test(label))
    )
      continue;
    const anchor = units[anchorIndex];
    const body = units.slice(anchorIndex + 1, index);
    if (
      !ambiguous &&
      anchor &&
      scopes.length < maxScopes &&
      body.some(({ quote }) => !matchingSourceDecoration(quote))
    ) {
      scopes.push({
        anchorId: anchor.id,
        closingId: unit.id,
        unitIds: units.slice(anchorIndex, index).map(({ id }) => id),
      });
    } else
      unresolvedUnitIds.push(
        ...units.slice(anchorIndex, index).map(({ id }) => id),
      );
    anchorIndex = undefined;
    ambiguous = false;
  }
  if (anchorIndex !== undefined)
    unresolvedUnitIds.push(...units.slice(anchorIndex).map(({ id }) => id));
  return { scopes, unresolvedUnitIds };
}

export function matchingSourceJevExerciseScopes(source: MatchingSourceText) {
  return matchingSourceJevExerciseBoundaries(source).scopes;
}

export type MatchingSourceJevExerciseSection = {
  anchorId: string;
  startId: string;
  followingId: string;
  unitIds: string[];
  phase: 'tools' | 'sample' | 'submission' | 'rubric';
};

const toolsHeading =
  /^(?:(?:the |recommended |required |exercise |sample )?(?:(?:tech|technology|technical|development) )?stack|(?:exercise |sample |development )?tools(?: and technologies)?)$/iu;
const sampleHeading =
  /^(?:(?:(?:product|functional|technical|feature|project|sample|exercise|app(?:lication)?) )?(?:requirements|features|specifications)|(?:public|private|authenticated|user|admin|administrator|member|customer|operator) (?:page|pages|experience|dashboard|interface|view|area|workflow)|roles? (?:&|and) (?:rules?|permissions?)|(?:user |product |sample )?(?:workflow|workflows|automation)(?: (?:with|using) [\p{L}\p{N}][\p{L}\p{N}.+#-]*(?: [\p{L}\p{N}][\p{L}\p{N}.+#-]*){0,2})?)$/iu;
const submissionHeading =
  /^(?:(?:sample |exercise |assignment |project )?deliverables|what to submit|how to submit|(?:exercise |assignment |sample )?submission instructions)$/iu;
const rubricHeading =
  /^(?:we evaluate|what we (?:look for|evaluate)|how we evaluate|(?:exercise |assignment |sample )?(?:evaluation|assessment|scoring) criteria|(?:exercise |assignment |evaluation |scoring )?rubric)$/iu;
const nestedSampleHeading =
  /^(?:show|display|fields|fields to (?:show|display|store)|data fields|(?:list|create|add|display) (?:a|an|the) [\p{L}][\p{L}-]*(?: [\p{L}][\p{L}-]*){0,2} with|(?:only )?(?:signed[- ]in |authenticated )?(?:users?|members?|admins?|administrators?|moderators?) can|(?:admin|administrator|user|member|moderator)|have (?:two|three|four|[2-4]) roles|security|authentication|authorization|access control|secure the integration(?: in both directions)?)$/iu;
const maxSectionMembers = 7;

function exercisePhase(
  text: string,
  current: MatchingSourceJevExerciseSection['phase'] | undefined,
): MatchingSourceJevExerciseSection['phase'] | undefined {
  const label = heading(text);
  if (toolsHeading.test(label)) return 'tools';
  if (submissionHeading.test(label)) return 'submission';
  if (rubricHeading.test(label)) return 'rubric';
  if (sampleHeading.test(label)) return 'sample';
  if (
    current === 'sample' &&
    /[:：](?:\*\*|__)?\s*$/u.test(text) &&
    nestedSampleHeading.test(label)
  )
    return 'sample';
}

/** Exact candidates inside a currently discovered outer exercise. Introductory
 * prose remains focal, and subsection membership does not establish that any
 * member lacks an independent applicant condition. */
export function matchingSourceJevExerciseSections(
  source: MatchingSourceText,
  exercise: MatchingSourceJevExerciseScope,
): MatchingSourceJevExerciseSection[] {
  const current = matchingSourceJevExerciseScopes(source).find(
    ({ anchorId, closingId, unitIds }) =>
      anchorId === exercise.anchorId &&
      closingId === exercise.closingId &&
      unitIds.length === exercise.unitIds.length &&
      unitIds.every((id, index) => id === exercise.unitIds[index]),
  );
  if (!current) return [];
  const byId = new Map(
    matchingSourceSemanticUnits(source).map((unit) => [unit.id, unit]),
  );
  const visible = new Map(
    matchingDescriptionUnits(source.description).map(({ start, text }) => [
      start,
      text,
    ]),
  );
  const sections: MatchingSourceJevExerciseSection[] = [];
  let phase: MatchingSourceJevExerciseSection['phase'] | undefined;
  let anchorId = '';
  let members: string[] = [];
  let substantive = 0;
  function flush(followingId: string) {
    const [startId] = members;
    if (phase && startId && substantive)
      sections.push({
        anchorId,
        startId,
        followingId,
        unitIds: members,
        phase,
      });
    members = [];
    substantive = 0;
  }
  for (const id of current.unitIds.slice(1)) {
    const unit = byId.get(id);
    if (!unit) return [];
    const next = exercisePhase(visible.get(unit.start) ?? '', phase);
    if (next) {
      flush(id);
      anchorId = id;
      phase = next;
    }
    if (!phase) continue;
    const decoration = matchingSourceDecoration(unit.quote);
    if (!decoration && substantive >= maxSectionMembers) flush(id);
    members.push(id);
    if (!decoration) substantive += 1;
  }
  flush(current.closingId);
  return sections;
}

export function matchingSourceJevExerciseWrapper(quote: string): boolean {
  return /^(?:requirements|roles?\s*(?:&|and)\s*rules|roles?\s*(?:&|and)\s*permissions|only (?:signed[- ]in|authenticated) (?:users?|members?) can|have (?:two|three|four|[2-4]) roles?)[:：]?$/iu.test(
    heading(quote),
  );
}

export function matchingSourceJevExerciseStructuralWrappers(
  source: MatchingSourceText,
  exercise: MatchingSourceJevExerciseScope,
  verified: readonly (MatchingSourceJevExerciseSection & {
    assessedUnitIds: readonly string[];
  })[],
): string[] {
  const byId = new Map(
    matchingSourceSemanticUnits(source).map((unit) => [unit.id, unit]),
  );
  const candidates = matchingSourceJevExerciseSections(source, exercise);
  const reviewed = new Map(
    verified.map((section) => [section.startId, section]),
  );
  const established = new Set<string>();
  const wrappers: string[] = [];
  for (const section of [...candidates].reverse()) {
    if (section.phase !== 'sample') continue;
    const units = section.unitIds.flatMap((id) => {
      const unit = byId.get(id);
      return unit && !matchingSourceDecoration(unit.quote) ? [unit] : [];
    });
    const audit = reviewed.get(section.startId);
    if (
      audit &&
      audit.anchorId === section.anchorId &&
      audit.followingId === section.followingId &&
      audit.phase === section.phase &&
      audit.unitIds.join(',') === section.unitIds.join(',') &&
      units.length &&
      units.every(({ id }) => audit.assessedUnitIds.includes(id))
    ) {
      established.add(section.startId);
      continue;
    }
    const [wrapper] = units;
    if (
      units.length === 1 &&
      wrapper?.id === section.anchorId &&
      matchingSourceJevExerciseWrapper(wrapper.quote) &&
      established.has(section.followingId)
    ) {
      wrappers.push(wrapper.id);
      established.add(section.startId);
    }
  }
  return wrappers.reverse();
}

/** Closed literal evidence for a requested exercise followed by a real hiring step. */
export function matchingSourceJevExactExerciseParticipation(
  opening: string,
  introduction: string,
  closing: string,
  following: string,
): 'required' | undefined {
  const start = heading(opening);
  const end = heading(closing);
  const namedStep =
    exerciseHeading.test(start) &&
    /\(step \d{1,2} of (?:the )?(?:hiring |interview |application )?process\)$/iu.test(
      start,
    );
  const completion =
    /^(?:please complete|(?:all |every )?(?:applicants?|candidates?) must complete) (?:this |the |a )?(?:take[-‐‑– ]home (?:assignment|exercise|challenge|assessment|test)|(?:coding |technical |application )?exercise|work[- ]sample)\b/iu.test(
      introduction,
    );
  const laterHiringStep =
    /^(?:interview(?:ing)?|hiring|application|recruitment|selection) process$/iu.test(
      end,
    ) &&
    /^(?:take[-‐‑– ]home (?:assignment|exercise|challenge|assessment|test) submission|(?:recruiter|screening|technical|panel) (?:call|interview|screen))\b/iu.test(
      following,
    );
  return namedStep &&
    completion &&
    laterHiringStep &&
    !/\b(?:optional|voluntary|if|unless|except|only when|provided that|subject to|may (?:decline|skip)|not required|do not)\b/iu.test(
      introduction,
    ) &&
    !/\b(?:optional|voluntary|if|unless|except|may skip|not required)\b/iu.test(
      following,
    ) &&
    !matchingSourceJevExerciseCondition(introduction)
    ? 'required'
    : undefined;
}

const injection =
  /\b(?:ignore|disregard|override|forget|bypass)\s+(?:(?:all|any|the)\s+)*(?:(?:previous|prior|preceding|above|system|developer|assistant|safety|verifier|analyzer|classification|evaluation)\s+)+(?:messages?|instructions?|rules?|polic(?:y|ies)|prompts?|constraints?)\b|\b(?:reveal|print|repeat|expose|show)\s+(?:the |your )?(?:(?:hidden|system|developer)\s+)+(?:prompts?|instructions?)\b|\b(?:classify|label|mark)\s+(?:all|every|each)\s+(?:units?|clauses?|requirements?|conditions?)\s+(?:as|to be)\s+(?:context|safe|optional|unresolved|false|true)\b|\b(?:return|output|emit|report)\s+(?:only\s+)?(?:json\s+)?(?:with\s+)?(?:no|zero)\s+(?:applicant |job )?(?:requirements?|conditions?)\b|\b(?:system|developer|assistant|verifier|analyzer)\s*:\s*(?:ignore|disregard|override|classify|label|mark|return|output)\b/iu;
const analyzerDirective =
  /<\/?(?:system|assistant|developer)\b|\b(?:return|output|emit|report)\s+(?:only\s+)?json\b.{0,90}\b(?:all|every|each)\s+(?:units?|clauses?|requirements?|conditions?)\b.{0,40}\b(?:context|optional|unresolved|false|true)\b|\b(?:ai|model|assistant|verifier|analyzer)\s+(?:reviewing|classifying|evaluating)\s+(?:this|the)\s+(?:posting|source|requirement)\b.{0,100}\b(?:mark|classify|label|ignore|output)\b/iu;
const legalCondition =
  /\b(?:work authori[sz]ation|authori[sz]ed to work|right to work|eligible to work|work eligibility|work permits?|visa sponsorship|sponsor (?:work )?visas?|without (?:visa )?sponsorship|(?:security )?clearance|background checks?|criminal records? checks?|citizenship|(?:permanent|legal) residen(?:cy|ce|ts?))\b/iu;
const productActor =
  /^(?:(?:only|all|every|each|signed[- ]in|authenticated)\s+)*(?:users?|borrowers?|lenders?|customers?|admins?|administrators?|moderators?|members?|accounts?|(?:the|your|this) (?:app|application|service|system|workflow|product)|the (?:fictional|hypothetical) (?:company|role|user))\b/iu;
const applicantActor =
  /\b(?:candidates?|applicants?|employees?|new hires?|successful candidates?|the (?:job|position|role)|we (?:can )?(?:only )?hire)\b/iu;
const years =
  '(?:\\d{1,2}\\+?|one|two|three|four|five|six|seven|eight|nine|ten)\\s+(?:years?|months?)';
const tenureQualification = `${years}(?:['’])?\\s+(?:of\\s+)?(?:[\\p{L}\\p{N}+#./-]+\\s+){0,5}experience`;
const priorQualification = new RegExp(
  `^(?:(?:at least|minimum of|a minimum of|no fewer than)\\s+)?${tenureQualification}\\b|^(?:(?:must|required|preferred|optional)\\s*[:：]\\s*)?(?:(?:prior|previous|demonstrated|proven|professional|commercial|hands-on|strong|practical|solid)\\s+)*(?:experience|proficiency|expertise|familiarity|knowledge|understanding)\\s+(?:with|in|of|using|building|designing|developing)\\b|^(?:a |an )?(?:bachelor['’]?s|master['’]?s|doctoral|doctorate|ph\\.?d\\.?|college|university)\\b.{0,65}\\b(?:degree|required|preferred)\\b|^(?:required|preferred|minimum|prior)\\s+(?:skills?|experience|qualifications?)\\s*[:：]`,
  'iu',
);
const applicantQualification = new RegExp(
  `\\b(?:you|candidates?|applicants?|employees?|new hires?)\\s+(?:(?:must|should|need to|are required to|are expected to)\\s+(?:already\\s+)?(?:have|hold|possess|demonstrate|bring|be|show)\\s+|(?:must|should|need to)\\s+(?:already\\s+)?)(?:a minimum of |at least )?(?:${tenureQualification}|(?:prior |previous |professional |commercial |hands-on )?experience|proficien\\w*|familiarity|fluen\\w*|certif\\w*|(?:a |an )?(?:degree|licen[cs]e|diploma)|already (?:have|know))\\b|\\b(?:prior|previous|professional|commercial) experience\\b.{0,90}\\b(?:is|are)\\s+(?:required|preferred|mandatory)\\b`,
  'iu',
);
const actualCredential =
  /\b(?:you|candidates?|applicants?|employees?)\s+(?:must|should|need to|are required to)\s+(?:(?:have|hold|possess)\s+(?:a |an )?(?:bachelor['’]?s|master['’]?s|doctorate|ph\.?d\.?|[a-z]+ licen[cs]e)\b|(?:speak|write|read)\s+(?:fluent|native|professional)\b)/iu;
const workRestriction =
  /\b(?:work(?:ing)? (?:hours|weekends?|evenings?|nights?|shifts?|on[- ]call|full[- ]time|part[- ]time|on[- ]?site|from\s+(?:the\s+)?office)|overlap (?:with |our )?(?:[a-z]{2,4}\s+)?business hours|available (?:to work|during|from|between|\d|on weekends?|in (?:the )?(?:mornings?|evenings?))|availability (?:to work|during|from|between|\d|on weekends?|in (?:the )?(?:mornings?|evenings?))|be (?:based|located|resident) in|reside in|live in|relocate|travel(?:ling)? (?:as needed|as required|up to|for work)|commut(?:e|ing) (?:to|into)|remote (?:only|within|from|in)|on[- ]call (?:rotation|coverage|availability)|minimum weekly hours)\b/iu;
const standaloneWork =
  /^(?:(?:must|should|need to|required to|willing(?:ness)? to|ability to|able to)\s+)?(?:work(?:ing)? (?:hours|weekends?|evenings?|nights?|shifts?|on[- ]call|full[- ]time|part[- ]time|on[- ]?site)|overlap (?:with |our )?(?:[a-z]{2,4}\s+)?business hours|available (?:to work|during|from|between|\d|on weekends?)|availability (?:to work|during|from|between|\d|on weekends?)|be (?:based|located) in|reside in|live in|relocat\w*|remote (?:only|within|from|in)|on[- ]call (?:rotation|coverage|availability)|travel (?:as needed|as required|is required|required)|(?:business|working) hours\s*[:：])/iu;
const workWithApplicant =
  /\b(?:you|candidates?|applicants?|employees?)\s+(?:must|should|need to|are required to|are expected to|have to)\s+(?:be\s+)?/iu;
const directEligibility =
  /\b(?:only|exclusively)\s+(?:for\s+)?(?:applicants?|candidates?|residents?)\s+(?:based\s+|located\s+|living\s+)?in\b|\b(?:candidates?|applicants?|residents?)\s+(?:based\s+|located\s+|living\s+)?in\b.{1,50}\bonly\b|\b(?:residents?|citizens?)\s+of\b.{1,55}\b(?:only|may apply)\b|\b(?:candidates?|applicants?|you)\s+(?:must|need to|are required to)\s+(?:be\s+)?available\s+(?:for\s+)?(?:at least\s+)?\d+\s+hours?\s+(?:a|per)\s+week\b/iu;
const deadline =
  /\b(?:within\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twenty[- ]four|forty[- ]eight)\s+(?:hours?|days?|weeks?)|by\s+(?:(?:the\s+)?end of (?:the\s+)?(?:day|week|month)|eod\b|(?:next\s+|this\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d|\d{1,4}[-/:]\d|\d{1,2}\s*(?:am|pm|utc|gmt)\b|midnight|noon)|before\s+(?:the\s+)?(?:deadline|interview|\d|midnight|noon)|no later than\b)\b/iu;
const exerciseSubmission =
  /^(?:(?:please|you (?:must|need to|should)|candidates? (?:must|need to|should)|applicants? (?:must|need to|should))\s+)?(?:submit|send|complete|return|finish|deliver|upload)\b|\b(?:submit|send|complete|return|finish|deliver|upload)\s+(?:(?:the|your|this|a)\s+)?(?:take[-‐‑– ]home(?: assignment)?|coding (?:exercise|assignment)|work sample|assignment|submission|solution|deliverables?)\b/iu;
const deadlineLabel =
  /^(?:(?:application|candidate|assignment|exercise|submission|take[-‐‑– ]home)\s+)?(?:deadline|due date)\s*[:：]|^(?:submissions?|(?:the )?(?:assignment|exercise|take[-‐‑– ]home))\s+(?:(?:is|are)\s+)?due\b|^due\s+(?:by|on|within|before)\b|^(?:please\s+)?(?:spend|take)\s+(?:at least|at most|no more than|no less than)\s+\d+\s+hours?\b/iu;

/** Veto exercise-context treatment only for visible actual applicant scope.
 * The independent verifier still needs to evaluate every other unit. */
export function matchingSourceJevExerciseCondition(quote: string): boolean {
  const visible = quote.replace(/<[^<>\n]+>/gu, ' ').replace(/&nbsp;/giu, ' ');
  if (injection.test(visible) || analyzerDirective.test(quote)) return true;
  return visible
    .split(/(?<=[.!?;])\s+|\s+\b(?:but|however|whereas)\b\s+/iu)
    .some((part) => {
      const text = part
        .trim()
        .replace(/^[-*•]\s+/u, '')
        .replace(/^\*\*(.*?)\*\*$/u, '$1');
      const actual = applicantActor.test(text) || workWithApplicant.test(text);
      const fictional = productActor.test(text) && !actual;
      return (
        matchingSourceTypedPriorExperience(text) ||
        priorQualification.test(text) ||
        applicantQualification.test(text) ||
        actualCredential.test(text) ||
        (!fictional && directEligibility.test(text)) ||
        (legalCondition.test(text) && !fictional) ||
        (!fictional &&
          (standaloneWork.test(text) ||
            (actual && workRestriction.test(text)))) ||
        (!fictional && deadlineLabel.test(text)) ||
        (exerciseSubmission.test(text) &&
          deadline.test(text) &&
          (!fictional || actual))
      );
    });
}

/** Admit only source-side submission logistics under an exact application heading. */
export function matchingSourceJevApplicationSubmission(
  quote: string,
  governingHeading: string | undefined,
): { auditQuote: string; citationText: string } | null {
  if (
    !governingHeading ||
    !/^(?:how to apply|application (?:process|instructions|submission)|submitting your application)$/iu.test(
      governingHeading,
    ) ||
    !/^(?:(?:please|to apply[, :]?)\s+)?(?:e-?mail|send|submit|upload|include)\b/iu.test(
      quote,
    ) ||
    !/\b(?:portfolio|résumé|resume|CV|cover letter|references?|work sample|repository|application materials)\b/iu.test(
      quote,
    ) ||
    matchingSourceOperatorDirective(quote)
  )
    return null;
  const mailbox = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/giu;
  const first = quote.search(mailbox);
  const auditQuote = quote.replace(mailbox, '[contact removed]');
  const citationText = (first < 0 ? quote : quote.slice(0, first)).trimEnd();
  if (
    !citationText ||
    hasAnalysisPII(auditQuote) ||
    matchingSourceJevExerciseCondition(auditQuote)
  )
    return null;
  return { auditQuote, citationText };
}
