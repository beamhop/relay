// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Bun adapters for the runtime-service ports: Scheduler, Clock, Logger, Crypto, PubSub.
 */
import type { Clock, Crypto, LogLevel, Logger, PubSub, Scheduler } from '@beamhop/core';

// ───────────────────────────── Clock ─────────────────────────────

export const systemClock: Clock = {
  now: () => Math.floor(Date.now() / 1000),
  nowMs: () => Date.now(),
};

// ───────────────────────────── Logger ─────────────────────────────

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface JsonLoggerOptions {
  level?: LogLevel;
  /** Line sink; defaults to stdout (warn/error to stderr). */
  write?: (line: string, level: LogLevel) => void;
  clock?: Clock;
}

const defaultWrite = (line: string, level: LogLevel) => {
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
};

/** One JSON object per line: `{"t":"…","level":"info","msg":"…",…fields}`. */
export class JsonLogger implements Logger {
  private readonly min: number;
  private readonly write: (line: string, level: LogLevel) => void;
  private readonly clock: Clock;
  constructor(
    private readonly opts: JsonLoggerOptions = {},
    private readonly base: Record<string, unknown> = {},
  ) {
    this.min = LEVELS[opts.level ?? 'info'];
    this.write = opts.write ?? defaultWrite;
    this.clock = opts.clock ?? systemClock;
  }
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < this.min) return;
    const rec: Record<string, unknown> = {
      t: new Date(this.clock.nowMs()).toISOString(),
      level,
      msg,
      ...this.base,
      ...fields,
    };
    let line: string;
    try {
      line = JSON.stringify(rec, errorReplacer);
    } catch {
      line = JSON.stringify({ t: rec.t, level, msg, note: 'unserializable fields' });
    }
    this.write(line, level);
  }
  child(fields: Record<string, unknown>): Logger {
    return new JsonLogger(this.opts, { ...this.base, ...fields });
  }
}

function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === 'bigint') return value.toString();
  return value;
}

// ───────────────────────────── Scheduler ─────────────────────────────

export interface BunSchedulerOptions {
  logger?: Logger;
  /** Fraction of the interval used as random jitter (default 0.1 → ±10%). */
  jitter?: number;
  /** Random source in [0,1) (tests). */
  random?: () => number;
}

interface Job {
  intervalMs: number;
  fn: () => Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  running?: Promise<void>;
  cancelled: boolean;
}

/**
 * Timer scheduler. Jobs never overlap: the next run is scheduled only after the
 * current run settles. Each delay gets ±jitter to avoid thundering herds.
 */
export class BunScheduler implements Scheduler {
  private readonly jobs = new Map<string, Job>();
  private readonly jitter: number;
  private readonly random: () => number;
  private stopped = false;

  constructor(private readonly opts: BunSchedulerOptions = {}) {
    this.jitter = opts.jitter ?? 0.1;
    this.random = opts.random ?? Math.random;
  }

  every(name: string, intervalSeconds: number, fn: () => Promise<void>): void {
    if (this.stopped) return;
    this.cancel(name);
    const job: Job = { intervalMs: Math.max(1, intervalSeconds * 1000), fn, cancelled: false };
    this.jobs.set(name, job);
    this.arm(name, job);
  }

  cancel(name: string): void {
    const job = this.jobs.get(name);
    if (!job) return;
    job.cancelled = true;
    if (job.timer) clearTimeout(job.timer);
    this.jobs.delete(name);
  }

  names(): string[] {
    return [...this.jobs.keys()];
  }

  /** Cancel all jobs and wait for in-flight runs to finish (graceful shutdown). */
  async stop(): Promise<void> {
    this.stopped = true;
    const running = [...this.jobs.values()].map((j) => j.running).filter(Boolean);
    for (const name of [...this.jobs.keys()]) this.cancel(name);
    await Promise.allSettled(running);
  }

