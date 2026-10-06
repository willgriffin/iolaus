import { json } from '@sveltejs/kit';
import { getAppConfig } from '$lib/server/app-config';
import { checkApplicationRuntimeReadiness } from '$lib/server/application-runtime';
import {
  isPublishedResumePrimeSettled,
  startPublishedResumePrime,
} from '$lib/server/resume-prime';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
  const runtimeReady = await checkApplicationRuntimeReadiness();
  // A dev module reload may discard the old startup prime state without
  // rerunning server init. Recover only after the runtime gate has passed;
  // the idempotent prime still keeps readiness false until it settles.
  if (runtimeReady) startPublishedResumePrime();
  const primed = isPublishedResumePrimeSettled();

  // Readiness gate: keep a booting replica out of the load balancer until its
  // resume cache prime has settled, so no public request pays the cold read
  // plan. The prime settles on failure too, so an unreachable database cannot
  // hold the pod unready forever. /live remains process-only liveness.
  return json(
    {
      ok: primed && runtimeReady,
      resume: primed ? 'ready' : 'priming',
      runtime: runtimeReady ? 'ready' : 'unavailable',
      service: getAppConfig().appId,
    },
    { status: primed && runtimeReady ? 200 : 503 },
  );
};
