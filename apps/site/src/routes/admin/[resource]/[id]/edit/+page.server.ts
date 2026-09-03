import { error, redirect } from '@sveltejs/kit';
import {
  createExperienceProjectAction,
  createExperienceProjectBulletAction,
  loadAdminRecordPageData,
  safeAdminReturnTo,
  updateAdminResourceAction,
  updateExperienceProjectAction,
  updateExperienceProjectBulletAction,
} from '$lib/server/admin-resource-route';
import type { Actions, PageServerLoad } from './$types';

function experienceEditHref(resource: string, id: string): string {
  return `/admin/${resource}/${id}/edit`;
}

function requireExperienceResource(resource: string): void {
  if (resource !== 'experience') {
    error(404, 'Related project editing is only available for experience.');
  }
}

export const load: PageServerLoad = async ({ params, url }) => {
  return await loadAdminRecordPageData(params.resource, params.id, {
    includeRelatedProjects: true,
    returnTo: url.searchParams.get('returnTo') ?? undefined,
  });
};

export const actions: Actions = {
  createRelatedProjectBullet: async ({ locals, params, request }) => {
    requireExperienceResource(params.resource);
    await createExperienceProjectBulletAction(params.id, request, locals.user);
    redirect(303, experienceEditHref(params.resource, params.id));
  },
  createRelatedProject: async ({ locals, params, request }) => {
    requireExperienceResource(params.resource);
    await createExperienceProjectAction(params.id, request, locals.user);
    redirect(303, experienceEditHref(params.resource, params.id));
  },
  update: async ({ locals, params, request }) => {
    const returnTo = safeAdminReturnTo(
      String((await request.clone().formData()).get('returnTo') ?? ''),
    );
    const record = await updateAdminResourceAction(
      params.resource,
      request,
      locals.user,
    );
    redirect(
      303,
      returnTo || `/admin/${params.resource}/${record.id ?? params.id}`,
    );
  },
  updateRelatedProject: async ({ locals, params, request }) => {
    requireExperienceResource(params.resource);
    await updateExperienceProjectAction(params.id, request, locals.user);
    redirect(303, experienceEditHref(params.resource, params.id));
  },
  updateRelatedProjectBullet: async ({ locals, params, request }) => {
    requireExperienceResource(params.resource);
    await updateExperienceProjectBulletAction(params.id, request, locals.user);
    redirect(303, experienceEditHref(params.resource, params.id));
  },
};
