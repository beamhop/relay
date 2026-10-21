// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NostrEvent } from '@beamhop/core';
import { z } from 'zod';
import { definePlugin, hold, reject, shadow } from '../sdk/index.ts';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ConfigSchema = z
  .object({
    /** Words or phrases to block. */
    keywords: z.array(z.string().min(1).max(200)).default([]),
    /** Advanced: regular expressions. */
    patterns: z.array(z.string().min(1).max(500)).default([]),
    /** What to do with a match: refuse it, hide it quietly, or hold it for review. */
    action: z.enum(['reject', 'shadow', 'hold']).default('reject'),
    /** Only check these kinds (empty = all kinds). */
    kinds: z.array(z.number().int().min(0)).default([]),
    caseSensitive: z.boolean().default(false),
    /** Match whole words only (so "ass" does not match "class"). */
    wholeWord: z.boolean().default(true),
    /** Also check tag values (hashtags, subjects…). */
    checkTags: z.boolean().default(false),
    message: z.string().max(200).default('this post contains words that are not allowed here'),
  })
  .superRefine((c, ctx) => {
    c.patterns.forEach((p, i) => {
      try {
        new RegExp(p, 'u');
      } catch {
        ctx.addIssue({ code: 'custom', path: ['patterns', i], message: 'not a valid pattern' });
      }
    });
  });

export const keywordFilterPlugin = definePlugin({
  id: 'keyword-filter',
  name: 'Block words and phrases',
  description: 'Turn away, quietly hide, or hold for review any post containing words you list.',
  version: '1.0.0',
  permissions: [],
  configSchema: ConfigSchema,
  hooks: (api) => {
    const c = api.config;
    const flags = c.caseSensitive ? 'u' : 'iu';
    const res: RegExp[] = [
      ...c.keywords.map((k) =>
        c.wholeWord
          ? new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(k)}(?![\\p{L}\\p{N}_])`, flags)
          : new RegExp(escapeRe(k), flags),
      ),
      ...c.patterns.map((p) => new RegExp(p, flags)),
    ];
    const kinds = new Set(c.kinds);
    const texts = (e: NostrEvent) =>
      c.checkTags ? [e.content, ...e.tags.flatMap((t) => t.slice(1))] : [e.content];
    return {
      onEvent(event) {
        if (res.length === 0) return;
        if (kinds.size > 0 && !kinds.has(event.kind)) return;
        const hit = texts(event).some((t) => res.some((r) => r.test(t)));
        if (!hit) return;
        if (c.action === 'shadow') return shadow(c.message);
        if (c.action === 'hold') return hold(c.message);
        return reject('blocked', c.message);
      },
    };
  },
});
