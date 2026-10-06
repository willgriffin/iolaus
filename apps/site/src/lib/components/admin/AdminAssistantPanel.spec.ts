import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import AdminAssistantPanel from './AdminAssistantPanel.svelte';

describe('native admin assistant panel', () => {
  it('renders the real native dock and accessible close without sending on behalf of the user', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const { body } = render(AdminAssistantPanel, {
        props: { visible: false, onClose() {} },
      });
      expect(body).toContain('aria-label="Assistant"');
      expect(body).toContain('aria-label="Close assistant"');
      expect(body).toContain('assistant-dock');
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      fetcher.mockRestore();
    }
  });
});
