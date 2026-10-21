// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Kernel, RelayConfig } from '@beamhop/core';
import { z } from 'zod';
import type { Translate } from './strings.ts';

export const PUBLIC_WEB_MODULE_ID = 'public-web';

export const BrandingSchema = z
  .object({
    accent: z
      .string()
      .regex(/^#[0-9a-fA-F]{3,8}$/)
      .optional()
      .describe('Accent color for buttons and links, e.g. #7aa2ff'),
    theme: z.enum(['auto', 'dark', 'light']).default('auto').describe('Page color theme'),
    footer: z.string().max(500).optional().describe('Extra line shown at the bottom of pages'),
  })
  .prefault({});
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
    branding: z.record(z.string(), BrandingSchema).default({}),
    sourceUrl: z
      .string()
      .url()
      .default('https://github.com/beamhop/beamhop')
      .describe('Link to the source code (AGPL)'),
  })
  .prefault({});
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
