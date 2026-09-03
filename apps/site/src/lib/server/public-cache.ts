/**
 * The published resume is public and has its own write invalidation path.
 * Keep browser caches revalidating while allowing a configured shared cache to
 * collapse cold requests across the two site replicas. `must-revalidate`
 * prevents an intermediary from serving a stale resume after the short shared
 * TTL.
 */
export const PUBLIC_RESUME_CACHE_CONTROL =
  'public, max-age=0, s-maxage=60, must-revalidate';
