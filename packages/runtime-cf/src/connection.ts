// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Core `Connection` over a hibernatable Durable Object WebSocket.
 *
 * Everything needed to rebuild the connection after the object hibernates is kept
 * in the socket attachment (`serializeAttachment`, max 2 KiB): identity, NIP-42
 * challenge, authed pubkeys and `conn.state` (module scratch space, which is where the
 * relay engine keeps subscriptions). When the encoded state does not fit, it spills to
 * Durable Object storage under `conn:<id>` and the attachment carries `ext: true`.
 *
 * `conn.state` values must be JSON-serializable; `Map` and `Set` are supported via
 * tagged encoding. Non-serializable entries (functions, class instances) are dropped.
 */
import type { Connection, RelayId } from '@beamhop/core';
import type { HibernatableWebSocket } from './cf-types.ts';

/** Stay safely below the 2048-byte attachment limit (structured clone overhead). */
export const ATTACHMENT_BUDGET = 1800;

export interface ConnMeta {
  id: string;
  relayId: RelayId;
  ipHash: string;
  userAgent?: string;
  openedAt: number;
  challenge: string;
}

export interface ConnAttachment extends ConnMeta {
  v: 1;
  authed: string[];
  /** Encoded `conn.state` when it fits inline. */
  state?: string;
  /** State lives in DO storage at `conn:<id>`. */
  ext?: true;
}

export function connStorageKey(id: string): string {
  return `conn:${id}`;
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) return { $map: [...value.entries()] };
  if (value instanceof Set) return { $set: [...value.values()] };
  if (typeof value === 'bigint') return undefined;
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1) {
      const v = value as { $map?: unknown; $set?: unknown };
      if (keys[0] === '$map' && Array.isArray(v.$map)) {
        return new Map(v.$map as Array<[unknown, unknown]>);
      }
      if (keys[0] === '$set' && Array.isArray(v.$set)) return new Set(v.$set);
    }
  }
  return value;
}

/** Encode `conn.state`; entries that cannot be serialized are skipped. */
export function encodeState(state: Map<string, unknown>): string {
  const entries: Array<[string, unknown]> = [];
  for (const [k, v] of state) {
    try {
      const s = JSON.stringify(v, replacer);
      if (s !== undefined) entries.push([k, JSON.parse(s)]);
    } catch {
      // Non-serializable (cycles, etc.): not restorable after hibernation.
    }
  }
  return JSON.stringify(entries);
}

export function decodeState(encoded: string | undefined | null): Map<string, unknown> {
  if (!encoded) return new Map();
  try {
    const entries = JSON.parse(encoded, reviver) as Array<[string, unknown]>;
    return new Map(entries);
  } catch {
    return new Map();
  }
}

const utf8 = new TextEncoder();

/**
 * `conn.state` that reports writes. Handlers may change state without sending
 * a frame (e.g. the relay engine on CLOSE / NEG-CLOSE, possibly after earlier
 * messages on its per-connection chain finished); every `set`/`delete`/`clear`
 * marks the connection dirty so the change is persisted before the object can
 * hibernate and a closed subscription is never resurrected.
 */
export class ObservedStateMap extends Map<string, unknown> {
  onChange?: () => void;
  override set(key: string, value: unknown): this {
    super.set(key, value);
    this.onChange?.();
    return this;
  }
  override delete(key: string): boolean {
    const had = super.delete(key);
    if (had) this.onChange?.();
    return had;
  }
  override clear(): void {
    const had = this.size > 0;
    super.clear();
    if (had) this.onChange?.();
  }
}

export class HibernatableConnection implements Connection {
  readonly id: string;
  readonly relayId: RelayId;
  readonly ipHash: string;
  readonly userAgent?: string;
  readonly openedAt: number;
  readonly authed: Set<string>;
  challenge: string;
  readonly state: Map<string, unknown>;
  /** State currently spilled to DO storage. */
  ext = false;
  closed = false;
  /** Last persisted signature, to skip redundant writes. */
  lastPersisted = '';

  constructor(
    readonly ws: HibernatableWebSocket,
    meta: ConnMeta,
    restored?: { authed?: Iterable<string>; state?: Map<string, unknown>; ext?: boolean },
    private readonly onActivity?: (conn: HibernatableConnection) => void,
  ) {
    this.id = meta.id;
    this.relayId = meta.relayId;
    this.ipHash = meta.ipHash;
    if (meta.userAgent !== undefined) this.userAgent = meta.userAgent;
    this.openedAt = meta.openedAt;
    this.challenge = meta.challenge;
    this.authed = new Set(restored?.authed ?? []);
    const state = new ObservedStateMap(restored?.state ?? []);
    state.onChange = () => {
      if (!this.closed) this.onActivity?.(this);
    };
    this.state = state;
    this.ext = restored?.ext ?? false;
  }

  send(frame: string): void {
    if (this.closed) return;
    try {
      this.ws.send(frame);
    } catch {
      // Socket already gone; the close handler cleans up.
    }
    // Sends usually follow async work that mutated state (EOSE after REQ, OK after AUTH).
    this.onActivity?.(this);
  }

  /** Workers WebSockets do not expose a send buffer. */
  bufferedAmount(): number {
    return 0;
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close(code ?? 1000, reason ?? '');
    } catch {
      // ignore
    }
  }

  meta(): ConnMeta {
    const m: ConnMeta = {
      id: this.id,
      relayId: this.relayId,
      ipHash: this.ipHash,
      openedAt: this.openedAt,
      challenge: this.challenge,
    };
    if (this.userAgent !== undefined) m.userAgent = this.userAgent;
    return m;
  }

  /**
   * Build the attachment. Returns the encoded state separately when it must spill
   * to storage (`spill`), or `null` when nothing changed since the last persist.
   */
  snapshot(): { attachment: ConnAttachment; spill: string | null; signature: string } | null {
    const state = encodeState(this.state);
    const authed = [...this.authed];
    const signature = `${this.challenge}|${authed.join(',')}|${state}`;
    if (signature === this.lastPersisted) return null;
    const base: ConnAttachment = { v: 1, ...this.meta(), authed };
    const inline: ConnAttachment = { ...base, state };
    if (utf8.encode(JSON.stringify(inline)).byteLength <= ATTACHMENT_BUDGET) {
      return { attachment: inline, spill: null, signature };
    }
    return { attachment: { ...base, ext: true }, spill: state, signature };
  }

  static isAttachment(v: unknown): v is ConnAttachment {
    return (
      !!v &&
      typeof v === 'object' &&
      (v as ConnAttachment).v === 1 &&
      typeof (v as ConnAttachment).id === 'string' &&
      typeof (v as ConnAttachment).relayId === 'string'
    );
  }

  static restore(
    ws: HibernatableWebSocket,
    att: ConnAttachment,
    extState: string | undefined,
    onActivity?: (conn: HibernatableConnection) => void,
  ): HibernatableConnection {
    const conn = new HibernatableConnection(
      ws,
      att,
      {
        authed: att.authed,
        state: decodeState(att.ext ? extState : att.state),
        ext: att.ext === true,
      },
      onActivity,
    );
    conn.lastPersisted = `${att.challenge}|${att.authed.join(',')}|${
      att.ext ? (extState ?? '') : (att.state ?? '')
    }`;
    return conn;
  }
}
