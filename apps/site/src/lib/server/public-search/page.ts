import { error } from '@sveltejs/kit';
import { isSharedHosted } from '../app-config.js';
import { consumePublicSearchBudget, PublicSearchError } from './index.js';
export async function preparePublicPage(
  setHeaders: (headers: Record<string, string>) => void,
  cost = 3,
) {
  setHeaders({ 'cache-control': 'private, no-store' });
  if (!isSharedHosted() || process.env.IOLAUS_PUBLIC_SEARCH_ENABLED !== 'true')
    error(404, 'Public catalog is not enabled.');
  try {
    await consumePublicSearchBudget(cost);
  } catch (cause) {
    error(
      cause instanceof PublicSearchError ? cause.status : 503,
      'Public catalog unavailable.',
    );
  }
}
