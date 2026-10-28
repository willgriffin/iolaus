import { describe, expect, it } from 'vitest';
import { listApiExposedResources } from './api-exposure';
import { apiResourceClasses, getApiResourceClass } from './api-resources';

/**
 * Public catalog slugs the former hand-maintained REST map accepted. Each
 * must still resolve to the same class now that exposure derives from the
 * decorators. Candidate-owned records intentionally leave this map.
 */
const publicLegacySlugs: Record<string, string> = {
  companies: 'Company',
  companyattachments: 'CompanyAttachment',
  companyresearches: 'CompanyResearch',
  companytags: 'CompanyTag',
  factcontents: 'FactContent',
  factevidences: 'FactEvidence',
  facts: 'Fact',
  factsources: 'FactSource',
  factsubjects: 'FactSubject',
  facttags: 'FactTag',
  opportunities: 'Opportunity',
  opportunitycompanies: 'OpportunityCompany',
  opportunityplaces: 'OpportunityPlace',
  opportunityroles: 'OpportunityRole',
  opportunitytags: 'OpportunityTag',
  sourcecrawlitems: 'SourceCrawlItem',
  sourcecrawls: 'SourceCrawl',
  sources: 'Source',
  sourcetags: 'SourceTag',
};

describe('apiResourceClasses', () => {
  it('keeps public legacy REST slugs resolving to the same class', () => {
    for (const [slug, className] of Object.entries(publicLegacySlugs)) {
      expect(getApiResourceClass(slug), slug).toBe(className);
      expect(apiResourceClasses[slug], slug).toBe(className);
    }
    expect(getApiResourceClass('SOURCES')).toBe('Source');
  });

  it('derives the map from the decorator api includes', () => {
    const exposed = new Set(
      listApiExposedResources().map((resource) => resource.className),
    );
    expect(new Set(Object.values(apiResourceClasses))).toEqual(exposed);
    for (const resource of listApiExposedResources()) {
      expect(apiResourceClasses[resource.slug]).toBe(resource.className);
      expect(apiResourceClasses[resource.tableName]).toBe(resource.className);
    }
  });

  it('resolves the owner-scoped career model under canonical and table spellings', () => {
    // Opted in by #259; the routes scope every read and write to the
    // verified workspace subject (scoped-resource-crud.ts).
    expect(getApiResourceClass('candidateprofiles')).toBe('CandidateProfile');
    expect(getApiResourceClass('candidate_profiles')).toBe('CandidateProfile');
    expect(getApiResourceClass('candidateprofilelinks')).toBe(
      'CandidateProfileLink',
    );
    expect(getApiResourceClass('experiences')).toBe('Experience');
    expect(getApiResourceClass('achievements')).toBe('Achievement');
    expect(getApiResourceClass('skill_categories')).toBe('SkillCategory');
  });

  it('resolves the owner-scoped private workspace classes (tranche b)', () => {
    expect(getApiResourceClass('applications')).toBe('Application');
    expect(getApiResourceClass('tasks')).toBe('Task');
    expect(getApiResourceClass('decisions')).toBe('Decision');
    expect(getApiResourceClass('preferencerules')).toBe('PreferenceRule');
    expect(getApiResourceClass('resume_variants')).toBe('ResumeVariant');
    expect(getApiResourceClass('candidate_answers')).toBeUndefined();
    expect(getApiResourceClass('agentruns')).toBe('AgentRun');
    expect(getApiResourceClass('resumeprofiles')).toBeUndefined();
    expect(getApiResourceClass('resume_positions')).toBeUndefined();
  });

  it('exposes only public company research under its alternate table spelling', () => {
    expect(getApiResourceClass('company_research')).toBe('CompanyResearch');
  });

  it('keeps decorator-hidden and foreign classes off REST', () => {
    expect(getApiResourceClass('cliauthrequests')).toBeUndefined();
    expect(getApiResourceClass('people')).toBeUndefined();
    expect(getApiResourceClass('employmentpersons')).toBeUndefined();
    expect(getApiResourceClass('resumeprofiles')).toBeUndefined();
    expect(getApiResourceClass('resumepositions')).toBeUndefined();
    expect(getApiResourceClass('users')).toBeUndefined();
    expect(getApiResourceClass('profiles')).toBeUndefined();
    expect(getApiResourceClass('sessions')).toBeUndefined();
  });
});
