import { json } from '@sveltejs/kit';
import { getAppConfig } from '$lib/server/app-config';
import { isPublishedResumePrimeSettled } from '$lib/server/resume-prime';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => {
  const primed = isPublishedResumePrimeSettled();

  // Readiness gate: keep a booting replica out of the load balancer until its
  // resume cache prime has settled, so no public request pays the cold read
  // plan. The prime settles on failure too, so an unreachable database cannot
  // hold the pod unready (and, since this path is also the liveness probe,
  // cannot crash-loop it).
  return json(
    {
      ok: primed,
      resume: primed ? 'ready' : 'priming',
      service: getAppConfig().appId,
    },
    { status: primed ? 200 : 503 },
  );
};
