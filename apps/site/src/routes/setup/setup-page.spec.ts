import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import SetupPage from './+page.svelte';

describe('local setup page', () => {
  it('welcomes a person and asks only for the information needed to get started', () => {
    const { head, body } = render(SetupPage, {
      props: {
        data: { available: true, token: 'setup-token' },
        form: null,
        params: {},
      },
    });

    expect(head).toContain('<title>Welcome to Iolaus</title>');
    expect(body).toContain('<h1>Welcome to Iolaus</h1>');
    expect(body).toContain('Enter your name and email to get started.');
    expect(body).toContain(
      'Your information stays in your private workspace on this computer.',
    );
    expect(body).toMatch(/<label[^>]*>Name/);
    expect(body).toMatch(/<label[^>]*>Email address/);
    expect(body).toMatch(/>Get started<\/button>/);
    expect(body).toContain('name="token" value="setup-token"');

    for (const technicalTerm of [
      'owner',
      'invitation',
      'single-use',
      'handoff',
      'runtime',
    ]) {
      expect(body.toLowerCase()).not.toContain(technicalTerm);
    }
  });

  it('explains when setup is no longer available without exposing implementation details', () => {
    const { body } = render(SetupPage, {
      props: {
        data: { available: false, token: '' },
        form: null,
        params: {},
      },
    });

    expect(body).toContain('This app is already set up.');
    expect(body).not.toContain('owner');
    expect(body).not.toContain('invitation');
  });

  it('renders a friendly validation message', () => {
    const { body } = render(SetupPage, {
      props: {
        data: { available: true, token: 'setup-token' },
        form: { message: 'Please enter your name and a valid email address.' },
        params: {},
      },
    });

    expect(body).toContain(
      '<p role="alert">Please enter your name and a valid email address.</p>',
    );
    expect(body).not.toContain('setup token');
  });
});
