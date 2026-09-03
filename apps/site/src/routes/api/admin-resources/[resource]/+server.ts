import { error, json, type RequestHandler } from '@sveltejs/kit';
import { loadAdminResourcePageData } from '$lib/server/admin-resource-route';

export const GET: RequestHandler = async ({ locals, params, url }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const resource = params.resource;
  if (!resource) {
    error(404, 'Resource not found');
  }

  const data = await loadAdminResourcePageData(resource, url);
  return json({
    ...data,
    count: data.pagination.totalRecords,
    data: data.records,
    items: data.records,
    pagination: data.pagination,
  });
};
