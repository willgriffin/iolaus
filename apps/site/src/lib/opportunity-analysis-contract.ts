/** Public, source-derived opportunity analysis. Never contains candidate data. */
export const OPPORTUNITY_ANALYSIS_VERSION = 'opportunity-analysis/v1';

export type OpportunityAnalysisStatus =
  | 'pending'
  | 'deterministic'
  | 'enriched'
  | 'failed';
export type OpportunityAnalysisSkill = {
  slug: string;
  label: string;
  kind: 'required' | 'preferred';
  confidence: number;
  evidence: Array<{ start: number; end: number; quote?: string }>;
};
export type OpportunityAnalysisSnapshot = {
  id: string;
  opportunityId: string;
  sourceContentFingerprint: string;
  sourceContentVersion: number;
  analysisVersion: typeof OPPORTUNITY_ANALYSIS_VERSION;
  status: OpportunityAnalysisStatus;
  normalizedTitle: string;
  seniority: string;
  function: string;
  workMode: string;
  employmentType: string;
  skills: OpportunityAnalysisSkill[];
  requirements: Array<{
    hash: string;
    text: string;
    kind: 'must' | 'should' | 'nice';
    category: string;
    years?: number;
    skills: string[];
    evidence: Array<{ start: number; end: number }>;
  }>;
  skillSlugs: string[];
  summaryBullets: string[];
  eligibility: {
    remote: boolean | null;
    countries: string[];
    regions: string[];
    timezones: string[];
    flags: number;
    workAuthorization: {
      required: string[];
      sponsorship: 'yes' | 'no' | 'unknown';
    };
  };
  /** Only compensation posted in the source; inferred compensation is excluded. */
  compensation: {
    currency?: string;
    min?: number;
    max?: number;
    period?: string;
    source: 'posted';
  } | null;
  errorCode?: string;
};
