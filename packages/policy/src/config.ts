// SPDX-License-Identifier: AGPL-3.0-or-later
/** `config.modules.policy` — settings that are not part of the core relay schema. */
import { example, technical } from '@beamhop/core';
import { z } from 'zod';

export const TierRuleSchema = z
  .object({
    /** Limit the rule to one virtual relay (all relays when absent). */
    relayId: z
      .string()
      .optional()
      .describe('Only apply this rule on one relay (its internal id). Empty = every relay.'),
    tier: z.string().describe('Membership level to give (its short internal name).'),
    when: z
      .object({
        allowlisted: z
          .boolean()
          .optional()
          .describe('Person is on the member list. Empty = does not matter.'),
        wotDepthAtMost: z
          .number()
          .int()
          .min(0)
          .max(3)
          .optional()
          .describe('Person is within this many follow hops of you. Empty = does not matter.'),
      })
      .describe('All given conditions must hold'),
  })
  .describe('Give people a membership level automatically when they match');
export type TierRule = z.infer<typeof TierRuleSchema>;

export const PolicyModuleConfigSchema = z
  .object({
    rateLimitByIp: z
      .boolean()
      .default(true)
      .describe(
        'Also limit how fast one network address can post, not just one account. Stops one bot running many accounts.',
      ),
    ipMultiplier: z
      .number()
      .positive()
      .default(4)
      .describe(
        'A network address may post this many times more than one person. Raise it if many people share one connection (offices, schools).',
      ),
    content: z
      .object({
        packs: example(
          technical(
            z
              .array(z.string())
              .default(['scam'])
              .describe(
                'Ready-made word and link lists to block, e.g. "scam" (common scam phrases) or "shorteners" (link shorteners that hide where a link goes).',
              ),
            'Pack ids: keyword packs (KEYWORD_PACKS: scam) and link packs (LINK_PACKS: shorteners). Unknown ids are ignored.',
          ),
          ['scam', 'shorteners'],
        ),
        blockedKeywords: z.array(z.string()).default([]).describe('Words or phrases to block'),
        blockedDomains: example(
          z.array(z.string()).default([]).describe('Websites whose links are blocked'),
          ['spam.example.com'],
        ),
      })
      .prefault({})
      .describe('Block posts by the words and links they contain'),
    bannedPubkeys: technical(
      z.array(z.string()).default([]),
      'Static known-bad pubkey list (hex), applied to all relays',
    ).describe('Known bad accounts, blocked everywhere'),
    tierRules: z
      .array(TierRuleSchema)
      .default([])
      .describe('Rules that give people a membership level automatically, checked in order.'),
    wot: z
      .object({
        maxMembers: technical(
          z
            .number()
            .int()
            .positive()
            .default(100_000)
            .describe(
              'Most people that can count as trusted. A safety cap so a huge network does not slow the relay down.',
            ),
          'Upper bound on the follow-graph walk; the walk stops (and reports truncation) at this size.',
        ),
      })
      .prefault({})
      .describe('Limits for "people my network trusts" access'),
    spamWave: z
      .object({
        windowMinutes: z
          .number()
          .int()
          .positive()
          .default(60)
          .describe('How far back to look for a spam wave, in minutes.'),
        minKeys: z
          .number()
          .int()
          .positive()
          .default(10)
          .describe(
            'How many new accounts must trip the spam filter in that time before you are warned about a spam wave.',
          ),
      })
      .prefault({})
      .describe('When to warn you about a spam wave from new accounts'),
    recycleDays: z
      .number()
      .int()
      .positive()
      .default(30)
      .describe('Days removed items can be restored'),
  })
  .prefault({})
  .describe('Spam and content rules');
export type PolicyModuleConfig = z.infer<typeof PolicyModuleConfigSchema>;
