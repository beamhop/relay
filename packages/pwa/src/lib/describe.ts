// SPDX-License-Identifier: AGPL-3.0-or-later
/** Plain-language one-liners for live events (Activity stream). */
import { m } from './paraglide/messages.js';
import type { LiveItem } from './stores/live.svelte.ts';
import { names } from './stores/names.svelte.ts';
import { formatBytes } from './utils.ts';

export type StreamFilter = 'all' | 'posts' | 'blocked' | 'reports' | 'media' | 'admin' | 'errors';

export const FILTERS: StreamFilter[] = [
  'all',
  'posts',
  'blocked',
  'reports',
  'media',
  'admin',
  'errors',
];

const GROUP: Record<string, StreamFilter> = {
  'event.accepted': 'posts',
  'event.deleted': 'posts',
  'event.rejected': 'blocked',
  'event.held': 'reports',
  'report.received': 'reports',
  'blob.uploaded': 'media',
  'blob.deleted': 'media',
  'blob.quarantined': 'media',
  'admin.action': 'admin',
  'config.changed': 'admin',
  error: 'errors',
};

export function groupOf(name: string): StreamFilter | null {
  return GROUP[name] ?? null;
}

export function describeLive(i: LiveItem): {
  text: string;
  technical: string;
  tone: 'ok' | 'warn' | 'critical' | 'neutral';
} {
  const d = i.data;
  const ev = (d.event ?? {}) as { kind?: number; pubkey?: string; id?: string };
  switch (i.name) {
    case 'event.accepted':
      return {
        text: m.live_post_accepted({ who: names.label(ev.pubkey) }),
        technical: `kind ${ev.kind} · ${ev.id ?? ''}`,
        tone: 'ok',
      };
    case 'event.rejected':
      return {
        text: m.live_post_rejected({
          who: names.label(d.pubkey as string),
          reason: names.text(String(d.reason ?? '')),
        }),
        technical: `kind ${d.kind} · ${d.eventId ?? ''} · ${d.by ?? ''}`,
        tone: 'warn',
      };
    case 'event.held':
      return {
        text: m.live_post_held({ who: names.label(ev.pubkey) }),
        technical: `kind ${ev.kind} · ${String(d.reason ?? '')}`,
        tone: 'warn',
      };
    case 'event.deleted':
      return {
        text: m.live_posts_deleted({ count: (d.ids as unknown[] | undefined)?.length ?? 0 }),
        technical: `cause ${d.cause}`,
        tone: 'neutral',
      };
    case 'report.received':
      return { text: m.live_report(), technical: 'kind 1984 (NIP-56)', tone: 'warn' };
    case 'blob.uploaded':
      return {
        text: m.live_upload({
          size: formatBytes(Number(d.size ?? 0)),
          who: names.label(d.pubkey as string),
        }),
        technical: `${d.type ?? ''} · ${d.sha256 ?? ''}`,
        tone: 'ok',
      };
    case 'blob.deleted':
      return {
        text: m.live_file_deleted(),
        technical: `${d.sha256 ?? ''} · ${d.cause ?? ''}`,
        tone: 'neutral',
      };
    case 'blob.quarantined':
      return {
        text: m.live_file_quarantined({ reason: String(d.reason ?? '') }),
        technical: String(d.sha256 ?? ''),
        tone: 'critical',
      };
    case 'admin.action':
      return {
        text: names.text(String(d.summary ?? d.actionId ?? '')),
        technical: String(d.actionId ?? ''),
        tone: d.ok === false ? 'critical' : 'neutral',
      };
    case 'config.changed':
      return {
        text: m.live_config_changed({ summary: names.text(String(d.summary ?? '')) }),
        technical: `revision ${d.revision}`,
        tone: 'neutral',
      };
    case 'auth.success':
      return {
        text: m.live_signed_in({ who: names.label(d.pubkey as string) }),
        technical: 'NIP-42 AUTH',
        tone: 'neutral',
      };
    case 'conn.open':
      return { text: m.live_connected(), technical: String(d.connId ?? ''), tone: 'neutral' };
    case 'conn.close':
      return { text: m.live_disconnected(), technical: String(d.connId ?? ''), tone: 'neutral' };
    case 'error':
      return {
        text: String(d.message ?? m.error_generic()),
        technical: String(d.source ?? ''),
        tone: 'critical',
      };
    default:
      return { text: i.name, technical: JSON.stringify(d).slice(0, 200), tone: 'neutral' };
  }
}
