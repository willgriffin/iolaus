import { describe, expect, it } from 'vitest';
import { listApiExposedResources } from './api-exposure';
import { apiResourceClasses, getApiResourceClass } from './api-resources';

/**
 * Every slug the former hand-maintained REST map accepted. Each must still
 * resolve to the same class now that exposure derives from the decorators.
 */
const legacySlugs: Record<string, string> = {
  agentruns: 'AgentRun',
  achievements: 'Achievement',
  achievementattachments: 'AchievementAttachment',
  achievementtags: 'AchievementTag',
  applications: 'Application',
  attachments: 'Attachment',
  candidateprofilelinks: 'CandidateProfileLink',
  companies: 'Company',
  companyattachments: 'CompanyAttachment',
  companyresearches: 'CompanyResearch',
  companytags: 'CompanyTag',
  decisions: 'Decision',
  decisiontags: 'DecisionTag',
  duties: 'Duty',
  dutytags: 'DutyTag',
  education: 'Education',
  educations: 'Education',
  educationtags: 'EducationTag',
  employmentroles: 'EmploymentRole',
  employmentroletags: 'EmploymentRoleTag',
  evaluationscores: 'EvaluationScore',
  experiencecompanies: 'ExperienceCompany',
  experienceroles: 'ExperienceRole',
  experiences: 'Experience',
  experiencetags: 'ExperienceTag',
  factcontents: 'FactContent',
  factevidences: 'FactEvidence',
  facts: 'Fact',
  factcandidates: 'FactCandidate',
  factintakes: 'FactIntake',
  factsources: 'FactSource',
  factsubjects: 'FactSubject',
  facttags: 'FactTag',
  opportunities: 'Opportunity',
  opportunitycompanies: 'OpportunityCompany',
  opportunityplaces: 'OpportunityPlace',
  opportunityroles: 'OpportunityRole',
  opportunitytags: 'OpportunityTag',
  preferencerules: 'PreferenceRule',
  projectattachments: 'ProjectAttachment',
  projects: 'Project',
  projecttags: 'ProjectTag',
  resumeassets: 'ResumeAsset',
  resumetailoringconfigs: 'ResumeTailoringConfig',
  resumevariants: 'ResumeVariant',
  sourcecrawlitems: 'SourceCrawlItem',
  sourcecrawls: 'SourceCrawl',
  skillcategories: 'SkillCategory',
  skillcategorymembers: 'SkillCategoryMember',
  skillgroupmembers: 'SkillGroupMember',
  skillgroups: 'SkillGroup',
  sources: 'Source',
  sourcetags: 'SourceTag',
  tasks: 'Task',
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

  it('exposes resume content classes under both slug spellings', () => {
    expect(getApiResourceClass('resumeprofiles')).toBe('ResumeProfile');
    expect(getApiResourceClass('resume_profiles')).toBe('ResumeProfile');
    expect(getApiResourceClass('resumepositions')).toBe('ResumePosition');
    expect(getApiResourceClass('resume_skill_categories')).toBe(
      'ResumeSkillCategory',
    );
    expect(getApiResourceClass('agent_runs')).toBe('AgentRun');
    expect(getApiResourceClass('company_research')).toBe('CompanyResearch');
  });

  it('keeps decorator-hidden and foreign classes off REST', () => {
    expect(getApiResourceClass('candidateanswers')).toBeUndefined();
    expect(getApiResourceClass('candidate_answers')).toBeUndefined();
    expect(getApiResourceClass('candidateprofiles')).toBeUndefined();
    expect(getApiResourceClass('candidate_profiles')).toBeUndefined();
    expect(getApiResourceClass('cliauthrequests')).toBeUndefined();
    expect(getApiResourceClass('people')).toBeUndefined();
    expect(getApiResourceClass('employmentpersons')).toBeUndefined();
    expect(getApiResourceClass('users')).toBeUndefined();
    expect(getApiResourceClass('profiles')).toBeUndefined();
    expect(getApiResourceClass('sessions')).toBeUndefined();
  });
});
