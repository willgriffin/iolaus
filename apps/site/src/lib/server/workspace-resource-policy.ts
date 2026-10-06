import { error } from '@sveltejs/kit';
import { isSharedHosted } from './app-config.js';
import {
  candidateProfileWhere,
  privateRecordWhere,
  requireWorkspaceSubject,
} from './private-workspace.js';
import {
  getCurrentWorkspaceSubject,
  isCurrentWorkspaceOperator,
} from './workspace-subject.js';

/** Personal records must never inherit the global catalog's query scope. */
export const privateWorkspaceClasses = new Set([
  'CandidateProfile',
  'CandidateAnswer',
  'CandidateProfileLink',
  'Application',
  'ApplicationMaterialComment',
  'ResumeAsset',
  'ResumeVariant',
  'ResumeProfile',
  'PreferenceRule',
  'Decision',
  'DecisionTag',
  'Task',
  'AgentRun',
  'Achievement',
  'AchievementAttachment',
  'AchievementTag',
  'Attachment',
  'Duty',
  'DutyTag',
  'Education',
  'EducationTag',
  'EmploymentRole',
  'EmploymentRoleTag',
  'Experience',
  'ExperienceCompany',
  'ExperienceRole',
  'ExperienceTag',
  'Project',
  'ProjectAttachment',
  'ProjectTag',
  'ResumeAchievement',
  'ResumeEducation',
  'ResumeLink',
  'ResumeOtherRole',
  'ResumePosition',
  'ResumeSkill',
  'ResumeSkillCategory',
  'ResumeSkillGroup',
  'ResumeTailoringConfig',
  'SkillCategory',
  'SkillCategoryMember',
  'SkillGroup',
  'SkillGroupMember',
  'FactCandidate',
  'FactIntake',
  'EvaluationScore',
  'OpportunityAssessment',
  'OpportunityIntelligenceRequest',
  'OpportunityIntelligenceResult',
]);

const scopedWorkflowOnlyClasses = new Set([
  'Fact',
  'FactContent',
  'FactEvidence',
  'FactSubject',
  'OpportunityIntelligenceControl',
]);

export function workspaceResourceReadable(className: string): boolean {
  return !isSharedHosted() || !scopedWorkflowOnlyClasses.has(className);
}

export function workspaceResourceWhere(
  className: string,
): Record<string, unknown> {
  if (!isSharedHosted()) return {};
  if (!workspaceResourceReadable(className))
    error(403, 'Use the scoped workspace workflow for this resource.');
  if (!privateWorkspaceClasses.has(className)) return {};
  const subject = getCurrentWorkspaceSubject();
  if (!subject?.profileId)
    error(subject ? 409 : 403, 'A verified candidate workspace is required.');
  return className === 'CandidateProfile'
    ? { ...candidateProfileWhere(subject), id: subject.profileId }
    : privateRecordWhere({ ...subject, profileId: subject.profileId });
}

export function workspaceRecordAllowed(
  className: string,
  record: unknown,
): boolean {
  const where = workspaceResourceWhere(className);
  if (!record || typeof record !== 'object') return false;
  return Object.entries(where).every(
    ([key, value]) => (record as Record<string, unknown>)[key] === value,
  );
}

export function workspaceResourcePayload(
  className: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const where = workspaceResourceWhere(className);
  for (const [key, value] of Object.entries(where)) {
    if (key in payload && payload[key] !== value)
      error(403, 'Record ownership cannot be changed.');
  }
  return { ...payload, ...where };
}

export function assertWorkspaceResourceWritable(className: string): void {
  if (!workspaceResourceReadable(className))
    error(403, 'Use the scoped workspace workflow for this resource.');
  if (
    isSharedHosted() &&
    !privateWorkspaceClasses.has(className) &&
    !isCurrentWorkspaceOperator()
  ) {
    error(403, 'Shared catalog changes require an installation operator.');
  }
}

/** Raw catalog records contain legacy operator fields; hosted users use the dedicated projections. */
export function assertGenericResourceAccess(): void {
  if (isSharedHosted() && !isCurrentWorkspaceOperator()) {
    error(
      403,
      'Use the workspace workflow for candidate data and opportunity results.',
    );
  }
}

export function requireCandidateWorkspaceSubject() {
  const subject = getCurrentWorkspaceSubject();
  if (!subject?.profileId)
    error(
      subject ? 409 : 403,
      'A candidate profile is required. Complete onboarding to create one.',
    );
  return requireWorkspaceSubject({ ...subject, profileId: subject.profileId });
}

/** Event feeds use only the tenant context revalidated by the session hook. */
export function assertWorkspaceEventContext(): void {
  if (isSharedHosted() && !getCurrentWorkspaceSubject()) {
    error(403, 'A verified workspace is required for live updates.');
  }
}
