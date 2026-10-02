// @vitest-environment happy-dom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import IolausOpportunityWorkspace from './IolausOpportunityWorkspace.svelte';

const HOST_ORIGIN = 'https://host.example';
const IOLAUS_ORIGIN = 'https://iolaus.example';

type RpcMessage = {
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
};

function toolResult(structuredContent: Record<string, unknown>) {
  return {
    content: [{ text: JSON.stringify(structuredContent), type: 'text' }],
    structuredContent,
  };
}

function fakeHost(
  calls: RpcMessage[],
  capabilities: Record<string, unknown> = { openLinks: {}, serverTools: {} },
) {
  const host = {
    postMessage(message: RpcMessage) {
      calls.push(message);
      let result: unknown = {};
      if (message.method === 'ui/initialize') {
        result = {
          hostCapabilities: capabilities,
          hostContext: { availableDisplayModes: ['inline', 'fullscreen'] },
          hostInfo: { name: 'Test host', version: '1.0.0' },
          protocolVersion: '2026-01-26',
        };
      }
      if (message.method === 'tools/call') {
        const name = message.params?.name;
        if (name === 'job_search_browse_opportunities') {
          result = toolResult({
            items: [
              {
                company: 'Acme',
                id: 'opp-1',
                recommendation: 'recommend',
                score: 92,
                summary: 'Build a safer board.',
                title: 'Platform Engineer',
              },
            ],
          });
        } else if (name === 'job_search_inspect_opportunity') {
          result = toolResult({
            company: 'Acme',
            id: 'opp-1',
            summary: 'Detailed role context.',
            title: 'Platform Engineer',
          });
        } else if (name === 'job_search_open_application') {
          result = toolResult({
            application: { id: 'app-1', status: 'awaiting_user' },
          });
        } else if (name === 'job_search_inspect_application') {
          result = toolResult({
            application: {
              id: 'app-1',
              reviewUrl: '/admin/applications/app-1/review',
              status: 'awaiting_user',
            },
          });
        } else if (name === 'iolaus_open_human_review') {
          result = toolResult({
            humanReviewUrl: '/admin/applications/app-1/review',
          });
        }
      }
      if (message.id) {
        queueMicrotask(() => {
          window.dispatchEvent(
            new MessageEvent('message', {
              data: { id: message.id, jsonrpc: '2.0', result },
              origin: HOST_ORIGIN,
              source: host as unknown as MessageEventSource,
            }),
          );
        });
      }
    },
  };
  return host;
}

afterEach(() => document.body.replaceChildren());

describe('IolausOpportunityWorkspace', () => {
  it('calls only owner-scoped workflows and offers an explicit human-review link', async () => {
    const calls: RpcMessage[] = [];
    const target = document.body.appendChild(document.createElement('div'));
    const component = mount(IolausOpportunityWorkspace, {
      props: {
        hostOrigin: HOST_ORIGIN,
        hostWindow: fakeHost(calls) as unknown as Window,
        iolausOrigin: IOLAUS_ORIGIN,
      },
      target,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(target.textContent).toContain('Platform Engineer');

    const inspect = Array.from(target.querySelectorAll('button')).find(
      (button) => button.textContent === 'Inspect',
    );
    inspect?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(target.textContent).toContain('Detailed role context.');

    const prepare = Array.from(target.querySelectorAll('button')).find(
      (button) => button.textContent === 'Prepare workspace',
    );
    prepare?.click();
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const review = Array.from(target.querySelectorAll('a')).find(
      (anchor) => anchor.textContent === 'Open dedicated review',
    );
    expect(review?.getAttribute('href')).toBe(
      '/admin/applications/app-1/review',
    );
    review?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const names = calls
      .filter((call) => call.method === 'tools/call')
      .map((call) => call.params?.name);
    expect(names).toEqual([
      'job_search_browse_opportunities',
      'job_search_inspect_opportunity',
      'job_search_open_application',
      'job_search_inspect_application',
      'iolaus_open_human_review',
    ]);
    expect(calls.some((call) => call.method === 'ui/open-link')).toBe(true);
    expect(
      Array.from(target.querySelectorAll('button')).some((button) =>
        /approve|submit/i.test(button.textContent ?? ''),
      ),
    ).toBe(false);
    unmount(component);
  });

  it('keeps a structured-result fallback when the host cannot call tools', async () => {
    const calls: RpcMessage[] = [];
    const target = document.body.appendChild(document.createElement('div'));
    const component = mount(IolausOpportunityWorkspace, {
      props: {
        hostOrigin: HOST_ORIGIN,
        hostWindow: fakeHost(calls, {}) as unknown as Window,
      },
      target,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(target.textContent).toContain('cannot call Iolaus tools');
    expect(calls.some((call) => call.method === 'tools/call')).toBe(false);
    unmount(component);
  });
});
