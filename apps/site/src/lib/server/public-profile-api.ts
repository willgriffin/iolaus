import { createHash } from 'node:crypto';
import { isHttpError, json } from '@sveltejs/kit';
import { publicProfileApiSchema } from '$lib/public-profile-api-contract';
import {
  publicProfileHandleSchema,
  publicProfileSnapshotSchema,
} from '$lib/public-profile-contract';
import { publicProfileApiHeaders } from './public-profile-api-transport';
import { getPublicProfile } from './public-profile-service';

function unavailable() {
  return json(
    {
      apiVersion: 1,
      error: {
        code: 'PROFILE_UNAVAILABLE',
        message: 'Profile unavailable.',
      },
    },
    { status: 404, headers: publicProfileApiHeaders },
  );
}

export async function publicProfileApiResponse(
  handle: string,
): Promise<Response> {
  const parsed = publicProfileHandleSchema.safeParse(handle);
  if (!parsed.success) return unavailable();
  try {
    const current = await getPublicProfile(parsed.data);
    if (!current) return unavailable();
    // Validate storage before removing its version. Never serialize a private
    // model or pass through unrecognized fields from a corrupted snapshot.
    const { version: _storageVersion, ...profile } =
      publicProfileSnapshotSchema.parse(current.snapshot);
    if (current.handle !== parsed.data)
      throw new Error('Publication handle mismatch.');
    const payload = publicProfileApiSchema.parse({
      apiVersion: 1,
      handle: current.handle,
      revision: createHash('sha256')
        .update(`public-profile-v1:${current.revisionId}`)
        .digest('hex'),
      // Existing resolver publishedAt is revision.createdAt, not publish time.
      revisionCreatedAt: current.publishedAt,
      links: {
        profile: `/people/${current.handle}`,
        pdf: `/people/${current.handle}/resume.pdf`,
      },
      profile,
    });
    return json(payload, { headers: publicProfileApiHeaders });
  } catch (cause) {
    if (isHttpError(cause) && cause.status === 404) return unavailable();
    return json(
      {
        apiVersion: 1,
        error: {
          code: 'PROFILE_SERVICE_UNAVAILABLE',
          message: 'Profile service unavailable.',
        },
      },
      { status: 503, headers: publicProfileApiHeaders },
    );
  }
}
