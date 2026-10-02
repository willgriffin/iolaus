import { describe, expect, it } from 'vitest';
import { listApiExposedResources } from './api-exposure';
import { apiResourceClasses, getApiResourceClass } from './api-resources';

/**
 * Every slug the former hand-maintained REST map accepted. Each must still
 * resolve to the same class now that exposure derives from the decorators.
 */
const legacySlugs: Record<string, string> = {
  companies: 'Company',
  companyattachments: 'CompanyAttachment',
  companyresearches: 'CompanyResearch',
  companytags: 'CompanyTag',
  decisions: 'Decision',
  decisiontags: 'DecisionTag',
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
  it('keeps every legacy REST slug resolving to the same class', () => {
    for (const [slug, className] of Object.entries(legacySlugs)) {
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

  it('exposes only public company research under its alternate table spelling', () => {
    expect(getApiResourceClass('company_research')).toBe('CompanyResearch');
  });

  it('keeps decorator-hidden and foreign classes off REST', () => {
    expect(getApiResourceClass('candidateanswers')).toBeUndefined();
    expect(getApiResourceClass('candidate_answers')).toBeUndefined();
    expect(getApiResourceClass('candidateprofiles')).toBeUndefined();
    expect(getApiResourceClass('candidate_profiles')).toBeUndefined();
    expect(getApiResourceClass('candidateprofilelinks')).toBeUndefined();
    expect(getApiResourceClass('candidate_profile_links')).toBeUndefined();
    expect(getApiResourceClass('cliauthrequests')).toBeUndefined();
    expect(getApiResourceClass('people')).toBeUndefined();
    expect(getApiResourceClass('employmentpersons')).toBeUndefined();
    expect(getApiResourceClass('experiences')).toBeUndefined();
    expect(getApiResourceClass('achievements')).toBeUndefined();
    expect(getApiResourceClass('resumetailoringconfigs')).toBeUndefined();
    expect(getApiResourceClass('resumeprofiles')).toBeUndefined();
    expect(getApiResourceClass('resumepositions')).toBeUndefined();
    expect(getApiResourceClass('tasks')).toBeUndefined();
    expect(getApiResourceClass('agentruns')).toBeUndefined();
    expect(getApiResourceClass('applications')).toBeUndefined();
    expect(
      getApiResourceClass('application_material_comments'),
    ).toBeUndefined();
    expect(getApiResourceClass('evaluationscores')).toBeUndefined();
    expect(getApiResourceClass('factcandidates')).toBeUndefined();
    expect(getApiResourceClass('factintakes')).toBeUndefined();
    expect(getApiResourceClass('preferencerules')).toBeUndefined();
    expect(getApiResourceClass('resumeassets')).toBeUndefined();
    expect(getApiResourceClass('resumevariants')).toBeUndefined();
    expect(getApiResourceClass('users')).toBeUndefined();
    expect(getApiResourceClass('profiles')).toBeUndefined();
    expect(getApiResourceClass('sessions')).toBeUndefined();
  });
});
