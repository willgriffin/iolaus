import { describe, expect, it } from 'vitest';
import {
  agentRunAuditOperations,
  opportunityReviewOperations,
  postingPreflightOperations,
  publicProfileWorkflowOperations,
  uniqueWorkflowOperations,
  type WorkflowOperation,
} from './workflow-operations';

function includesEvery(
  set: readonly WorkflowOperation[],
  required: readonly WorkflowOperation[],
): boolean {
  return required.every((operation) =>
    set.some(
      (candidate) =>
        candidate.collection === operation.collection &&
        candidate.action === operation.action,
    ),
  );
}

describe('workflow-operations', () => {
  it('declares the AgentRun audit surrogate as the audit-log read', () => {
    // `AgentRun` is api list/get only, so no create permission can be asserted.
    expect(agentRunAuditOperations).toEqual([
      { action: 'read', collection: 'agentruns' },
    ]);
  });

  it.each([
    { name: 'postingPreflightOperations', set: postingPreflightOperations },
  ])('$name asserts the AgentRun audit surrogate because its run writes an audit run', ({
    set,
  }) => {
    expect(includesEvery(set, agentRunAuditOperations)).toBe(true);
  });

  it('asserts the opportunity read the review and processing actions perform', () => {
    expect(
      includesEvery(opportunityReviewOperations, [
        { action: 'read', collection: 'opportunities' },
        { action: 'update', collection: 'opportunities' },
      ]),
    ).toBe(true);
  });

  it('binds the public-profile lifecycle tools to the curated page capability only', () => {
    // The service asserts `workflow.public-profile.manage` at every fence and
    // grants no generic CRUD, so the tools must assert exactly that and no
    // collection permission the admin page does not require.
    expect(publicProfileWorkflowOperations).toEqual([
      { action: 'public-profile.manage', collection: 'workflow' },
    ]);
  });

  it('deduplicates operations while preserving order', () => {
    expect(
      uniqueWorkflowOperations([
        ...postingPreflightOperations,
        ...agentRunAuditOperations,
        { action: 'read', collection: 'opportunities' },
      ]),
    ).toEqual([
      { action: 'read', collection: 'opportunities' },
      { action: 'read', collection: 'agentruns' },
    ]);
  });
});
