import {
  getAppConfig,
  getInviteRequestContact,
  getPublicLinks,
} from '$lib/server/app-config';
import type { PageServerLoad } from './$types';

/**
 * Public and deliberately uniform: it reveals nothing about whether the
 * address exists, was revoked, or was never invited.
 */
export const load: PageServerLoad = async ({ setHeaders }) => {
  setHeaders({ 'cache-control': 'no-store' });
  return {
    appName: getAppConfig().appName,
    contact: getInviteRequestContact(),
    links: getPublicLinks(),
  };
};
