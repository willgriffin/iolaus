import {
  type PermissionDefinition,
  registerPermissionDefinitions,
} from '@happyvertical/smrt-users';

/**
 * Deliberate workflow permissions that remain available after generic private
 * model CRUD is removed from the public API surface. Every caller must still
 * enforce the verified workspace subject against the target record.
 */
export const workspaceWorkflowCapabilityDefinitions = [
  {
    category: 'workspace-workflow',
    description: 'Run a scoped opportunity assessment for the active profile.',
    name: 'Execute opportunity assessment',
    slug: 'workflow.assessment.execute',
  },
  {
    category: 'workspace-workflow',
    description: 'Prepare an application for the active profile.',
    name: 'Prepare application',
    slug: 'workflow.application.prepare',
  },
  {
    category: 'workspace-workflow',
    description: 'Inspect an owned application or its scoped opportunity.',
    name: 'Inspect application',
    slug: 'workflow.application.inspect',
  },
  {
    category: 'workspace-workflow',
    description:
      'Open the scoped human-review workflow for an owned application.',
    name: 'Review application',
    slug: 'workflow.application.review',
  },
  {
    category: 'workspace-workflow',
    description: 'Manage the active user profile and its owned workspace data.',
    name: 'Manage profile',
    slug: 'workflow.profile.manage',
  },
  {
    category: 'workspace-workflow',
    description:
      'Prepare and publish the signed-in account public resume profile.',
    name: 'Publish public profile',
    slug: 'workflow.public-profile.manage',
  },
  {
    category: 'workspace-workflow',
    description: 'Manage the signed-in account shortlist.',
    name: 'Manage shortlist',
    slug: 'workflow.shortlist.manage',
  },
  {
    category: 'workspace-workflow',
    description: 'Record audit facts for an owned workflow action.',
    name: 'Record workflow audit',
    slug: 'workflow.audit.record',
  },
  {
    category: 'workspace-workflow',
    description: 'Synchronize tasks owned by the active workspace subject.',
    name: 'Synchronize tasks',
    slug: 'workflow.task.sync',
  },
  {
    category: 'workspace-workflow',
    description:
      'Execute a final approved auto-submit for an owned application.',
    name: 'Execute application auto-submit',
    slug: 'workflow.application-auto-submit.execute',
  },
] as const satisfies readonly PermissionDefinition[];

export type WorkspaceWorkflowCapability =
  | 'assessment.execute'
  | 'application.prepare'
  | 'application.inspect'
  | 'application.review'
  | 'profile.manage'
  | 'shortlist.manage'
  | 'public-profile.manage'
  | 'audit.record'
  | 'task.sync'
  | 'application-auto-submit.execute';

export const workspaceWorkflowCapabilitySlugs =
  workspaceWorkflowCapabilityDefinitions.map(({ slug }) => slug);

const registeredCapabilitySlugs = new Set<string>(
  workspaceWorkflowCapabilitySlugs,
);

// Registration is process-scoped and intentionally retained for the runtime.
// Migrations and login provisioning import this module before they seed roles.
registerPermissionDefinitions([...workspaceWorkflowCapabilityDefinitions]);

/**
 * Return the exact collection/action pair accepted by PrincipalRun's native
 * assertOperation guard. The resulting permission slug is `workflow.<action>`.
 */
export function workspaceWorkflowOperation(
  capability: WorkspaceWorkflowCapability,
): { action: WorkspaceWorkflowCapability; collection: 'workflow' } {
  const slug = `workflow.${capability}`;
  if (!registeredCapabilitySlugs.has(slug)) {
    throw new Error(`Unknown workspace workflow capability: ${capability}`);
  }
  return { action: capability, collection: 'workflow' };
}
