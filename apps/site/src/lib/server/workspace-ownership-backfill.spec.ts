import { describe, expect, it } from 'vitest';
import {
  requireWorkspaceOwnershipBinding,
  workspaceOwnershipTableName,
} from './workspace-ownership-backfill.js';

describe('workspace ownership backfill contract', () => {
  it('derives stable model table names for the complete private manifest', () => {
    expect(workspaceOwnershipTableName('CandidateProfile')).toBe(
      'candidate_profiles',
    );
    expect(workspaceOwnershipTableName('ResumeSkillCategory')).toBe(
      'resume_skill_categories',
    );
    expect(workspaceOwnershipTableName('DecisionTag')).toBe('decision_tags');
    expect(workspaceOwnershipTableName('Education')).toBe('education');
    expect(workspaceOwnershipTableName('ResumeEducation')).toBe(
      'resume_education',
    );
  });

  it('requires all three canonical identifiers before inspecting a database', () => {
    expect(() =>
      requireWorkspaceOwnershipBinding({
        candidateProfileId: 'profile-1',
        ownerUserId: '',
        tenantId: 'tenant-1',
      }),
    ).toThrow('owner user ID');
    expect(() =>
      requireWorkspaceOwnershipBinding({
        candidateProfileId: 'profile\n1',
        ownerUserId: 'user-1',
        tenantId: 'tenant-1',
      }),
    ).toThrow('candidate profile ID');
  });
});