  private delay(job: Job): number {
    const spread = job.intervalMs * this.jitter;
    return Math.max(1, Math.round(job.intervalMs + (this.random() * 2 - 1) * spread));
  }

  private arm(name: string, job: Job): void {
    if (job.cancelled) return;
    job.timer = setTimeout(() => {
      if (job.cancelled) return;
      job.running = (async () => {
        try {
          await job.fn();
        } catch (err) {
          this.opts.logger?.log('error', 'scheduled job failed', { job: name, err });
        }
      })().finally(() => {
        job.running = undefined;
        this.arm(name, job);
      });
    }, this.delay(job));
    // Background jobs must not keep the process alive on their own.
    (job.timer as { unref?: () => void }).unref?.();
  }
}

// ───────────────────────────── PubSub ─────────────────────────────

/** In-process fan-out. A failing handler never affects other subscribers. */
export class InProcessPubSub implements PubSub {
  private readonly subs = new Map<string, Set<(m: unknown) => void>>();
  constructor(private readonly logger?: Logger) {}
  async publish(channel: string, message: unknown): Promise<void> {
    const set = this.subs.get(channel);
    if (!set) return;
    for (const h of [...set]) {
      try {
        h(message);
      } catch (err) {
        this.logger?.log('error', 'pubsub handler failed', { channel, err });
      }
    }
  }
  subscribe(channel: string, handler: (m: unknown) => void): () => void {
    let set = this.subs.get(channel);
    if (!set) {
      set = new Set();
      this.subs.set(channel, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
      if (set?.size === 0) this.subs.delete(channel);
    };
  }
}

// ───────────────────────────── Crypto ─────────────────────────────

export type IpLoggingMode = 'hashed' | 'truncated' | 'off';

export interface BunCryptoOptions {
  /** Long-lived secret; the daily salt is derived from it. Random per process if absent. */
  secret?: Uint8Array;
  clock?: Clock;
  ipLogging?: IpLoggingMode;
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** Truncate an IP to its /24 (IPv4) or /48 (IPv6) network. */
export function truncateIp(ip: string): string {
  const v4 = ip.replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return `${v4.split('.').slice(0, 3).join('.')}.0`;
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return `${parts.slice(0, 3).join(':')}::`;
  }
  return ip;
}

/**
 * Crypto port. `hashIp` = sha256(dailySalt ‖ ip) truncated to 16 hex chars where
 * dailySalt = HMAC-SHA256(secret, "ip-salt:" + UTC day). Hashes are stable within a
 * day and unlinkable across days; raw IPs are never stored.
 */
export class BunCrypto implements Crypto {
  private readonly secret: Uint8Array;
  private readonly clock: Clock;
  private readonly mode: IpLoggingMode;
  private saltDay = -1;
  private salt = new Uint8Array();

  constructor(opts: BunCryptoOptions = {}) {
    this.secret = opts.secret ?? crypto.getRandomValues(new Uint8Array(32));
    this.clock = opts.clock ?? systemClock;
    this.mode = opts.ipLogging ?? 'hashed';
  }

  async sha256Hex(data: Uint8Array): Promise<string> {
    return new Bun.CryptoHasher('sha256').update(data).digest('hex');
  }

  randomHex(bytes: number): string {
    return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
  }

  /** Current salt (rotates at UTC midnight). */
  dailySalt(): Uint8Array {
    const day = Math.floor(this.clock.now() / 86400);
    if (day !== this.saltDay) {
      this.salt = new Uint8Array(
        new Bun.CryptoHasher('sha256', this.secret).update(`ip-salt:${day}`).digest(),
      );
      this.saltDay = day;
    }
    return this.salt;
  }

  hashIp(ip: string): string {
    if (this.mode === 'off') return 'anon';
    const input = this.mode === 'truncated' ? truncateIp(ip) : ip;
    return new Bun.CryptoHasher('sha256')
      .update(this.dailySalt())
      .update(input)
      .digest('hex')
      .slice(0, 16);
  }
}
