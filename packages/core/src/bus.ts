// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * In-process typed application event bus. Modules observe the system here
 * (insights, alerts, audit, webhooks, SIEM) without coupling to each other.
 * Cross-node fan-out uses the PubSub port, not this bus.
 */
import type { NostrEvent } from './event.ts';
import type { RelayId } from './ports.ts';

export interface AppEvents {
  'conn.open': {
    relayId: RelayId;
    connId: string;
    ipHash: string;
    userAgent?: string;
    /** ISO 3166 country code if the runtime/proxy provides one (e.g. CF `cf-ipcountry`). Never derived from raw IPs. */
    country?: string;
  };
  'conn.close': { relayId: RelayId; connId: string; durationMs: number };
  'event.accepted': { relayId: RelayId; event: NostrEvent; connId?: string; latencyMs: number };
  'event.rejected': {
    relayId: RelayId;
    eventId: string;
    pubkey: string;
    kind: number;
    reason: string;
    by?: string;
  };
  'event.held': { relayId: RelayId; event: NostrEvent; by?: string; reason?: string };
  'event.deleted': {
    /** `'*'` when the deletion spans all relays on the node (NIP-40 expiry sweeps). */
    relayId: RelayId;
    /** Deleted ids when cheaply known; may be empty or capped (see `count`). */
    ids: string[];
    cause: 'nip09' | 'nip62' | 'admin' | 'retention' | 'expiry';
    /** Total number of deleted events when known; may exceed `ids.length` (ids unknown or capped). */
    count?: number;
  };
  'req.served': {
    relayId: RelayId;
    connId: string;
    filters: number;
    results: number;
    latencyMs: number;
  };
  'auth.success': { relayId: RelayId; connId: string; pubkey: string };
  'report.received': { relayId: RelayId; report: NostrEvent };
  'blob.uploaded': { relayId: RelayId; sha256: string; size: number; type: string; pubkey: string };
  'blob.deleted': { relayId: RelayId; sha256: string; pubkey?: string; cause: string };
  'blob.quarantined': { relayId: RelayId; sha256: string; reason: string };
  'admin.action': {
    relayId: RelayId | null;
    actionId: string;
    principalId: string;
    input: unknown;
    summary: string;
    ok: boolean;
  };
  'config.changed': { revision: number; principalId: string; summary: string };
  error: { relayId?: RelayId; source: string; message: string; stack?: string };
}

export type AppEventName = keyof AppEvents;
type Handler<K extends AppEventName> = (payload: AppEvents[K]) => void;

export class EventBus {
  private handlers = new Map<AppEventName, Set<Handler<AppEventName>>>();

  on<K extends AppEventName>(name: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(handler as Handler<AppEventName>);
    return () => set?.delete(handler as Handler<AppEventName>);
  }

  /** Synchronous, isolated: a throwing handler never breaks the emitter. */
  emit<K extends AppEventName>(name: K, payload: AppEvents[K]): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const h of set) {
      try {
        h(payload);
      } catch (err) {
        if (name !== 'error') {
          this.emit('error', { source: `bus:${name}`, message: String(err) });
        }
      }
    }
  }
}
