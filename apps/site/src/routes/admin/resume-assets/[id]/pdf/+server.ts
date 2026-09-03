import { safePdfFilename } from '$lib/server/http-headers';
import { loadResumeAssetPdf } from '$lib/server/resume-asset-pdf';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
  const pdf = await loadResumeAssetPdf(params.id);

  return new Response(new Uint8Array(pdf.body), {
    headers: {
      'content-disposition': `inline; filename="${safePdfFilename(pdf.filename)}"`,
      'content-type': 'application/pdf',
    },
  });
};
