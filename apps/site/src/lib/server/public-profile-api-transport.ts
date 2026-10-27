/** Scope anonymous transport to this single endpoint, not other public APIs. */
export function isPublicProfileApiPath(pathname: string): boolean {
  return /^\/api\/public\/v1\/profiles\/[^/]+\/?$/u.test(pathname);
}
/** The profile's assistant endpoints: anonymous POSTs with their own CORS policy. */
export function isPublicProfileAssistantPath(pathname: string): boolean {
  return /^\/api\/public\/v1\/profiles\/[^/]+\/(chat|voice)\/?$/u.test(
    pathname,
  );
}
export const publicProfileApiHeaders = {
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'x-robots-tag': 'noindex, nofollow',
};
