import { describe, expect, it } from 'vitest';
import {
  submittedByRoleDefinitions,
  taskAssigneeRoleDefinitions,
  workflowLabel,
} from '$lib/objects/workflow';
import { overviewOpportunity, prioritizeOverviewTasks } from './overview';

function currentAssessment(score = 81) {
  return {
    sourceStatus: 'current',
    eligibilityBucket: 'eligible',
    matchReadiness: 'assessable',
    coverage: {
      candidateTruncated: false,
      postingTruncated: false,
      requirementsTruncated: false,
      requirementCount: 4,
    },
    ranking: { eligibilityPriority: 0, fitScore: score, excluded: false },
  };
}

describe('overview presentation', () => {
  it('prioritizes overdue work and user action while keeping blocked and finished work out of the way', () => {
    const tasks = prioritizeOverviewTasks(
      [
        { id: 'closed', status: 'done' },
        { id: 'agent', status: 'open', assigneeRole: 'hermes' },
        {
          id: 'blocked',
          status: 'blocked',
          dueAt: '2026-10-01',
          assigneeRole: 'owner',
        },
        {
          id: 'review',
          status: 'open',
          assigneeRole: 'owner',
          kanbanColumn: 'ready_for_user_review',
        },
        {
          id: 'overdue',
          status: 'open',
          dueAt: '2026-10-01',
          assigneeRole: 'owner',
        },
      ],
      Date.parse('2026-10-02'),
    );
    expect(tasks.map((task) => task.id)).toEqual([
      'overdue',
      'review',
      'agent',
      'blocked',
    ]);
    expect(tasks[0].priority).toBe('Overdue');
    expect(tasks[1].priority).toBe('Needs your action');
    expect(tasks[2].assignee).toBe('Agent');
    expect(tasks[2].priority).toBe('Open task');
  });

  it('renders Agent labels without changing stored role values', () => {
    expect(workflowLabel('hermes')).toBe('Agent');
    expect(
      taskAssigneeRoleDefinitions.find((role) => role.value === 'hermes')
        ?.label,
    ).toBe('Agent');
    expect(
      submittedByRoleDefinitions.find((role) => role.value === 'hermes')?.label,
    ).toBe('Agent');
    expect(workflowLabel('some_other_role')).toBe('Some Other Role');
  });

  it('uses only a complete current assessment for the displayed match score', () => {
    const opportunity = {
      id: 'new',
      title: 'Engineer',
      status: 'found',
      latestScore: 99,
      assessmentProjection: currentAssessment(),
    };
    expect(overviewOpportunity(opportunity)?.fitScore).toBe(81);
    expect(
      overviewOpportunity({ ...opportunity, assessmentProjection: null })
        ?.fitScore,
    ).toBeNull();
    expect(
      overviewOpportunity({
        ...opportunity,
        assessmentProjection: { ...currentAssessment(), sourceStatus: 'stale' },
      })?.fitScore,
    ).toBeNull();
    expect(
      overviewOpportunity({
        ...opportunity,
        assessmentProjection: { ...currentAssessment(), coverage: null },
      })?.fitScore,
    ).toBeNull();
    expect(
      overviewOpportunity({
        ...opportunity,
        assessmentProjection: currentAssessment(101),
      })?.fitScore,
    ).toBeNull();
  });

  it('does not present existing drafts, applied postings, or excluded projections as new matches', () => {
    const opportunity = {
      id: 'new',
      status: 'found',
      assessmentProjection: currentAssessment(),
    };
    expect(
      overviewOpportunity({
        ...opportunity,
        applicationId: 'draft',
        applicationStatus: 'awaiting_user',
        humanReviewStatus: 'needs_input',
      }),
    ).toBeNull();
    expect(
      overviewOpportunity({ ...opportunity, status: 'applied' }),
    ).toBeNull();
    expect(
      overviewOpportunity({
        ...opportunity,
        assessmentProjection: {
          ...currentAssessment(),
          eligibilityBucket: 'location_restriction',
        },
      }),
    ).toBeNull();
    expect(
      overviewOpportunity({
        ...opportunity,
        assessmentProjection: {
          ...currentAssessment(),
          ranking: { eligibilityPriority: 0, fitScore: 90, excluded: true },
        },
      }),
    ).toBeNull();
  });
});
