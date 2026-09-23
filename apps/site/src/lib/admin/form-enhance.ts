import type { SubmitFunction } from '@sveltejs/kit';

/**
 * `use:enhance` for forms whose fields show existing values (`value={...}` or
 * `bind:value`). Default enhance resets the form on success before the
 * invalidated data re-renders, which can blank those fields even though the
 * save succeeded; a native POST used to reload the page instead (#90).
 */
export const keepFormValues: SubmitFunction =
  () =>
  async ({ update }) => {
    await update({ reset: false });
  };
