// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RelayId } from './ports.ts';

/**
 * Runtime-neutral WebSocket connection handed to the relay engine.
 * Bun and Cloudflare (Durable Object hibernation) each implement this.
 */
export interface Connection {
  readonly id: string;
  readonly relayId: RelayId;
  /** Privacy-preserving hashed IP (never the raw IP). */
  readonly ipHash: string;
  readonly userAgent?: string;
  /** ISO 3166 country code from a trusted proxy header (e.g. CF `cf-ipcountry`), if any. */
  readonly country?: string;
  readonly openedAt: number;
  /** Pubkeys authenticated via NIP-42 on this connection. */
  readonly authed: Set<string>;
  /** NIP-42 challenge issued to this connection. */
  challenge: string;
  /** Mutable scratch space for modules, namespaced by module id. */
  readonly state: Map<string, unknown>;
  send(frame: string): void;
  /** Bytes queued but not yet flushed (backpressure). */
  bufferedAmount(): number;
  close(code?: number, reason?: string): void;
}

/**
 * Request routing context resolved by the runtime from Host header / path prefix.
 */
export interface RouteContext {
  relayId: RelayId;
  /** Public base URL of this virtual relay, e.g. https://relay.example.com */
  publicUrl: string;
  ipHash: string;
  /** ISO 3166 country code from a trusted proxy header (e.g. CF `cf-ipcountry`), if any. */
  country?: string;
}

/** Web-standard HTTP handler. Return null to pass to the next handler. */
export type HttpHandler = (req: Request, ctx: RouteContext) => Promise<Response | null>;
