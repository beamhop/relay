// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Built-in filters as PolicyHooks, in the priority bands of core `policy.ts`:
 *   0-99 access · 100-199 limits · 200-299 content.
 * Hooks never mutate state on dry runs (`ctx.dryRun`).
 */
import {
  ACCEPT,
  type Decision,
  type NostrEvent,
  type PolicyContext,
  type PolicyHooks,
  type RelayId,
  reject,
} from '@beamhop/core';
import { canReadChain, canWriteChain } from './access.ts';
import { deriveSpamSettings } from './goals.ts';
import { type PolicyRuntime, SPAM_HOOKS } from './runtime.ts';
import {
  type SimHash,
  contentHash,
  formatBytes,
  hamming,
  leadingZeroBits,
  normalizeText,
  simhash,
} from './util.ts';

/** Kinds whose content is human-readable text (spam/duplicate checks apply). */
export const TEXT_KINDS = new Set([1, 9, 11, 42, 1111, 1311, 30023]);

/** Kinds that must always be possible (deletion requests, right to vanish). */
const ALWAYS_ALLOWED_KINDS = new Set([5, 62]);

export const KEYWORD_PACKS: Record<string, string[]> = {
  scam: [
    'free airdrop',
    'claim your airdrop',
    'claim your reward',
    'double your bitcoin',
    'send btc to',
    'guaranteed profit',
    'dm me for investment',
    'crypto giveaway',
    'wallet validation',
    'connect your wallet to claim',
  ],
  'adult-spam': ['hot singles in your area', 'click here for nudes'],
};

export const LINK_PACKS: Record<string, string[]> = {
  shorteners: [
    'bit.ly',
    'tinyurl.com',
    't.co',
    'goo.gl',
    'is.gd',
    'cutt.ly',
    'rb.gy',
    'shorturl.at',
  ],
  'adult-spam': ['onlyfans.com'],
};

