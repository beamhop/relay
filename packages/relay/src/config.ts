// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Relay engine module configuration (`config.modules.relay`). Per-relay limits
 * come from `kernel.limits()`; these are node-level engine knobs.
 */
import { BEAMHOP_VERSION, example, labels, technical } from '@beamhop/core';
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
    ).describe(
      'Largest message an app may send in one go. Raise it only if people post very long texts.',
    ),
    maxPendingMessages: z
      .number()
      .int()
      .positive()
      .default(256)
      .describe(
        'Messages waiting per connection before new ones are refused. Protects the server from apps that send too fast.',
      ),
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
        .prefault({})
        .describe('How to handle apps that cannot keep up with live updates'),
      'Uses Connection.bufferedAmount(): above dropAboveBytes live EVENT frames are dropped (one NOTICE per episode); above closeAboveBytes the socket is closed with 1013.',
    ),
    expireSweepSeconds: technical(
      z.number().int().positive().default(60),
      'NIP-40: interval of EventStore.deleteExpired sweeps.',
    ).describe('How often posts that have expired are cleaned up, in seconds.'),
    dedupeCacheSize: technical(
      z
        .number()
        .int()
        .positive()
        .default(10_000)
        .describe(
          'How many recent posts are remembered to skip duplicates quickly. Raise it on very busy relays.',
        ),
      'Size of the in-memory LRU of recently seen event ids.',
    ),
    authWindowSeconds: technical(
      z
        .number()
        .int()
        .positive()
        .default(600)
        .describe(
          "How far a device's clock may be off when signing in, in seconds. Raise it if people with wrong clocks can't sign in.",
        ),
      'NIP-42: max |created_at - now| for kind 22242 AUTH events.',
    ),
    negentropy: technical(
      z
        .object({
          enabled: z.boolean().default(true).describe('Allow fast sync with other relays/clients'),
          maxRecords: z
            .number()
            .int()
            .positive()
            .default(500_000)
            .describe('Most posts one sync may compare. Limits memory use for very large syncs.'),
          frameSizeLimit: technical(
            z
              .number()
              .int()
              .min(0)
              .default(128 * 1024)
              .describe('Largest single sync message, in bytes. 0 = no limit.'),
            'NEG-MSG frame size limit passed to the negentropy reconciler.',
          ),
          maxSessions: z
            .number()
            .int()
            .positive()
            .default(4)
            .describe('How many syncs one connection may run at the same time.'),
        })
        .prefault({})
        .describe('Fast sync with other relays and apps'),
      'NIP-77 negentropy set reconciliation (NEG-OPEN/NEG-MSG/NEG-CLOSE).',
    ),
    groups: technical(
      z
        .object({
          enabled: z.boolean().default(true).describe('Allow group chats (channels) on this relay'),
          whoCanCreate: labels(z.enum(['anyone', 'owner']).default('anyone'), {
            anyone: 'Anyone who can post here',
            owner: 'Only the relay owner and admins',
          }).describe('Who may start a new group from a Nostr app'),
        })
        .prefault({})
        .describe('Group chats (channels)'),
      'NIP-29 relay-based groups: h-tagged posts, moderation kinds 9000–9009, join/leave 9021/9022, relay-signed 39000–39003. Admins can always create groups via the groups.* actions.',
    ),
    countScanLimit: technical(
      z
        .number()
        .int()
        .positive()
        .default(10_000)
        .describe(
          'Most posts checked when an app asks "how many?" about private content. Higher is more exact but slower.',
        ),
      'NIP-45: when filters may match audience-restricted events (gift wraps, private NIP-29 groups), COUNT scans up to this many matching events and applies REQ visibility per event; hitting the cap marks the answer approximate (a lower bound).',
    ),
    vanishIdCap: technical(
      z
        .number()
        .int()
        .min(0)
        .default(1000)
        .describe(
          'When someone asks to erase their account, how many removed posts are listed in the activity log. Everything is still erased.',
        ),
      'NIP-62: up to this many deleted ids are collected (query before vanish) for the event.deleted bus event; `count` carries the total.',
    ),
    software: technical(
      example(
        z
          .string()
          .default('https://github.com/beamhop/beamhop')
          .describe(
            'Web address of the relay software, shown to apps. Change it only if you run a modified version.',
          ),
        'https://github.com/beamhop/beamhop',
      ),
      'NIP-11 `software`.',
    ),
    version: technical(
      z
        .string()
        .default(BEAMHOP_VERSION)
        .describe('Software version shown to apps. Normally left as is.'),
      'NIP-11 `version`.',
    ),
  })
  .prefault({})
  .describe('Relay engine (how the server talks to Nostr apps)');

export type RelayModuleConfig = z.infer<typeof RelayModuleConfigSchema>;
