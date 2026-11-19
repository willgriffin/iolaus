import { createOwnerLinkHandler } from '@happyvertical/smrt-app-runtime/sveltekit';
import {
  applicationRuntime,
  getLocalApplicationRuntime,
} from '$lib/server/application-runtime';
import { sessionCookieName } from '$lib/server/auth';

// The published handler validates the wrapper's per-launch secret and origin
// before invoking the local runtime's native owner/session transaction.
export const GET = createOwnerLinkHandler(
  {
    ownerSetupLocation: async () => '/',
    signInLocalOwner: async (input) => {
      if (applicationRuntime.profile !== 'local') return null;
      const runtime = await getLocalApplicationRuntime();
      if (!runtime.signInOwner) throw new Error('Desktop sign-in unavailable.');
      return runtime.signInOwner(input);
    },
    sessionCookie: {
      name: sessionCookieName,
      path: '/',
      sameSite: 'lax',
      maxAgeSeconds: 7 * 24 * 60 * 60,
    },
  },
  { autoClaim: true },
);
