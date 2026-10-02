import {
  deriveOperationPermissionSlug,
  PermissionCatalogService,
} from '@happyvertical/smrt-users';
import { describe, expect, it } from 'vitest';
import {
  workspaceWorkflowCapabilityDefinitions,
  workspaceWorkflowOperation,
} from './workspace-workflow-capabilities';

describe('workspace workflow capabilities', () => {
  it('registers every declared operation in the native permission catalog', () => {
    const catalog = PermissionCatalogService.create().getCatalog();
    const slugs = new Set(catalog.permissions.map(({ slug }) => slug));

    for (const { slug } of workspaceWorkflowCapabilityDefinitions) {
      expect(slugs).toContain(slug);
    }
  });

  it('returns the collection/action pair used by native operation guards', () => {
    const operation = workspaceWorkflowOperation('application.prepare');

    expect(operation).toEqual({
      action: 'application.prepare',
      collection: 'workflow',
    });
    expect(
      deriveOperationPermissionSlug(operation.collection, operation.action),
    ).toBe('workflow.application.prepare');
  });
});
