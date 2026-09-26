// The admin area renders as an SPA: navigation shows the shell immediately and
// list data hydrates after mount (#90, anytown's dashboard pattern). With
// `ssr = false` a native POST to a page action would get an empty shell back
// and silently drop the action result, so every admin POST form that targets
// a page action must use `use:enhance` (enforced by admin-spa.spec.ts). The
// signed-out /admin gate lives in hooks.server.ts, so it still runs first.
export const ssr = false;
