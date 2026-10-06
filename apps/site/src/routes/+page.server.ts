import { createHash } from 'node:crypto';
import { redirect } from '@sveltejs/kit';
import { version } from '$app/environment';
import {
  getAppConfig,
  getPublicLinks,
  isSharedHosted,
} from '$lib/server/app-config';
import { PUBLIC_RESUME_CACHE_CONTROL } from '$lib/server/public-cache';
import { getCachedPublishedResume } from '$lib/server/resume-data';
import type { PageServerLoad } from './$types';

/**
 * Build the response validator.
 *
 * Keyed on the payload digest, not the cache version stamp: the stamp is read
 * before the payload load, so a write landing between the two would file fresh
 * content under the old stamp and two clients could hold different bytes under
 * one validator. The digest is derived from the payload actually returned.
 *
 * The build version is mixed in because the rendered page is a function of both
 * the data and the build that renders it — a deploy that changes markup or asset
 * hashes without touching the database must not reuse the previous ETag.
 */
function pageEtag(contentHash: string): string {
  const digest = createHash('sha256')
    .update(`${version}\n${contentHash}`)
    .digest('hex');
  return `"${digest}"`;
}

export const load: PageServerLoad = async ({ locals, setHeaders }) => {
  // A shared hosted deployment serves many users' private workspaces, so the
  // root must never present one owner's resume: send visitors to the
  // configured marketing site, or show a neutral sign-in entry.
  if (isSharedHosted()) {
    const links = getPublicLinks();
    if (links.landing) redirect(302, links.landing.href);
    setHeaders({ 'cache-control': 'private, no-store' });
    return {
      appName: getAppConfig().appName,
      links,
      mode: 'landing' as const,
      signedIn: Boolean(locals?.user),
    };
  }

  const { contentHash, value } = await getCachedPublishedResume();
  setHeaders({
    'cache-control': PUBLIC_RESUME_CACHE_CONTROL,
    ...(contentHash ? { etag: pageEtag(contentHash) } : {}),
  });
  return value;
};
