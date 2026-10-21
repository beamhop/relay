// SPDX-License-Identifier: AGPL-3.0-or-later
/** Clock, Logger and Crypto ports for Cloudflare Workers (Web-standard APIs only). */
import type { Clock, Crypto, LogLevel, Logger } from '@beamhop/core';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

/**
 * Note: inside a Worker `Date.now()` only advances across I/O (Spectre mitigation),
 * which is fine for Nostr's second-granularity timestamps.
 */
export const cfClock: Clock = {
  now: () => Math.floor(Date.now() / 1000),
  nowMs: () => Date.now(),
};

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function parseLogLevel(v: string | undefined): LogLevel {
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error' ? v : 'info';
}

export type LogSink = (line: string, level: LogLevel) => void;

const consoleSink: LogSink = (line, level) => {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

/** Structured JSON-lines logger (Workers Logs / `wrangler tail` index JSON fields). */
export class CfLogger implements Logger {
  constructor(
    private readonly min: LogLevel = 'info',
    private readonly base: Record<string, unknown> = {},
    private readonly sink: LogSink = consoleSink,
  ) {}

  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.min]) return;
    let line: string;
    try {
      line = JSON.stringify({ level, msg, ...this.base, ...fields });
    } catch {
      line = JSON.stringify({ level, msg, ...this.base, note: 'unserializable fields' });
    }
    this.sink(line, level);
  }

  child(fields: Record<string, unknown>): Logger {
    return new CfLogger(this.min, { ...this.base, ...fields }, this.sink);
  }
}

function toHex(buf: ArrayBuffer): string {
  return bytesToHex(new Uint8Array(buf));
}

/**
 * Crypto port. `sha256Hex`/`randomHex` use WebCrypto. `hashIp` must be synchronous
 * (port contract) and WebCrypto digests are async, so it uses a pure-JS HMAC-SHA256
 * keyed by `IP_HASH_SALT` + the current UTC day: hashes rotate daily and cannot be
 * reversed without the secret.
 */
export class CfCrypto implements Crypto {
  private readonly salt: string;

  constructor(
    salt: string | undefined,
    private readonly clock: Clock = cfClock,
    onEphemeralSalt?: () => void,
  ) {
    if (salt) {
      this.salt = salt;
    } else {
      // Per-isolate random salt: still private, but hashes differ across isolates.
      this.salt = this.randomHex(32);
      onEphemeralSalt?.();
    }
  }

  async sha256Hex(data: Uint8Array): Promise<string> {
    return toHex(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>));
  }

  randomHex(bytes: number): string {
    const b = new Uint8Array(bytes);
    crypto.getRandomValues(b);
    return bytesToHex(b);
  }

  hashIp(ip: string): string {
    const day = Math.floor(this.clock.now() / 86400);
    const key = new TextEncoder().encode(`${this.salt}:${day}`);
    return bytesToHex(hmac(sha256, key, new TextEncoder().encode(ip))).slice(0, 32);
  }
}
