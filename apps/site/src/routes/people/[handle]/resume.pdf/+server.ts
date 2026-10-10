import { error } from '@sveltejs/kit';
import { isSharedHosted } from '$lib/server/app-config';
import { safePdfFilename } from '$lib/server/http-headers';
import { getPublicProfilePdf } from '$lib/server/public-profile-service';
import type { RequestHandler } from './$types';

function publicProfilesEnabled(): boolean {
  return (
    isSharedHosted() && process.env.IOLAUS_PUBLIC_PROFILES_ENABLED === 'true'
  );
}

export const GET: RequestHandler = async ({ params, setHeaders }) => {
  setHeaders({
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow',
  });
  if (!publicProfilesEnabled()) error(404, 'Not found');
  const pdf = await getPublicProfilePdf(params.handle);
  if (!pdf) error(404, 'Not found');
  return new Response(pdf.body, {
    headers: {
      'content-disposition': `attachment; filename="${safePdfFilename(pdf.filename)}"`,
      'content-type': 'application/pdf',
      'x-content-type-options': 'nosniff',
    },
  });
};
