// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Webhooks (§9): POST signed JSON to admin-configured URLs when app events
 * happen (bus) or when accepted Nostr events match a filter.
 *
 * Signature: `X-Beamhop-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>`
 * with `X-Beamhop-Timestamp: <unix seconds>` (timestamp in the MAC stops replays).
 * Failed deliveries are retried with exponential backoff (persisted queue in
 * DocStore `webhooks.queue`), then moved to the dead-letter collection
 * `webhooks.dead`. Private/loopback targets are blocked unless `allowPrivate`.
 */
import {
  type ActionDef,
  type AppEventName,
  type AppEvents,
  type BeamhopModule,
  type Kernel,
  type NostrEvent,
  defineAction,
  defineModule,
} from '@beamhop/core';
import { z } from 'zod';
import { commitConfig } from '../host/config-write.ts';
import { type ResolveHost, SsrfError, assertPublicUrl } from '../net/ssrf.ts';

export const WEBHOOKS_MODULE_ID = 'webhooks';
export const QUEUE_COLLECTION = 'webhooks.queue';
export const DEAD_COLLECTION = 'webhooks.dead';
export const STATS_COLLECTION = 'webhooks.stats';
export const RETRY_JOB = 'webhooks.retry';
export const SIGNATURE_HEADER = 'X-Beamhop-Signature';
export const TIMESTAMP_HEADER = 'X-Beamhop-Timestamp';

const APP_EVENTS = [
  'conn.open',
  'conn.close',
  'event.accepted',
  'event.rejected',
  'event.held',
  'event.deleted',
  'req.served',
  'auth.success',
  'report.received',
  'blob.uploaded',
  'blob.deleted',
  'blob.quarantined',
  'admin.action',
  'config.changed',
  'error',
] as const satisfies readonly AppEventName[];

const FilterSchema = z.object({
  kinds: z.array(z.number().int().min(0)).optional(),
  authors: z.array(z.string().regex(/^[0-9a-f]{64}$/)).optional(),
  relays: z.array(z.string()).optional(),
});
export type WebhookFilter = z.infer<typeof FilterSchema>;

export const WebhookSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  url: z.string().url(),
  /** App events to send (e.g. `blob.uploaded`, `report.received`). */
  events: z.array(z.enum(APP_EVENTS)).default([]),
  /** Also send accepted Nostr events matching this filter (type `nostr.event`). */
  filter: FilterSchema.optional(),
  secret: z.string().min(16),
  enabled: z.boolean().default(true),
  description: z.string().max(200).optional(),
});
export type Webhook = z.infer<typeof WebhookSchema>;

export const WebhooksConfigSchema = z
  .object({
    hooks: z.array(WebhookSchema).default([]),
    /** Allow targets on private / local networks (e.g. an internal service). */
    allowPrivate: z.boolean().default(false),
    maxAttempts: z.number().int().min(1).max(20).default(6),
    baseDelaySeconds: z.number().int().positive().default(10),
    maxDelaySeconds: z.number().int().positive().default(3600),
    timeoutMs: z.number().int().positive().max(60_000).default(10_000),
  })
  .prefault({});
export type WebhooksConfig = z.infer<typeof WebhooksConfigSchema>;

export interface Delivery {
  id: string;
  hookId: string;
  type: string;
  data: unknown;
  createdAt: number;
  attempt: number;
  nextAt?: number;
  lastError?: string;
  lastStatus?: number;
}

export interface WebhookStats {
  delivered: number;
  failedAttempts: number;
  deadLettered: number;
  lastStatus?: number;
  lastError?: string;
  lastDeliveredAt?: number;
}

const enc = new TextEncoder();

function hex(b: ArrayBuffer): string {
  return Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
}

