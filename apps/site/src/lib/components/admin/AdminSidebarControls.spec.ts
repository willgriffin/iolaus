import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import AdminSidebarControls from './AdminSidebarControls.svelte';

const props = {
  email: 'owner@example.com',
  theme: 'light' as const,
  id: 'account-test',
  onToggleTheme() {},
  onOpenSettings() {},
};
describe('sidebar account controls', () => {
  it.each([
    false,
    true,
  ])('anchors a real account popover and POST logout on compact=%s', (compact) => {
    const { body } = render(AdminSidebarControls, {
      props: { ...props, compact },
    });
    expect(body).toContain('popovertarget="account-test"');
    expect(body).toContain('popover="auto"');
    expect(body).toContain('aria-label="Open account menu"');
    expect(body).toContain('owner@example.com');
    expect(body).toMatch(/<form method="POST" action="\/logout">/);
    expect(body).toContain('Sign out');
    expect(body).toContain('App settings');
    expect(body).toContain('aria-label="Use dark mode"');
    expect(body.indexOf('aria-label="Use dark mode"')).toBeLessThan(
      body.indexOf('aria-label="Open account menu"'),
    );
  });
  it('offers the opposite theme with pressed state', () => {
    const { body } = render(AdminSidebarControls, {
      props: { ...props, theme: 'dark' },
    });
    expect(body).toContain('aria-label="Use light mode"');
    expect(body).toContain('aria-pressed="true"');
  });
  it('does not expose an account or logout for an unidentified user', () => {
    const { body } = render(AdminSidebarControls, {
      props: { ...props, email: undefined },
    });
    expect(body).not.toContain('popovertarget');
    expect(body).not.toContain('/logout');
    expect(body).toContain('Use dark mode');
  });
});
