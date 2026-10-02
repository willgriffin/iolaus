import { error } from '@sveltejs/kit';
import { safePdfFilename } from '$lib/server/http-headers';
import { loadResumeAssetPdf } from '$lib/server/resume-asset-pdf';
import { getCollection } from '$lib/server/smrt';
import {
  requireCurrentWorkspaceSubject,
  resolveWorkspaceSubjectForProfile,
} from '$lib/server/workspace-subject';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
  const workspace = requireCurrentWorkspaceSubject();
  const assets = await getCollection('ResumeAsset');
  const asset = (await assets.get(params.id)) as unknown as Record<
    string,
    unknown
  > | null;
  if (
    !asset ||
    String(asset.tenantId ?? '') !== workspace.tenantId ||
    String(asset.ownerUserId ?? '') !== workspace.userId
  ) {
    error(404, 'Resume asset not found.');
  }
  const profileId = String(asset.candidateProfileId ?? '').trim();
  const resolved = await resolveWorkspaceSubjectForProfile(profileId);
  const pdf = await loadResumeAssetPdf(params.id, {
    profileId,
    tenantId: resolved.tenantId,
    userId: resolved.userId,
  });

  return new Response(new Uint8Array(pdf.body), {
    headers: {
      'content-disposition': `inline; filename="${safePdfFilename(pdf.filename)}"`,
      'content-type': 'application/pdf',
    },
  });
};
