// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createMarkdown, safeHref } from '../src/lib/markdown.ts';

const md = createMarkdown({ appHref: (p) => `/admin${p}` });

describe('assistant markdown', () => {
  it('renders the usual formatting', () => {
    const html = md(
      '**Bold** and `code`\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\nx < y\n```',
    );
    expect(html).toContain('<strong>Bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<table>');
    expect(html).toContain('x &lt; y');
  });

  it('shows raw HTML as text', () => {
    const html = md('<img src=x onerror=alert(1)> <script>alert(1)</script> <b>hi</b>');
    expect(html).not.toMatch(/<(img|script|b)\b/);
    expect(html).toContain('&lt;script&gt;');
  });

  it('keeps only safe links; external ones open in a new tab', () => {
    expect(md('[x](javascript:alert(1))')).not.toContain('<a');
    expect(md('[x](data:text/html,hi)')).not.toContain('<a');
    expect(md('[x](//evil.test/a)')).not.toContain('<a');
    expect(md('[docs](https://beamhop.dev/docs)')).toContain(
      '<a href="https://beamhop.dev/docs" target="_blank" rel="noopener noreferrer nofollow">docs</a>',
    );
    expect(md('[AI](/settings/ai)')).toContain('<a href="/admin/settings/ai">AI</a>');
    expect(safeHref('mailto:a@b.test')?.external).toBe(false);
  });

  it('never loads images', () => {
    const html = md('![a chart](https://tracker.test/p.gif)');
    expect(html).not.toContain('<img');
    expect(html).toContain('[a chart]');
  });
});
