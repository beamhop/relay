// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Kernel, type RelayConfig, example, labels } from '@beamhop/core';
import { z } from 'zod';
import type { Translate } from './strings.ts';

export const PUBLIC_WEB_MODULE_ID = 'public-web';

export const BrandingSchema = z
  .object({
    accent: example(
      z
        .string()
        .regex(/^#[0-9a-fA-F]{3,8}$/)
        .optional()
        .describe('Accent color for buttons and links, e.g. #7aa2ff'),
      '#7aa2ff',
    ),
    theme: labels(z.enum(['auto', 'dark', 'light']).default('auto'), {
      auto: "Match the visitor's device",
      dark: 'Dark',
      light: 'Light',
    }).describe('Page color theme'),
    footer: z.string().max(500).optional().describe('Extra line shown at the bottom of pages'),
  })
  .prefault({})
  .describe('Look of the public pages of one relay');
export type Branding = z.infer<typeof BrandingSchema>;

export const PublicWebConfigSchema = z
  .object({
    sessionMinutes: z
      .number()
      .int()
      .min(5)
      .max(24 * 60)
      .default(60)
      .describe('How long a portal sign-in lasts'),
    uptimeDays: z
      .number()
      .int()
      .min(7)
      .max(90)
      .default(30)
      .describe('Days shown on the status page'),
    /** Per-relay branding, keyed by relay id. */
    branding: z
      .record(z.string(), BrandingSchema)
      .default({})
      .describe('Colors and footer of the public pages, per relay.'),
    sourceUrl: z
      .string()
      .url()
      .default('https://github.com/beamhop/beamhop')
      .describe(
        'Link to the source code, shown on every page. Change it if you run a modified version (the license requires sharing your changes).',
      ),
  })
  .prefault({})
  .describe('Public web pages (landing, member portal, status)');
export type PublicWebConfig = z.infer<typeof PublicWebConfigSchema>;

/** Everything a page needs, resolved once per request. */
export interface PageCtx {
  kernel: Kernel;
  relay: RelayConfig;
  /** Public https base URL of the relay (incl. path prefix), no trailing slash. */
  publicUrl: string;
  /** wss:// URL of the relay. */
  wsUrl: string;
  /** Path prefix for links ('' or '/prefix'). */
  base: string;
  nonce: string;
  t: Translate;
  locale: string;
  cfg: PublicWebConfig;
  branding: Branding;
  secure: boolean;
}

export function moduleConfig(kernel: Kernel): PublicWebConfig {
  return (
    kernel.moduleConfig<PublicWebConfig>(PUBLIC_WEB_MODULE_ID) ?? PublicWebConfigSchema.parse({})
  );
}
