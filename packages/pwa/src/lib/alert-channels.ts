// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Alert channels editor (§8): the friendly "add a channel" flow. Each channel
 * type asks only for what it needs; the result is one JSON Patch op on
 * `alerts.channels` that goes through the standard propose → diff → apply.
 * Shapes mirror `AlertChannelSchema` in @beamhop/core.
 */

export type ChannelType = 'webpush' | 'nostr-dm' | 'telegram' | 'discord' | 'slack' | 'email';

export interface AlertChannel {
  type: ChannelType | string;
  id: string;
  [key: string]: unknown;
}

export interface ChannelField {
  key: string;
  kind: 'text' | 'secret' | 'url' | 'email';
  /** Message key suffix for the label / help (`channel_field_<key>` / `_help`). */
  placeholder?: string;
}

/** The order of the type picker, with the fields each type needs. */
export const CHANNEL_TYPES: ReadonlyArray<{ type: ChannelType; fields: ChannelField[] }> = [
  { type: 'webpush', fields: [] },
  { type: 'nostr-dm', fields: [{ key: 'pubkey', kind: 'text', placeholder: 'npub1…' }] },
  {
    type: 'telegram',
    fields: [
      { key: 'botToken', kind: 'secret', placeholder: '123456:ABC…' },
      { key: 'chatId', kind: 'text', placeholder: '-1001234567890' },
    ],
  },
  {
    type: 'discord',
    fields: [{ key: 'webhookUrl', kind: 'url', placeholder: 'https://discord.com/api/webhooks/…' }],
  },
  {
    type: 'slack',
    fields: [{ key: 'webhookUrl', kind: 'url', placeholder: 'https://hooks.slack.com/services/…' }],
  },
  {
    type: 'email',
    fields: [
      { key: 'to', kind: 'email', placeholder: 'ops@example.com' },
      { key: 'smtpUrl', kind: 'secret', placeholder: 'smtps://user:password@mail.example.com:465' },
    ],
  },
];

export function fieldsFor(type: ChannelType): ChannelField[] {
  return CHANNEL_TYPES.find((t) => t.type === type)?.fields ?? [];
}

/** A channel id that is not taken yet (`telegram`, `telegram-2`, …). */
export function nextChannelId(type: string, existing: readonly { id: string }[]): string {
  const taken = new Set(existing.map((c) => c.id));
  if (!taken.has(type)) return type;
  for (let i = 2; ; i++) if (!taken.has(`${type}-${i}`)) return `${type}-${i}`;
}

export type FieldError = 'required' | 'pubkey' | 'url' | 'email' | 'smtp' | 'telegram-token';

export interface BuildResult {
  channel: AlertChannel | null;
  errors: Record<string, FieldError>;
}

const HEX64 = /^[0-9a-f]{64}$/;

function isUrl(v: string, protocols: string[]): boolean {
  try {
    return protocols.includes(new URL(v).protocol);
  } catch {
    return false;
  }
}

/**
 * Validate the form values for a type and build the channel object.
 * `decodeNpub` turns an `npub1…` into hex (nostr-tools nip19, loaded by the caller).
 */
export function buildChannel(
  type: ChannelType,
  values: Record<string, string>,
  existing: readonly { id: string }[],
  decodeNpub?: (npub: string) => string | null,
): BuildResult {
  const errors: Record<string, FieldError> = {};
  const out: AlertChannel = { type, id: nextChannelId(type, existing) };
  for (const f of fieldsFor(type)) {
    const v = (values[f.key] ?? '').trim();
    if (!v) {
      errors[f.key] = 'required';
      continue;
    }
    if (f.key === 'pubkey') {
      const hex = v.startsWith('npub1') ? (decodeNpub?.(v) ?? null) : v.toLowerCase();
      if (!hex || !HEX64.test(hex)) errors[f.key] = 'pubkey';
      else out.pubkey = hex;
      continue;
    }
    if (f.kind === 'url' && !isUrl(v, ['https:', 'http:'])) {
      errors[f.key] = 'url';
      continue;
    }
    if (f.kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
      errors[f.key] = 'email';
      continue;
    }
    if (f.key === 'smtpUrl' && !isUrl(v, ['smtp:', 'smtps:'])) {
      errors[f.key] = 'smtp';
      continue;
    }
    if (f.key === 'botToken' && !/^\d+:[\w-]{10,}$/.test(v)) {
      errors[f.key] = 'telegram-token';
      continue;
    }
    out[f.key] = v;
  }
  return { channel: Object.keys(errors).length ? null : out, errors };
}

/** JSON Patch that appends a channel (index = current length, valid RFC 6902 "add"). */
export function addChannelPatch(channel: AlertChannel, count: number) {
  return [{ op: 'add' as const, path: `/alerts/channels/${count}`, value: channel }];
}

export function removeChannelPatch(index: number) {
  return [{ op: 'remove' as const, path: `/alerts/channels/${index}` }];
}

/** A short, non-secret description of where a channel delivers. */
export function channelTarget(c: AlertChannel): string {
  switch (c.type) {
    case 'nostr-dm':
      return typeof c.pubkey === 'string' ? `${c.pubkey.slice(0, 8)}…` : '';
    case 'telegram':
      return typeof c.chatId === 'string' ? c.chatId : '';
    case 'discord':
    case 'slack':
      try {
        return new URL(String(c.webhookUrl)).host;
      } catch {
        return '';
      }
    case 'email':
      return typeof c.to === 'string' ? c.to : '';
    default:
      return '';
  }
}
