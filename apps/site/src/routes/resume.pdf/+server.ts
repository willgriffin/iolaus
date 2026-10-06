import { error } from '@sveltejs/kit';
import { isSharedHosted } from '$lib/server/app-config';
import { safePdfFilename } from '$lib/server/http-headers';
import { ensurePublishedResumePdf } from '$lib/server/resume-admin';
import { PUBLIC_RESUME_PDF_FILENAME } from '$lib/server/resume-files';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
  // A shared hosted deployment has no single public owner resume.
  if (isSharedHosted()) error(404, 'Not found');

  const published = await ensurePublishedResumePdf();

  return new Response(new Uint8Array(published.body), {
    headers: {
      'content-disposition': `attachment; filename="${safePdfFilename(PUBLIC_RESUME_PDF_FILENAME)}"`,
      'content-type': 'application/pdf',
    },
  });
};
