import type { Snippet } from 'svelte';

export const ADMIN_HEADER_ACTIONS = Symbol('admin-header-actions');
export interface AdminHeaderActions {
  register(actions: Snippet): () => void;
}
