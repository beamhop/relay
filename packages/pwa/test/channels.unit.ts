// SPDX-License-Identifier: AGPL-3.0-or-later
/** Alert channels editor: each type asks only for its fields and yields a valid channel. */
import { AlertChannelSchema } from '@beamhop/core';
import { describe, expect, it } from 'vitest';
import {
  CHANNEL_TYPES,
  addChannelPatch,
  buildChannel,
  channelTarget,
  nextChannelId,
  removeChannelPatch,
} from '../src/lib/alert-channels.ts';

const HEX = 'a'.repeat(64);

const valid: Record<string, Record<string, string>> = {
  webpush: {},
  'nostr-dm': { pubkey: HEX },
  telegram: { botToken: '123456:ABCDEFGHIJKLMNOP', chatId: '-100123' },
  discord: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' },
  slack: { webhookUrl: 'https://hooks.slack.com/services/T/B/x' },
  email: { to: 'ops@example.com', smtpUrl: 'smtps://u:p@mail.example.com:465' },
};

describe('alert channels', () => {
  it('offers the six channel types in order', () => {
    expect(CHANNEL_TYPES.map((t) => t.type)).toEqual([
      'webpush',
      'nostr-dm',
      'telegram',
      'discord',
      'slack',
      'email',
    ]);
  });

  it('builds channels that match the server schema', () => {
    for (const t of CHANNEL_TYPES) {
      const r = buildChannel(t.type, valid[t.type] ?? {}, []);
      expect(r.errors, t.type).toEqual({});
      expect(AlertChannelSchema.safeParse(r.channel).success, t.type).toBe(true);
      // only the fields this type needs
      expect(Object.keys(r.channel ?? {}).sort()).toEqual(
        ['id', 'type', ...t.fields.map((f) => f.key)].sort(),
      );
    }
  });

  it('explains what is wrong, field by field', () => {
    expect(buildChannel('telegram', {}, []).errors).toEqual({
      botToken: 'required',
      chatId: 'required',
    });
    expect(buildChannel('discord', { webhookUrl: 'not a url' }, []).errors).toEqual({
      webhookUrl: 'url',
    });
    expect(buildChannel('email', { to: 'nope', smtpUrl: 'http://x' }, []).errors).toEqual({
      to: 'email',
      smtpUrl: 'smtp',
    });
    expect(buildChannel('nostr-dm', { pubkey: 'npub1xyz' }, [], () => null).errors).toEqual({
      pubkey: 'pubkey',
    });
    expect(buildChannel('nostr-dm', { pubkey: 'npub1ok' }, [], () => HEX).channel?.pubkey).toBe(
      HEX,
    );
  });

  it('picks a free id and appends with a JSON Patch', () => {
    expect(nextChannelId('slack', [])).toBe('slack');
    expect(nextChannelId('slack', [{ id: 'slack' }, { id: 'slack-2' }])).toBe('slack-3');
    const c = buildChannel('slack', valid.slack ?? {}, [{ id: 'slack' }]).channel;
    expect(c?.id).toBe('slack-2');
    expect(addChannelPatch(c!, 3)).toEqual([{ op: 'add', path: '/alerts/channels/3', value: c }]);
    expect(removeChannelPatch(1)).toEqual([{ op: 'remove', path: '/alerts/channels/1' }]);
  });

  it('describes where a channel delivers without secrets', () => {
    expect(
      channelTarget({
        type: 'discord',
        id: 'd',
        webhookUrl: 'https://discord.com/api/webhooks/1/secret',
      }),
    ).toBe('discord.com');
    expect(channelTarget({ type: 'telegram', id: 't', botToken: 'secret', chatId: '42' })).toBe(
      '42',
    );
    expect(channelTarget({ type: 'email', id: 'e', to: 'a@b.c', smtpUrl: 'smtps://u:pw@h' })).toBe(
      'a@b.c',
    );
  });
});
