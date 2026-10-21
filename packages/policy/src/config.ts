// SPDX-License-Identifier: AGPL-3.0-or-later
/** `config.modules.policy` — settings that are not part of the core relay schema. */
import { technical } from '@beamhop/core';
import { z } from 'zod';

export const TierRuleSchema = z.object({
  /** Limit the rule to one virtual relay (all relays when absent). */
  relayId: z.string().optional(),
  tier: z.string().describe('Tier to assign'),
  when: z
    .object({
      allowlisted: z.boolean().optional().describe('Person is on the member list'),
      wotDepthAtMost: z
        .number()
        .int()
        .min(0)
        .max(3)
        .optional()
        .describe('Person is within this many follow hops of you'),
    })
    .describe('All given conditions must hold'),
});
export type TierRule = z.infer<typeof TierRuleSchema>;

export const PolicyModuleConfigSchema = z
  .object({
    rateLimitByIp: z.boolean().default(true).describe('Also limit by network address'),
    ipMultiplier: z
      .number()
      .positive()
      .default(4)
      .describe('A network address may post this many times more than one person'),
    content: z
      .object({
        packs: z
          .array(z.string())
          .default(['scam'])
          .describe('Ready-made word and link lists to block'),
        blockedKeywords: z.array(z.string()).default([]).describe('Words or phrases to block'),
        blockedDomains: z
          .array(z.string())
          .default([])
          .describe('Websites whose links are blocked'),
      })
      .prefault({}),
    bannedPubkeys: technical(
      z.array(z.string()).default([]),
      'Static known-bad pubkey list (hex), applied to all relays',
    ).describe('Known bad accounts, blocked everywhere'),
    tierRules: z.array(TierRuleSchema).default([]),
    wot: z
      .object({
        maxMembers: z.number().int().positive().default(100_000),
      })
      .prefault({}),
    spamWave: z
      .object({
        windowMinutes: z.number().int().positive().default(60),
        minKeys: z.number().int().positive().default(10),
      })
      .prefault({}),
    recycleDays: z
      .number()
      .int()
      .positive()
      .default(30)
      .describe('Days removed items can be restored'),
  })
  .prefault({});
export type PolicyModuleConfig = z.infer<typeof PolicyModuleConfigSchema>;
