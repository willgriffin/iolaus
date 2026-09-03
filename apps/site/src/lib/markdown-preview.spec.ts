import { describe, expect, it } from 'vitest';
import { renderSafeMarkdown } from './markdown-preview';

describe('renderSafeMarkdown', () => {
  it('renders common application material markdown', () => {
    expect(
      renderSafeMarkdown(
        [
          '# Packet',
          '',
          'Use the **agentic platform** resume.',
          '',
          '- Confirm resume',
          '- Submit `application_packet`',
        ].join('\n'),
      ),
    ).toContain(
      '<h1>Packet</h1>\n<p>Use the <strong>agentic platform</strong> resume.</p>\n<ul><li>Confirm resume</li><li>Submit <code>application_packet</code></li></ul>',
    );
  });

  it('escapes raw html before rendering', () => {
    const rendered = renderSafeMarkdown(
      'Do not run <script>alert("x")</script> here.',
    );

    expect(rendered).toContain(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    expect(rendered).not.toContain('<script>');
  });

  it('renders safe links with external targets', () => {
    expect(renderSafeMarkdown('[Posting](https://example.com/job?id=1)')).toBe(
      '<p><a href="https://example.com/job?id=1" target="_blank" rel="noreferrer noopener">Posting</a></p>',
    );
  });

  it('does not render unsafe links', () => {
    expect(renderSafeMarkdown('[Bad](javascript:alert(1))')).toBe(
      '<p>[Bad](javascript:alert(1))</p>',
    );
  });
});
