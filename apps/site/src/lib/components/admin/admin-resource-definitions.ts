import type { SmrtWebCollectionDefinition } from '@happyvertical/smrt-web';

const ADMIN_LIVE_RESOURCE_CLASSES = {
  applications: 'Application',
  opportunities: 'Opportunity',
  tasks: 'Task',
} as const;

export type HydratedAdminResourceSlug =
  keyof typeof ADMIN_LIVE_RESOURCE_CLASSES;

export function isHydratedAdminResourceSlug(
  slug: string,
): slug is HydratedAdminResourceSlug {
  return Object.hasOwn(ADMIN_LIVE_RESOURCE_CLASSES, slug);
}

/**
 * Cache identity for curated admin reads, independent of the public web registry.
 * AdminResource owns the display fields. This metadata grants no CRUD or tools;
 * the explicit list fetcher uses the subject-guarded admin route.
 */
export function getAdminResourceCollectionDefinition(
  slug: string,
): SmrtWebCollectionDefinition<Record<string, unknown>> {
  if (!isHydratedAdminResourceSlug(slug)) {
    throw new Error(`Unsupported hydrated admin resource: ${slug}`);
  }
  return {
    name: slug,
    className: ADMIN_LIVE_RESOURCE_CLASSES[slug],
    endpoint: `/admin-resources/${slug}`,
    idField: 'id',
    actions: ['list'],
    fields: {},
  };
}
