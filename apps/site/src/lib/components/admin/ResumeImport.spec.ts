import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import ResumeImport from './ResumeImport.svelte';

describe('ResumeImport', () => {
  it('renders a private upload boundary with a bounded PDF picker', () => {
    const { body } = render(ResumeImport);
    expect(body).toContain('Private resume import');
    expect(body).toContain('accept="application/pdf,.pdf"');
    expect(body).toContain('up to 10 MiB');
    expect(body).toContain('never publishes your profile');
    expect(body).toContain('Resume text is sent to our configured AI provider');
  });

  it('keeps uncertain proposals excluded and renders evidence as text', () => {
    const { body } = render(ResumeImport, {
      props: {
        initialImport: {
          id: 'import-1',
          status: 'review',
          revision: 'r1',
          filename: 'resume.pdf',
          warnings: [],
          entries: [
            {
              id: 'experience-1',
              kind: 'experience',
              uncertain: true,
              fields: { company: '<script>alert(1)</script>' },
              evidence: [{ page: 1, text: '<img src=x onerror=alert(1)>' }],
            },
          ],
        },
      },
    });
    expect(body).toContain('option value="skip" selected');
    expect(body).toContain('&lt;script');
    expect(body).toContain('&lt;img');
    expect(body).not.toContain('<script>alert(1)</script>');
  });

  it('makes the one owned profile candidate a merge-only default', () => {
    const { body } = render(ResumeImport, {
      props: {
        initialImport: {
          id: 'import-1',
          status: 'review',
          revision: 'r1',
          filename: 'resume.pdf',
          warnings: [],
          entries: [
            {
              id: 'profile-1',
              kind: 'profile',
              fields: { summary: 'Builder' },
              candidateMatches: [{ id: 'profile-owned', label: 'Alex' }],
            },
          ],
        },
      },
    });
    expect(body).toContain('option value="merge" selected');
    expect(body).not.toContain('option value="create"');
  });

  it('renders structured section and skill evidence as escaped review details, never raw JSON', () => {
    const { body } = render(ResumeImport, {
      props: {
        initialImport: {
          id: 'import-1',
          status: 'review',
          revision: 'r1',
          filename: 'resume.pdf',
          warnings: [],
          entries: [
            {
              id: 'experience-1',
              kind: 'experience',
              fields: {
                company: 'Acme',
                title: 'Engineer',
                bulletSections: JSON.stringify([
                  { title: '<script>Section</script>', bullets: ['Built it.'] },
                ]),
              },
            },
            {
              id: 'skill-1',
              kind: 'skill',
              fields: {
                name: 'TypeScript',
                skillEvidence: JSON.stringify([
                  {
                    proposalExperienceId: 'experience-1',
                    usage: 'Built it.',
                    depth: 'hands_on',
                    quote: '<img src=x onerror=alert(1)>',
                    page: 3,
                  },
                ]),
              },
            },
          ],
        },
      },
    });
    expect(body).toContain('Bullet sections');
    expect(body).toContain('Evidence from roles');
    expect(body).toContain('Engineer — Acme');
    expect(body).toContain('Page 3');
    expect(body).toContain('&lt;script>Section');
    expect(body).toContain('&lt;img');
    expect(body).not.toContain('<script>Section</script>');
    expect(body).not.toContain('proposalExperienceId');
  });
});
