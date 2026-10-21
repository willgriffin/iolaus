import { chromium } from '@playwright/test';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import Connections from '../../account/connections/+page.svelte';
import Consent from './+page.svelte';

describe.skipIf(process.env.IOLAUS_OAUTH_BROWSER_TEST !== '1')(
  'OAuth browser UI',
  () => {
    it('renders selectable scope consent and owned revoke forms in Chromium', async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({
          viewport: { width: 390, height: 844 },
        });
        const consent = render(Consent, {
          props: {
            data: {
              clientId: 'test-client',
              redirectUri: 'https://client.test/callback',
              csrf: 'fixture-nonce',
              scopes: [
                {
                  name: 'opportunities:read',
                  description: 'Read workspace',
                  permitted: true,
                },
                {
                  name: 'applications:prepare',
                  description: 'Prepare drafts',
                  permitted: false,
                },
              ],
            },
            form: null,
          },
        });
        await page.setContent(consent.body);
        expect(
          await page
            .getByRole('heading', { name: 'Connect your account' })
            .isVisible(),
        ).toBe(true);
        expect(
          await page.locator('input[value="opportunities:read"]').isChecked(),
        ).toBe(true);
        expect(
          await page
            .locator('input[value="applications:prepare"]')
            .isDisabled(),
        ).toBe(true);
        await page.locator('input[value="opportunities:read"]').uncheck();
        expect(
          await page.locator('input[value="opportunities:read"]').isChecked(),
        ).toBe(false);
        expect(await page.locator('button[value="deny"]').isVisible()).toBe(
          true,
        );
        expect(await page.locator('form').getAttribute('method')).toBe('POST');
        const connections = render(Connections, {
          props: {
            data: {
              grants: [
                {
                  id: 'owned-grant',
                  tenantId: 'tenant',
                  resource: 'https://jobs.test/api/mcp',
                  createdAt: new Date(),
                  clientId: 'client',
                  scopes: ['opportunities:read'],
                  revokedAt: null,
                },
                {
                  id: 'revoked-grant',
                  tenantId: 'tenant',
                  resource: 'https://jobs.test/api/mcp',
                  createdAt: new Date(),
                  clientId: 'old-client',
                  scopes: [],
                  revokedAt: new Date(),
                },
              ],
            },
            form: null,
          },
        });
        await page.setContent(connections.body);
        expect(
          await page.getByRole('button', { name: 'Revoke access' }).count(),
        ).toBe(1);
        expect(await page.locator('input[name="grantId"]').inputValue()).toBe(
          'owned-grant',
        );
        expect(await page.locator('form').getAttribute('action')).toBe(
          '?/revoke',
        );
      } finally {
        await browser.close();
      }
    });
  },
);
