import { loadAdminShellData } from '$lib/server/admin-shell-data';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) =>
  loadAdminShellData(locals);
