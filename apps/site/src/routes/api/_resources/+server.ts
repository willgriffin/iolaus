import {
  createResourceListHandler,
  type SessionLocals,
} from '@happyvertical/smrt-users/sveltekit';
// Side-effect import: registers all of iolaus's @smrt() model classes
// in the ObjectRegistry so the handler can discover them.
import '$lib/server/smrt';

/**
 * `GET /api/_resources` — auth-aware resource/command discovery for the
 * `iolaus` CLI (`@happyvertical/smrt-app-cli`). The CLI fetches this to
 * learn which resources and commands it can invoke.
 *
 * Session is resolved straight from `event.locals`, which `hooks.server.ts`
 * already populates from BOTH the session cookie and a `Bearer <token>`
 * header (terminal-auth), so no separate bearer/db wiring is needed here.
 */
export const GET = createResourceListHandler({
  ensureRegistry: async () => {
    await import('$lib/server/smrt');
  },
  resolveSession: async (event) => {
    // The handler types `event.locals` loosely as `Record<string, unknown>`,
    // but hooks.server.ts populates it as `SessionLocals` (see src/app.d.ts,
    // where `App.Locals extends SessionLocals`). Assert that real shape once,
    // then return the typed fields — no `as never` / per-field casts.
    const { user, permissions, tenantId, sessionId } =
      event.locals as unknown as SessionLocals;
    return { user, permissions, tenantId, sessionId };
  },
  // Any authenticated user gets the full resource surface — matches the
  // behavior of the previous hand-maintained resources.ts list.
  commandPolicy: ({ session }) => session.user != null,
});
