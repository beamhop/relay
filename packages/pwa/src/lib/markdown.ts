// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Markdown for assistant answers (§6.5). The text comes from a language model, so it
 * is untrusted: raw HTML is shown as text, links only go to http(s), mailto or an
 * app screen, and images are never loaded (their description is shown instead —
 * no tracking pixels, nothing fetched from elsewhere). Pure: string in, HTML out.
 */
import { Marked, type Tokens } from 'marked';

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c] as string);
}

export interface MarkdownOptions {
  /** Turn an app path (`/settings/ai`) into a link inside the admin app. */
  appHref?: (path: string) => string;
}

type Href = { href: string; external: boolean };

/** Where a link may go; anything else (javascript:, data:, protocol-relative…) is dropped. */
export function safeHref(raw: string, appHref: (p: string) => string = (p) => p): Href | null {
  const href = raw.trim();
  if (/^\/(?!\/)/.test(href)) return { href: appHref(href), external: false };
  if (href.startsWith('#')) return { href, external: false };
  try {
    const url = new URL(href);
    if (url.protocol === 'http:' || url.protocol === 'https:')
      return { href: url.href, external: true };
    if (url.protocol === 'mailto:') return { href: url.href, external: false };
  } catch {
    /* not an absolute URL */
  }
  return null;
}

export function createMarkdown(opts: MarkdownOptions = {}): (text: string) => string {
  const md = new Marked({ gfm: true, breaks: true, async: false });
  md.use({
    renderer: {
      html({ text }: Tokens.HTML | Tokens.Tag) {
        return escapeHtml(text);
      },
      link({ href, title, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens);
        const to = safeHref(href, opts.appHref);
        if (!to) return inner;
        const t = title ? ` title="${escapeHtml(title)}"` : '';
        const ext = to.external ? ' target="_blank" rel="noopener noreferrer nofollow"' : '';
        return `<a href="${escapeHtml(to.href)}"${t}${ext}>${inner}</a>`;
      },
      image({ text }: Tokens.Image) {
        return text ? `<span class="md-img">[${escapeHtml(text)}]</span>` : '';
      },
    },
  });
  return (text) => md.parse(text) as string;
}
