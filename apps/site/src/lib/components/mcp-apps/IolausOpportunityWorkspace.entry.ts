import { mount } from 'svelte';
import IolausOpportunityWorkspace from './IolausOpportunityWorkspace.svelte';

type BrowserConfiguration = {
  hostOrigin?: unknown;
  iolausOrigin?: unknown;
};

declare global {
  interface Window {
    __IOLAUS_MCP_APP_CONFIG__?: BrowserConfiguration;
  }
}

const configuration = window.__IOLAUS_MCP_APP_CONFIG__ ?? {};
const hostOrigin =
  typeof configuration.hostOrigin === 'string' ? configuration.hostOrigin : '';
const iolausOrigin =
  typeof configuration.iolausOrigin === 'string'
    ? configuration.iolausOrigin
    : undefined;

if (hostOrigin) {
  mount(IolausOpportunityWorkspace, {
    props: { hostOrigin, hostWindow: window.parent, iolausOrigin },
    target: document.body,
  });
} else {
  document.body.replaceChildren(
    Object.assign(document.createElement('p'), {
      textContent:
        'Interactive controls are unavailable until this deployment configures its trusted MCP host origin. Use the structured Iolaus result and authenticated review page.',
    }),
  );
}
