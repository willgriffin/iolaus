import {
  apiResourceSlugs,
  listApiExposedResources,
  resolveApiResource,
} from './api-exposure.js';

/**
 * Backward-compatible view of the decorator-derived REST exposure: every
 * accepted slug spelling mapped to its class name. New code should call
 * `resolveApiResource()` from `api-exposure.ts`, which also returns the
 * exposed action set.
 */
export const apiResourceClasses: Record<string, string> = Object.fromEntries(
  listApiExposedResources().flatMap((resource) =>
    apiResourceSlugs(resource).map((slug) => [slug, resource.className]),
  ),
);

export function getApiResourceClass(resource: string): string | undefined {
  return resolveApiResource(resource)?.className;
}
