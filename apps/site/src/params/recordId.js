/**
 * Param matcher for admin record ids. Excludes reserved sub-route words (e.g.
 * `new`) so a static `/admin/<resource>/[id]` override doesn't shadow the
 * generic `/admin/[resource]/new` create route.
 *
 * @type {import('@sveltejs/kit').ParamMatcher}
 */
export function match(param) {
  return param !== 'new';
}