const URL_RE = /https?:\/\/[^\s<>"']+/gi;

class DuplicateWindow {
  private exact = new Map<string, number>();
  private sims: Array<{ h: SimHash; at: number }> = [];

  check(norm: string, now: number, distance: number): 'exact' | 'near' | undefined {
    const exp = this.exact.get(contentHash(norm));
    if (exp !== undefined && exp > now) return 'exact';
    if (distance > 0) {
      const h = simhash(norm);
      for (let i = this.sims.length - 1; i >= 0; i--) {
        const s = this.sims[i] as { h: SimHash; at: number };
        if (s.at < now) break;
        if (hamming(h, s.h) <= distance) return 'near';
      }
    }
    return undefined;
  }

  record(norm: string, now: number, windowSeconds: number, distance: number): void {
    if (this.exact.size > 50_000) {
      for (const [k, v] of this.exact) if (v <= now) this.exact.delete(k);
    }
    this.exact.set(contentHash(norm), now + windowSeconds);
    if (distance > 0) {
      // `at` stores expiry so the reverse scan can stop at the first expired entry.
      this.sims.push({ h: simhash(norm), at: now + windowSeconds });
      if (this.sims.length > 2000) this.sims = this.sims.slice(-1000);
    }
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function domainBlocked(host: string, domains: string[]): boolean {
  for (const d of domains) {
    const dd = d.toLowerCase();
    if (host === dd || host.endsWith(`.${dd}`)) return true;
  }
  return false;
}

/** Wrap every hook method to record non-accept decisions in stats and the spam tracker. */
function instrument(rt: PolicyRuntime, hook: PolicyHooks): PolicyHooks {
  const out: PolicyHooks = { id: hook.id, priority: hook.priority };
  const names = ['onConnect', 'onAuth', 'onEvent', 'onReq', 'onUpload', 'onBlobServe'] as const;
  for (const name of names) {
    const fn = hook[name] as ((...a: unknown[]) => Decision | Promise<Decision>) | undefined;
    if (!fn) continue;
    (out as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      const d = await fn.apply(hook, args);
      if (d.action === 'accept') return d;
      const ctx = args[args.length - 1] as PolicyContext;
      if (ctx.dryRun) return d;
      rt.stats.record(hook.id, d);
      if (name === 'onEvent' && SPAM_HOOKS.has(hook.id)) {
        const event = args[0] as NostrEvent;
        rt.track(
          recordSpam(rt, ctx.relayId, event.pubkey, ctx.now, hook.id),
          'policy.spam-tracker',
        );
      }
      return d;
    };
  }
  return out;
}

async function recordSpam(
  rt: PolicyRuntime,
  relayId: RelayId,
  pubkey: string,
  now: number,
  by: string,
): Promise<void> {
  const relay = rt.relay(relayId);
  if (!relay) return;
  const days = Math.max(1, deriveSpamSettings(relay).newKeyDays);
  const isNew = await rt.isNewKey(relay, pubkey, days, now);
  rt.spam.record(relayId, { pubkey, at: now, isNew, by }, rt.config().spamWave.windowMinutes * 60);
}

export function createHooks(rt: PolicyRuntime): PolicyHooks[] {
  const kernel = rt.kernel;
  const dupWindows = new Map<RelayId, DuplicateWindow>();
  const limitsFor = (ctx: PolicyContext) => kernel.limits(ctx.relayId, ctx.tier);

  const hooks: PolicyHooks[] = [
    {
      id: 'policy.recycled',
      priority: 5,
      async onEvent(event, ctx) {
        if (await rt.state.isRecycled(ctx.relayId, event.id))
          return reject('blocked', 'this post was removed by a moderator');
        return ACCEPT;
      },
      async onBlobServe(sha256, ctx) {
        if (await rt.state.isRecycled(ctx.relayId, sha256))
          return reject('blocked', 'this file was removed by a moderator');
        return ACCEPT;
      },
    },
    {
      id: 'policy.banned',
      priority: 10,
      async onEvent(event, ctx) {
        return (await banned(event.pubkey, ctx.relayId))
          ? reject('blocked', 'this account is blocked on this relay')
          : ACCEPT;
      },
      async onAuth(pubkey, ctx) {
        return (await banned(pubkey, ctx.relayId))
          ? reject('blocked', 'this account is blocked on this relay')
          : ACCEPT;
      },
      async onUpload(info, ctx) {
        return (await banned(info.pubkey, ctx.relayId))
          ? reject('blocked', 'this account is blocked on this relay')
          : ACCEPT;
      },
    },
    {
      id: 'policy.auth',
      priority: 20,
      onEvent(event, ctx) {
        const relay = rt.relay(ctx.relayId);
        if (!relay?.access.authRequired.write || !ctx.conn) return ACCEPT;
        return ctx.conn.authed.has(event.pubkey)
          ? ACCEPT
          : reject('auth-required', 'please sign in to post here');
      },
      onReq(_filters, ctx) {
        const relay = rt.relay(ctx.relayId);
        if (!relay?.access.authRequired.read || !ctx.conn) return ACCEPT;
        return ctx.conn.authed.size > 0
          ? ACCEPT
          : reject('auth-required', 'please sign in to read here');
      },
    },
    {
      id: 'policy.access',
      priority: 30,
      async onEvent(event, ctx) {
        const relay = rt.relay(ctx.relayId);
        if (!relay) return ACCEPT;
        const r = await canWriteChain(rt, ctx.relayId, event.pubkey);
        if (r.allowed) return ACCEPT;
        return reject(
          'restricted',
          r.by === 'policy.wot'
            ? 'only people trusted by this community can post here'
            : 'only members can post here',
        );
      },
      async onReq(_filters, ctx) {
        const relay = rt.relay(ctx.relayId);
        if (!relay?.access.authRequired.read || !ctx.conn) return ACCEPT;
        const keys = [...ctx.conn.authed];
        if (keys.length === 0) return ACCEPT; // policy.auth already asked to sign in
        for (const pk of keys) if ((await canReadChain(rt, ctx.relayId, pk)).allowed) return ACCEPT;
        return reject('restricted', 'only members can read here');
      },
    },
    {
      id: 'policy.mute',
      priority: 40,
      async onEvent(event, ctx) {
        return (await rt.state.isMuted(ctx.relayId, event.pubkey, ctx.now))
          ? { action: 'shadow', message: 'muted' }
          : ACCEPT;
      },
    },
    {
      id: 'policy.tiers',
      priority: 90,
      async onEvent(event, ctx) {
        ctx.tier ??= await rt.resolveTier(ctx.relayId, event.pubkey);
        return ACCEPT;
      },
      async onUpload(info, ctx) {
        ctx.tier ??= await rt.resolveTier(ctx.relayId, info.pubkey);
        return ACCEPT;
      },
    },
    {
      id: 'policy.rate-limit',
      priority: 100,
      onEvent(event, ctx) {
        const relay = rt.relay(ctx.relayId);
        if (!relay || rt.isOwner(relay, event.pubkey)) return ACCEPT;
        const nowMs = kernel.ports.clock.nowMs();
        const consume = !ctx.dryRun;
        const lim = limitsFor(ctx);
        if (
          !rt.buckets.take(`${ctx.relayId}:p:${event.pubkey}`, lim.eventsPerMinute, nowMs, consume)
        )
          return reject('rate-limited', `slow down: at most ${lim.eventsPerMinute} posts a minute`);
        const cfg = rt.config();
        if (cfg.rateLimitByIp && ctx.conn) {
          const ipLimit = Math.ceil(kernel.limits(ctx.relayId).eventsPerMinute * cfg.ipMultiplier);
          if (!rt.buckets.take(`${ctx.relayId}:ip:${ctx.conn.ipHash}`, ipLimit, nowMs, consume))
            return reject('rate-limited', 'slow down: too many posts from your network');
        }
        return ACCEPT;
      },
      onReq(_filters, ctx) {
        if (!ctx.conn) return ACCEPT;
        const lim = kernel.limits(ctx.relayId, ctx.tier);
        const ok = rt.buckets.take(
          `${ctx.relayId}:req:${ctx.conn.ipHash}`,
          lim.reqPerMinute,
          kernel.ports.clock.nowMs(),
          !ctx.dryRun,
        );
        return ok ? ACCEPT : reject('rate-limited', 'slow down: too many requests');
      },
    },
    {
      id: 'policy.event-size',
      priority: 110,
      onEvent(event, ctx) {
        const max = limitsFor(ctx).maxEventBytes;
        const json = JSON.stringify(event);
        // UTF-8 bytes are between length and 3×length; only encode when ambiguous.
        const bytes =
          json.length > max || json.length * 3 <= max
            ? json.length
            : new TextEncoder().encode(json).length;
        return bytes > max
          ? reject('invalid', `post is too large (max ${formatBytes(max)})`)
          : ACCEPT;
      },
    },
    {
      id: 'policy.kinds',
      priority: 120,
      onEvent(event, ctx) {
        const lim = limitsFor(ctx);
        if (lim.blockedKinds.includes(event.kind))
          return reject(
            'blocked',
            `this kind of content is not accepted here (kind ${event.kind})`,
          );
        if (
          lim.allowedKinds &&
          !ALWAYS_ALLOWED_KINDS.has(event.kind) &&
          !lim.allowedKinds.includes(event.kind)
        )
          return reject(
            'blocked',
            `this kind of content is not accepted here (kind ${event.kind})`,
          );
        return ACCEPT;
      },
    },
    {
      id: 'policy.created-at',
      priority: 130,
      onEvent(event, ctx) {
        const lim = limitsFor(ctx);
        if (event.created_at > ctx.now + lim.maxCreatedAtFutureSeconds)
          return reject('invalid', 'created_at is too far in the future');
        if (
          lim.maxCreatedAtPastSeconds > 0 &&
          event.created_at < ctx.now - lim.maxCreatedAtPastSeconds
        )
          return reject('invalid', 'created_at is too far in the past');
        return ACCEPT;
      },
    },
    {
      id: 'policy.pow',
      priority: 140,
      async onEvent(event, ctx) {
        const relay = rt.relay(ctx.relayId);
        if (!relay || rt.isOwner(relay, event.pubkey)) return ACCEPT;
        const lim = limitsFor(ctx);
        let required = lim.minPowDifficulty;
        if (lim.newKeyPowDifficulty > required) {
          const days = deriveSpamSettings(relay).newKeyDays;
          if (days > 0 && (await rt.isNewKey(relay, event.pubkey, days, ctx.now))) {
            required = lim.newKeyPowDifficulty;
          }
        }
        if (required <= 0) return ACCEPT;
        const bits = leadingZeroBits(event.id);
        if (bits < required) return reject('pow', `difficulty ${bits} is less than ${required}`);
        const nonce = event.tags.find((t) => t[0] === 'nonce');
        if (nonce?.[2] !== undefined) {
          const target = Number(nonce[2]);
          if (Number.isFinite(target) && target < required)
            return reject('pow', `committed target ${target} is less than ${required}`);
        }
        return ACCEPT;
      },
    },
    {
      id: 'policy.upload-limits',
      priority: 150,
      async onUpload(info, ctx) {
        const lim = limitsFor(ctx);
        if (info.size > lim.maxBlobBytes)
          return reject('blocked', `file is too large (max ${formatBytes(lim.maxBlobBytes)})`);
        const used = await kernel.ports.blobIndex.usage(ctx.relayId, info.pubkey);
        if (used + info.size > lim.defaultBlobQuotaBytes)
          return reject(
            'blocked',
            `storage quota reached (${formatBytes(lim.defaultBlobQuotaBytes)})`,
          );
        return ACCEPT;
      },
    },
    {
      id: 'policy.duplicate',
      priority: 200,
      onEvent(event, ctx) {
        if (!TEXT_KINDS.has(event.kind)) return ACCEPT;
        const relay = rt.relay(ctx.relayId);
        if (!relay || rt.isOwner(relay, event.pubkey)) return ACCEPT;
        const norm = normalizeText(event.content);
        if (norm.length < 12) return ACCEPT;
        const s = deriveSpamSettings(relay);
        let w = dupWindows.get(ctx.relayId);
        if (!w) {
          w = new DuplicateWindow();
          dupWindows.set(ctx.relayId, w);
        }
        const hit = w.check(norm, ctx.now, s.nearDuplicateDistance);
        if (hit === 'exact') return reject('blocked', 'duplicate content: this was just posted');
        if (!ctx.dryRun) w.record(norm, ctx.now, s.duplicateWindowSeconds, s.nearDuplicateDistance);
        if (hit === 'near')
          return { action: 'hold', message: 'looks like a copy of a recent post' };
        return ACCEPT;
      },
    },
    {
      id: 'policy.content',
      priority: 210,
      onEvent(event, ctx) {
        if (!TEXT_KINDS.has(event.kind)) return ACCEPT;
        const relay = rt.relay(ctx.relayId);
        if (!relay || rt.isOwner(relay, event.pubkey)) return ACCEPT;
        const cfg = rt.config().content;
        const urls = event.content.match(URL_RE) ?? [];
        const maxLinks = deriveSpamSettings(relay).maxLinks;
        if (urls.length > maxLinks) return reject('blocked', `too many links (max ${maxLinks})`);
        const domains = [...cfg.blockedDomains];
        const keywords = [...cfg.blockedKeywords];
        for (const p of cfg.packs) {
          domains.push(...(LINK_PACKS[p] ?? []));
          keywords.push(...(KEYWORD_PACKS[p] ?? []));
        }
        for (const u of urls) {
          const host = hostOf(u);
          if (host && domainBlocked(host, domains))
            return reject('blocked', `links to ${host} are not allowed here`);
        }
        if (keywords.length) {
          const norm = normalizeText(event.content);
          for (const k of keywords) {
            const nk = normalizeText(k);
            if (nk && norm.includes(nk))
              return reject('blocked', 'this post matches a blocked phrase');
          }
        }
        return ACCEPT;
      },
    },
  ];

  async function banned(pubkey: string, relayId: RelayId): Promise<boolean> {
    if (rt.config().bannedPubkeys.includes(pubkey)) return true;
    return rt.state.isBanned(relayId, pubkey);
  }

  return hooks.map((h) => instrument(rt, h));
}