/** `sha256=<hex>` over `"<timestamp>.<body>"`. */
export async function signPayload(
  secret: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${body}`));
  return `sha256=${hex(mac)}`;
}

/** Receiver-side check (constant time), for docs/tests and integrators using this package. */
export async function verifySignature(
  secret: string,
  timestamp: number,
  body: string,
  header: string,
): Promise<boolean> {
  const want = await signPayload(secret, timestamp, body);
  if (want.length !== header.length) return false;
  let r = 0;
  for (let i = 0; i < want.length; i++) r |= want.charCodeAt(i) ^ header.charCodeAt(i);
  return r === 0;
}

export function backoffSeconds(
  attempt: number,
  c: Pick<WebhooksConfig, 'baseDelaySeconds' | 'maxDelaySeconds'>,
): number {
  return Math.min(c.maxDelaySeconds, c.baseDelaySeconds * 2 ** Math.max(0, attempt - 1));
}

function matchesFilter(f: WebhookFilter, relayId: string, e: NostrEvent): boolean {
  if (f.kinds && !f.kinds.includes(e.kind)) return false;
  if (f.authors && !f.authors.includes(e.pubkey)) return false;
  if (f.relays && !f.relays.includes(relayId)) return false;
  return true;
}

export interface WebhooksOptions {
  fetch?: typeof fetch;
  resolveHost?: ResolveHost;
}

export class WebhookDispatcher {
  private unsubs: Array<() => void> = [];
  private readonly stats = new Map<string, WebhookStats>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    readonly kernel: Kernel,
    private readonly opts: WebhooksOptions = {},
  ) {}

  config(): WebhooksConfig {
    const r = WebhooksConfigSchema.safeParse(
      this.kernel.config().modules[WEBHOOKS_MODULE_ID] ?? {},
    );
    return r.success ? r.data : WebhooksConfigSchema.parse({});
  }

  async start(): Promise<void> {
    const { items } = await this.kernel.ports.docs.list<WebhookStats>(STATS_COLLECTION, {
      limit: 1000,
    });
    for (const { key, value } of items) this.stats.set(key, value);
    this.subscribe();
    this.kernel.onConfigChange(() => this.subscribe());
    this.kernel.ports.scheduler.every(RETRY_JOB, 5, () => this.processDue());
  }

  stop(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.kernel.ports.scheduler.cancel(RETRY_JOB);
  }

  /** (Re)subscribe to exactly the bus events some enabled webhook needs. */
  subscribe(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    const hooks = this.config().hooks.filter((h) => h.enabled);
    const names = new Set<AppEventName>();
    for (const h of hooks) {
      for (const n of h.events) names.add(n);
      if (h.filter) names.add('event.accepted');
    }
    for (const name of names) {
      this.unsubs.push(
        this.kernel.bus.on(name, (payload) =>
          this.onAppEvent(name, payload as AppEvents[typeof name]),
        ),
      );
    }
  }

  private onAppEvent(name: AppEventName, payload: unknown): void {
    for (const h of this.config().hooks) {
      if (!h.enabled) continue;
      if (h.events.includes(name as (typeof APP_EVENTS)[number])) this.enqueue(h, name, payload);
      if (name === 'event.accepted' && h.filter) {
        const p = payload as AppEvents['event.accepted'];
        if (matchesFilter(h.filter, p.relayId, p.event)) {
          this.enqueue(h, 'nostr.event', { relayId: p.relayId, event: p.event });
        }
      }
    }
  }

  enqueue(h: Webhook, type: string, data: unknown): void {
    const d: Delivery = {
      id: this.kernel.ports.crypto.randomHex(12),
      hookId: h.id,
      type,
      data,
      createdAt: this.kernel.ports.clock.now(),
      attempt: 0,
    };
    this.track(this.attempt(d));
  }

  private track(p: Promise<void>): void {
    const q = p.catch((err) =>
      this.kernel.ports.logger.log('error', 'webhook delivery crashed', { err: String(err) }),
    );
    this.inflight.add(q);
    q.finally(() => this.inflight.delete(q));
  }

  /** Wait for in-flight deliveries (tests, shutdown). */
  async flush(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  stat(hookId: string): WebhookStats {
    let s = this.stats.get(hookId);
    if (!s) {
      s = { delivered: 0, failedAttempts: 0, deadLettered: 0 };
      this.stats.set(hookId, s);
    }
    return s;
  }

  /** One HTTP attempt. Returns status / error without scheduling retries. */
  async send(
    h: Webhook,
    d: Pick<Delivery, 'id' | 'type' | 'data' | 'createdAt'>,
  ): Promise<{
    ok: boolean;
    status?: number;
    error?: string;
    permanent?: boolean;
  }> {
    const c = this.config();
    const body = JSON.stringify({
      id: d.id,
      webhook: h.id,
      type: d.type,
      createdAt: d.createdAt,
      data: d.data,
    });
    const ts = this.kernel.ports.clock.now();
    try {
      await assertPublicUrl(h.url, {
        allowPrivate: c.allowPrivate,
        ...(this.opts.resolveHost ? { resolveHost: this.opts.resolveHost } : {}),
      });
    } catch (err) {
      return { ok: false, error: (err as Error).message, permanent: err instanceof SsrfError };
    }
    try {
      const res = await (this.opts.fetch ?? fetch)(h.url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Beamhop-Webhooks/1',
          'X-Beamhop-Event': d.type,
          'X-Beamhop-Delivery': d.id,
          [TIMESTAMP_HEADER]: String(ts),
          [SIGNATURE_HEADER]: await signPayload(h.secret, ts, body),
        },
        body,
        signal: AbortSignal.timeout(c.timeoutMs),
      });
      await res.body?.cancel().catch(() => {});
      if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async attempt(d: Delivery): Promise<void> {
    const c = this.config();
    const h = c.hooks.find((x) => x.id === d.hookId);
    if (!h || !h.enabled) return; // removed or paused: drop
    const r = await this.send(h, d);
    const s = this.stat(h.id);
    const docs = this.kernel.ports.docs;
    const now = this.kernel.ports.clock.now();
    d.attempt++;
    if (r.status !== undefined) s.lastStatus = r.status;
    if (r.ok) {
      s.delivered++;
      s.lastDeliveredAt = now;
      await docs.put(STATS_COLLECTION, h.id, s);
      return;
    }
    s.failedAttempts++;
    s.lastError = r.error;
    d.lastError = r.error;
    if (r.status !== undefined) d.lastStatus = r.status;
    if (r.permanent || d.attempt >= c.maxAttempts) {
      s.deadLettered++;
      d.nextAt = undefined;
      await docs.put(DEAD_COLLECTION, `${h.id}:${d.createdAt}:${d.id}`, { ...d, deadAt: now });
      this.kernel.ports.logger.log('warn', 'webhook delivery gave up', {
        webhook: h.id,
        attempts: d.attempt,
        err: r.error,
      });
    } else {
      d.nextAt = now + backoffSeconds(d.attempt, c);
      await docs.put(QUEUE_COLLECTION, d.id, d);
    }
    await docs.put(STATS_COLLECTION, h.id, s);
  }

  /** Scheduler job: retry deliveries whose backoff has elapsed. */
  async processDue(): Promise<void> {
    const docs = this.kernel.ports.docs;
    const now = this.kernel.ports.clock.now();
    const { items } = await docs.list<Delivery>(QUEUE_COLLECTION, { limit: 200 });
    for (const { key, value } of items) {
      if ((value.nextAt ?? 0) > now) continue;
      await docs.delete(QUEUE_COLLECTION, key);
      this.track(this.attempt(value));
    }
    await this.flush();
  }

  async deadLetters(hookId?: string, limit = 50): Promise<Delivery[]> {
    const { items } = await this.kernel.ports.docs.list<Delivery>(DEAD_COLLECTION, {
      ...(hookId ? { prefix: `${hookId}:` } : {}),
      limit,
      reverse: true,
    });
    return items.map((i) => i.value);
  }
}

function webhookActions(w: WebhookDispatcher): ActionDef[] {
  const kernel = w.kernel;
  const describe = (h: Pick<Webhook, 'events' | 'filter'>) => {
    const parts: string[] = [...h.events];
    if (h.filter) {
      const f = h.filter;
      parts.push(
        `posts${f.kinds ? ` of kind ${f.kinds.join('/')}` : ''}${f.authors ? ` by ${f.authors.length} people` : ''}`,
      );
    }
    return parts.length ? parts.join(', ') : 'nothing yet';
  };
  const hostOf = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  };
  const update = (
    principalId: string,
    summary: string,
    fn: (c: WebhooksConfig) => WebhooksConfig,
  ) =>
    commitConfig(
      kernel,
      (cfg) => ({
        ...cfg,
        modules: { ...cfg.modules, [WEBHOOKS_MODULE_ID]: fn(w.config()) },
      }),
      { principalId, summary },
    );

  const list = defineAction({
    id: 'webhooks.list',
    title: 'Webhooks',
    description: 'See where Beamhop sends notifications and how deliveries are going.',
    technical: 'modules.webhooks.hooks with per-hook delivery stats; secrets are hidden.',
    scope: 'node',
    permission: 'relay.read',
    readOnly: true,
    keywords: ['webhooks', 'integrations', 'notifications'],
    input: z.object({}),
    async run() {
      const hooks = w.config().hooks.map(({ secret: _s, ...h }) => ({
        ...h,
        stats: w.stat(h.id),
      }));
      return { output: { hooks }, summary: `${hooks.length} webhooks` };
    },
  });

  const addInput = z.object({
    url: z.string().url().describe('Where to send notifications'),
    events: z.array(z.enum(APP_EVENTS)).default([]).describe('What to send'),
    filter: FilterSchema.optional().describe('Also send new posts matching this filter'),
    secret: z.string().min(16).optional().describe('Shared secret (created for you if empty)'),
    description: z.string().max(200).optional(),
  });

  const add = defineAction({
    id: 'webhooks.add',
    title: 'Add a webhook',
    description: 'Send a signed notification to another service when something happens.',
    technical:
      'POST JSON, HMAC-SHA256 in X-Beamhop-Signature over "<timestamp>.<body>", retries with backoff.',
    scope: 'node',
    permission: 'plugins.write',
    keywords: ['webhook', 'integration', 'notify'],
    input: addInput,
    async preview(input) {
      const lines: Array<{
        kind: 'add' | 'warning' | 'info';
        text: string;
        technical?: string;
      }> = [
        {
          kind: 'add',
          text: `Send ${describe(input)} to ${hostOf(input.url)}`,
          technical: `POST ${input.url}`,
        },
      ];
      try {
        await assertPublicUrl(input.url, { allowPrivate: w.config().allowPrivate });
      } catch (err) {
        lines.push({ kind: 'warning', text: (err as Error).message });
      }
      if (input.events.length === 0 && !input.filter) {
        lines.push({ kind: 'warning', text: 'Nothing is selected, so nothing will be sent yet' });
      }
      return lines;
    },
    async run(input, ctx) {
      const c = w.config();
      await assertPublicUrl(input.url, { allowPrivate: c.allowPrivate });
      const id = `wh_${kernel.ports.crypto.randomHex(6)}`;
      const secret = input.secret ?? kernel.ports.crypto.randomHex(32);
      const hook: Webhook = WebhookSchema.parse({ ...input, id, secret, enabled: true });
      await update(ctx.principal.id, `Added webhook to ${hostOf(input.url)}`, (cur) => ({
        ...cur,
        hooks: [...cur.hooks, hook],
      }));
      return {
        // The secret is shown once so the receiver can verify signatures.
        output: { id, secret, url: hook.url },
        summary: `Added a webhook to ${hostOf(input.url)}`,
        undo: {
          actionId: 'webhooks.add',
          payload: { id },
          expiresAt: kernel.ports.clock.now() + 300,
        },
      };
    },
    async undo(payload, ctx) {
      const { id } = payload as { id: string };
      await update(ctx.principal.id, 'Undo add webhook', (cur) => ({
        ...cur,
        hooks: cur.hooks.filter((h) => h.id !== id),
      }));
    },
  });

  const remove = defineAction({
    id: 'webhooks.remove',
    title: 'Remove a webhook',
    description: 'Stop sending notifications to a service.',
    technical: 'Removes modules.webhooks.hooks[id]; queued retries are dropped.',
    scope: 'node',
    permission: 'plugins.write',
    keywords: ['webhook', 'remove', 'delete'],
    input: z.object({ id: z.string() }),
    async preview(input) {
      const h = w.config().hooks.find((x) => x.id === input.id);
      return h
        ? [{ kind: 'remove', text: `Stop sending ${describe(h)} to ${hostOf(h.url)}` }]
        : [{ kind: 'warning', text: 'There is no such webhook' }];
    },
    async run(input, ctx) {
      const prev = w.config().hooks.find((x) => x.id === input.id);
      if (!prev) throw new Error('There is no such webhook');
      await update(ctx.principal.id, `Removed webhook to ${hostOf(prev.url)}`, (cur) => ({
        ...cur,
        hooks: cur.hooks.filter((h) => h.id !== input.id),
      }));
      return {
        output: { id: input.id, removed: true },
        summary: `Removed the webhook to ${hostOf(prev.url)}`,
        undo: {
          actionId: 'webhooks.remove',
          payload: { hook: prev },
          expiresAt: kernel.ports.clock.now() + 300,
        },
      };
    },
    async undo(payload, ctx) {
      const { hook } = payload as { hook: Webhook };
      await update(ctx.principal.id, 'Undo remove webhook', (cur) => ({
        ...cur,
        hooks: [...cur.hooks.filter((h) => h.id !== hook.id), hook],
      }));
    },
  });

  const test = defineAction({
    id: 'webhooks.test',
    title: 'Send a test notification',
    description: 'Send a test message now to check that the other service receives it.',
    technical: 'Single signed POST of type "ping"; no retries.',
    scope: 'node',
    permission: 'plugins.write',
    keywords: ['webhook', 'test', 'ping'],
    input: z.object({ id: z.string() }),
    async preview(input) {
      const h = w.config().hooks.find((x) => x.id === input.id);
      return [{ kind: 'info', text: `Send a test message to ${h ? hostOf(h.url) : '?'}` }];
    },
    async run(input) {
      const h = w.config().hooks.find((x) => x.id === input.id);
      if (!h) throw new Error('There is no such webhook');
      const r = await w.send(h, {
        id: kernel.ports.crypto.randomHex(12),
        type: 'ping',
        data: { message: 'Hello from Beamhop' },
        createdAt: kernel.ports.clock.now(),
      });
      return {
        output: r,
        summary: r.ok
          ? `The test message was delivered (HTTP ${r.status})`
          : `The test message was not delivered: ${r.error}`,
      };
    },
  });

  return [list, add, remove, test];
}

/** `webhooks` module. Without configured webhooks it subscribes to nothing. */
export function createWebhooksModule(opts: WebhooksOptions = {}): BeamhopModule {
  let w: WebhookDispatcher | undefined;
  return defineModule({
    id: WEBHOOKS_MODULE_ID,
    configSchema: WebhooksConfigSchema,
    register(kernel) {
      w = new WebhookDispatcher(kernel, opts);
      for (const a of webhookActions(w)) kernel.actions.register(a);
      kernel.provide(WEBHOOKS_MODULE_ID, w);
    },
    async start() {
      await w?.start();
    },
    async stop() {
      w?.stop();
      await w?.flush();
    },
  });
}
