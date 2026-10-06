import { describe, expect, it } from 'vitest';
import { detectUrlIntake, resolveUrlIntake } from './url-intake';

const ID = 'd78184cd-027f-4932-8613-bf8c94d536ae';
describe('public URL intake detection', () => {
  it.each([
    ['https://jobs.ashbyhq.com/acme', 'ashby', 'source'],
    [`https://jobs.ashbyhq.com/acme/${ID}`, 'ashby', 'opportunity'],
    ['https://boards.greenhouse.io/acme', 'greenhouse', 'source'],
    [
      'https://job-boards.greenhouse.io/acme/jobs/12345',
      'greenhouse',
      'opportunity',
    ],
    ['https://jobs.lever.co/acme', 'lever', 'source'],
    [`https://jobs.lever.co/acme/${ID}/apply`, 'lever', 'opportunity'],
  ])('classifies only known %s shapes', (url, provider, kind) => {
    expect(detectUrlIntake(url)).toMatchObject({ provider, kind });
  });

  it('canonicalizes tracking aliases and application links to the same posting', () => {
    expect(
      detectUrlIntake(
        `https://jobs.ashbyhq.com/acme/${ID}/application?utm_source=share#apply`,
      ).url,
    ).toBe(`https://jobs.ashbyhq.com/acme/${ID}`);
    expect(
      detectUrlIntake('https://jobs.lever.co/acme/?source=share').url,
    ).toBe('https://jobs.lever.co/acme');
  });

  it.each([
    'https://careers.example.com/roles/engineer',
    'https://jobs.ashbyhq.com/acme/unknown',
    'https://jobs.lever.co.evil.example/acme',
  ])('asks for a choice for %s without fabricating a type', (url) => {
    expect(resolveUrlIntake(url, undefined).kind).toBe('choice');
    expect(resolveUrlIntake(url, 'source')).toMatchObject({
      kind: 'source',
      provider: 'generic-careers',
    });
    expect(resolveUrlIntake(url, 'opportunity')).toMatchObject({
      kind: 'opportunity',
      provider: 'generic-careers',
    });
  });

  it.each([
    '',
    'not a URL',
    'http://jobs.example.com',
    'https://name:pass@jobs.example.com',
    'https://localhost/careers',
    'https://127.0.0.1/careers',
    'https://[::1]/careers',
    'https://jobs.internal/careers',
    'https://jobs.example.com:8443/careers',
    'https://jobs.example.com?access_token=secret',
    'https://jobs.example.com?sessionid=secret',
    'x'.repeat(2049),
  ])('rejects malformed/private/credential URL %s', (url) => {
    expect(() => detectUrlIntake(url)).toThrow();
  });

  it('rejects unknown choice values and overriding an authoritative ATS shape', () => {
    expect(() =>
      resolveUrlIntake('https://careers.example.com', 'magic'),
    ).toThrow('Choose');
    expect(() =>
      resolveUrlIntake('https://jobs.ashbyhq.com/acme', 'opportunity'),
    ).toThrow('job board');
  });
});
