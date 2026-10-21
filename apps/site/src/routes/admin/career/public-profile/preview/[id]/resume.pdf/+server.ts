import { error } from '@sveltejs/kit';
import { safePdfFilename } from '$lib/server/http-headers';
import { getPublicProfilePreviewPdf } from '$lib/server/public-profile-service';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
  const pdf = await getPublicProfilePreviewPdf(locals, params.id);
  if (!pdf) error(404, 'Not found');
  return new Response(pdf.body, {
    headers: {
      'cache-control': 'private, no-store',
      'content-disposition': `inline; filename="${safePdfFilename(pdf.filename)}"`,
      'content-type': 'application/pdf',
      'x-content-type-options': 'nosniff',
    },
  });
};
