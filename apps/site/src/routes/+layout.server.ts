import { getAppConfig } from '$lib/server/app-config';
import type { LayoutServerLoad } from './$types';

// Local standalone pages use the existing system-font stacks without network I/O.
export const load: LayoutServerLoad = () => ({
  externalFontsEnabled: getAppConfig().runtimeProfile !== 'local',
});
