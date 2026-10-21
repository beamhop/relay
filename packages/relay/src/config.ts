// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Relay engine module configuration (`config.modules.relay`). Per-relay limits
 * come from `kernel.limits()`; these are node-level engine knobs.
 */
import { technical } from '@beamhop/core';
import { z } from 'zod';

export const RelayModuleConfigSchema = z
  .object({
    maxMessageBytes: technical(
      z
        .number()
        .int()
        .positive()
        .default(512 * 1024),
      'Maximum size of any single WebSocket frame from a client, in bytes.',
    ).describe('Largest message a client may send'),
    maxPendingMessages: z
      .number()
      .int()
      .positive()
      .default(256)
      .describe('Messages queued per connection before new ones are refused'),
    backpressure: technical(
      z
        .object({
          dropAboveBytes: z
            .number()
            .int()
            .positive()
            .default(1024 * 1024)
            .describe('Skip live updates to slow readers above this backlog'),
          closeAboveBytes: z
            .number()
            .int()
            .positive()
            .default(8 * 1024 * 1024)
            .describe('Disconnect readers whose backlog grows past this'),
        })
        .prefault({}),
      'Uses Connection.bufferedAmount(): above dropAboveBytes live EVENT frames are dropped (one NOTICE per episode); above closeAboveBytes the socket is closed with 1013.',
    ),
    expireSweepSeconds: technical(
      z.number().int().positive().default(60),
      'NIP-40: interval of EventStore.deleteExpired sweeps.',
    ).describe('How often expired posts are cleaned up'),
    dedupeCacheSize: z.number().int().positive().default(10_000),
    authWindowSeconds: technical(
      z.number().int().positive().default(600),
      'NIP-42: max |created_at - now| for kind 22242 AUTH events.',
    ),
    negentropy: technical(
      z
        .object({
          enabled: z.boolean().default(true).describe('Allow fast sync with other relays/clients'),
          maxRecords: z.number().int().positive().default(500_000),
          frameSizeLimit: z
            .number()
            .int()
            .min(0)
            .default(128 * 1024),
          maxSessions: z.number().int().positive().default(4),
        })
        .prefault({}),
      'NIP-77 negentropy set reconciliation (NEG-OPEN/NEG-MSG/NEG-CLOSE).',
    ),
    groups: technical(
      z
        .object({
          enabled: z.boolean().default(true).describe('Allow group chats (channels) on this relay'),
          whoCanCreate: z
            .enum(['anyone', 'owner'])
            .default('anyone')
            .describe('Who may start a new group from a Nostr app'),
        })
        .prefault({}),
      'NIP-29 relay-based groups: h-tagged posts, moderation kinds 9000–9009, join/leave 9021/9022, relay-signed 39000–39003. Admins can always create groups via the groups.* actions.',
    ),
    vanishIdCap: technical(
      z.number().int().min(0).default(1000),
      'NIP-62: up to this many deleted ids are collected (query before vanish) for the event.deleted bus event; `count` carries the total.',
    ),
    software: z.string().default('https://github.com/beamhop/beamhop'),
    version: z.string().default('0.0.0'),
  })
  .prefault({});

export type RelayModuleConfig = z.infer<typeof RelayModuleConfigSchema>;
