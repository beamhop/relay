/**
 * beamhop-plugin-spam-filter — heuristic spam scoring as a write hook.
 *
 * Each heuristic adds to a score; when the score reaches `threshold` the event is rejected
 * (or shadow-dropped). Heuristics:
 *  - duplicate content posted by many distinct pubkeys within a time window (copy/paste floods)
 *  - link density (too many URLs / mostly links)
 *  - mention floods (too many `p` tags)
 *  - new-account rate limits (pubkeys first seen recently may only post N events/minute)
 *  - repeated identical content from the same pubkey
 *
 * Type-only sdk imports + erasable TS: runs on Bun and Node ≥ 22.18 without building.
 */
import { z } from "zod";
import type { BeamhopPlugin, NostrEvent, WriteContext } from "@beamhop/sdk";

const Settings = z.object({
  kinds: z.array(z.number().int()).default([1, 1111, 42, 9802, 30023]).describe("Kinds to score (empty = all non-ephemeral kinds)"),
  threshold: z.number().min(0.1).default(1).describe("Score at which an event is considered spam"),
  action: z.enum(["reject", "shadow"]).default("reject").describe("reject = OK false; shadow = pretend success but drop"),
  exemptPubkeys: z.array(z.string()).default([]).describe("Hex pubkeys never scored"),
  exemptAdmins: z.boolean().default(true).describe("Skip pubkeys with an admin role"),

  duplicateWindowSec: z.number().int().min(10).default(900),
  duplicateMaxPubkeys: z.number().int().min(1).default(3).describe("Same content from more than N pubkeys in the window is spam"),
  duplicateMinLength: z.number().int().min(1).default(20).describe("Ignore short messages like 'gm'"),
  duplicateWeight: z.number().default(1),

  repeatMaxPerPubkey: z.number().int().min(1).default(3).describe("Same pubkey posting identical content more than N times in the window"),
  repeatWeight: z.number().default(0.6),

  maxLinks: z.number().int().min(0).default(4),
  maxLinkRatio: z.number().min(0).max(1).default(0.5).describe("Links / words above this is suspicious"),
  linkWeight: z.number().default(0.6),

  maxMentions: z.number().int().min(1).default(25),
  mentionWeight: z.number().default(1),

  newAccountAgeSec: z.number().int().min(0).default(3600).describe("Accounts first seen less than this ago are 'new'"),
  newAccountEventsPerMinute: z.number().int().min(1).default(5),
  newAccountLinkWeight: z.number().default(0.4).describe("Extra score for links posted by new accounts"),
  rateWeight: z.number().default(1),
});
export type SpamSettings = z.infer<typeof Settings>;

export interface SpamVerdict {
  score: number;
  reasons: string[];
}

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const normalize = (s: string) => s.toLowerCase().replace(URL_RE, "<url>").replace(/\s+/g, " ").trim();

/** djb2 – small, fast, good enough for bucketing normalized content */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + ":" + s.length;
}

/** Memory bounds of the scorer: anonymous writers control how many distinct messages and pubkeys it sees. */
export interface SpamLimits {
  /** distinct normalized messages tracked for duplicate detection (pubkeys per message: duplicateMaxPubkeys + 1) */
  maxContentKeys: number;
  /** pubkeys tracked for the new-account rate limit (and the role cache) */
  maxTrackedPubkeys: number;
}
export const DEFAULT_SPAM_LIMITS: SpamLimits = { maxContentKeys: 50_000, maxTrackedPubkeys: 50_000 };

/** Inserts `key` as the most recently used entry and evicts the least recently used ones beyond `max`. */
export function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as K);
}

/** In-memory state of the scorer; exported for tests. */
export class SpamScorer {
  /** content hash → pubkey → last seen (ms) */
  private content = new Map<string, Map<string, { at: number; count: number }>>();
  /** pubkey → timestamps (ms) of recent events */
  private rate = new Map<string, number[]>();
  /** event id → verdict: a re-sent copy of the same signed event (client retry / rebroadcast) isn't a repeat */
  private verdicts = new Map<string, { at: number; verdict: SpamVerdict }>();
  private static readonly MAX_VERDICTS = 50_000;

  private s: () => SpamSettings;
  private now: () => number;
  private limits: SpamLimits;

  constructor(settings: () => SpamSettings, now: () => number = Date.now, limits: Partial<SpamLimits> = {}) {
    this.s = settings;
    this.now = now;
    this.limits = { ...DEFAULT_SPAM_LIMITS, ...limits };
  }

  score(event: NostrEvent, opts: { firstSeenAt?: number } = {}): SpamVerdict {
    const now = this.now();
    const cached = event.id ? this.verdicts.get(event.id) : undefined;
    if (cached && now - cached.at <= this.s().duplicateWindowSec * 1000) return cached.verdict;
    const verdict = this.compute(event, opts, now);
    if (event.id) {
      if (this.verdicts.size >= SpamScorer.MAX_VERDICTS) this.verdicts.delete(this.verdicts.keys().next().value!);
      this.verdicts.set(event.id, { at: now, verdict });
    }
    return verdict;
  }

  private compute(event: NostrEvent, opts: { firstSeenAt?: number }, now: number): SpamVerdict {
    const s = this.s();
    const reasons: string[] = [];
    let score = 0;
    const text = event.content ?? "";

    // links
    const links = text.match(URL_RE)?.length ?? 0;
    const words = text.split(/\s+/).filter(Boolean).length || 1;
    if (links > s.maxLinks) {
      score += s.linkWeight;
      reasons.push(`${links} links`);
    } else if (links >= 2 && links / words > s.maxLinkRatio) {
      score += s.linkWeight;
      reasons.push("mostly links");
    }

    // mentions
    const mentions = event.tags.filter((t) => t[0] === "p").length;
    if (mentions > s.maxMentions) {
      score += s.mentionWeight;
      reasons.push(`${mentions} mentions`);
    }

    // duplicate content across pubkeys / repeated by same pubkey
    const norm = normalize(text);
    if (norm.length >= s.duplicateMinLength) {
      const key = hash(norm);
      const byPubkey = this.content.get(key) ?? new Map<string, { at: number; count: number }>();
      remember(this.content, key, byPubkey, this.limits.maxContentKeys);
      const windowMs = s.duplicateWindowSec * 1000;
      for (const [pk, v] of byPubkey) if (now - v.at > windowMs) byPubkey.delete(pk);
      const mine = byPubkey.get(event.pubkey) ?? { at: now, count: 0 };
      mine.at = now;
      mine.count++;
      // one more pubkey than the duplicate threshold is all the verdict needs: past it the message is flagged for
      // everyone, so an evicted pubkey's repeat count no longer matters (and any threshold keeps working)
      remember(byPubkey, event.pubkey, mine, s.duplicateMaxPubkeys + 1);
      if (byPubkey.size > s.duplicateMaxPubkeys) {
        score += s.duplicateWeight;
        reasons.push(`same content from ${byPubkey.size} pubkeys`);
      }
      if (mine.count > s.repeatMaxPerPubkey) {
        score += s.repeatWeight;
        reasons.push(`repeated ${mine.count}x`);
      }
    }

    // new account limits
    const firstSeenMs = opts.firstSeenAt ? opts.firstSeenAt * 1000 : now;
    const isNew = now - firstSeenMs < s.newAccountAgeSec * 1000;
    const times = (this.rate.get(event.pubkey) ?? []).filter((t) => now - t < 60_000);
    times.push(now);
    remember(this.rate, event.pubkey, times, this.limits.maxTrackedPubkeys);
    if (isNew) {
      if (times.length > s.newAccountEventsPerMinute) {
        score += s.rateWeight;
        reasons.push(`new account posting ${times.length}/min`);
      }
      if (links > 0) {
        score += s.newAccountLinkWeight;
        reasons.push("new account posting links");
      }
    }
    return { score: Math.round(score * 100) / 100, reasons };
  }

  /** drop expired state */
  prune() {
    const now = this.now();
    const windowMs = this.s().duplicateWindowSec * 1000;
    for (const [k, m] of this.content) {
      for (const [pk, v] of m) if (now - v.at > windowMs) m.delete(pk);
      if (!m.size) this.content.delete(k);
    }
    for (const [pk, t] of this.rate) {
      const recent = t.filter((x) => now - x < 60_000);
      if (recent.length) this.rate.set(pk, recent);
      else this.rate.delete(pk);
    }
    for (const [id, v] of this.verdicts) if (now - v.at > windowMs) this.verdicts.delete(id);
  }

  get size() {
    return { contentKeys: this.content.size, trackedPubkeys: this.rate.size };
  }
}

interface Blocked {
  id: string;
  pubkey: string;
  kind: number;
  at: number;
  score: number;
  reasons: string[];
  preview: string;
}

const plugin: BeamhopPlugin<typeof Settings> = {
  name: "spam-filter",
  version: "0.1.0",
  description: "Heuristic spam scoring: duplicate floods, link density, mention floods, new-account rate limits.",
  settings: Settings,

  setup(ctx) {
    const scorer = new SpamScorer(() => ctx.settings.get());
    const recent: Blocked[] = [];
    const totals = { scored: 0, blocked: 0 };
    const blockedCounter = ctx.metrics.counter("spam_filter_blocked_total", "events blocked by the spam filter");
    const roleCache = new Map<string, { at: number; firstSeenAt?: number; admin: boolean }>();

    const userInfo = async (pubkey: string) => {
      const c = roleCache.get(pubkey);
      if (c && Date.now() - c.at < 60_000) return c;
      const u = await ctx.users.get(pubkey);
      const v = { at: Date.now(), firstSeenAt: u?.firstSeenAt || undefined, admin: !!u?.role };
      remember(roleCache, pubkey, v, DEFAULT_SPAM_LIMITS.maxTrackedPubkeys);
      return v;
    };

    ctx.hooks.onWrite(async (event: NostrEvent, wctx: WriteContext) => {
      const s = ctx.settings.get();
      if (wctx.source !== "ws" && wctx.source !== "api") return undefined;
      if (event.kind >= 20000 && event.kind < 30000) return undefined;
      if (s.kinds.length && !s.kinds.includes(event.kind)) return undefined;
      if (s.exemptPubkeys.includes(event.pubkey) || ctx.config.admin.owners.includes(event.pubkey)) return undefined;
      const info = await userInfo(event.pubkey);
      if (s.exemptAdmins && info.admin) return undefined;
      totals.scored++;
      const v = scorer.score(event, { firstSeenAt: info.firstSeenAt });
      if (v.score < s.threshold) return undefined;
      totals.blocked++;
      blockedCounter.add(1, { action: s.action });
      recent.unshift({ id: event.id, pubkey: event.pubkey, kind: event.kind, at: Math.floor(Date.now() / 1000), score: v.score, reasons: v.reasons, preview: event.content.slice(0, 140) });
      if (recent.length > 100) recent.length = 100;
      ctx.logger.debug("spam blocked", { id: event.id, score: v.score, reasons: v.reasons });
      return s.action === "shadow" ? { action: "shadow" } : { action: "reject", reason: `blocked: looks like spam (${v.reasons.join(", ")})` };
    }, 50);

    ctx.jobs.every("prune", 60_000, () => {
      scorer.prune();
      for (const [pk, v] of roleCache) if (Date.now() - v.at > 60_000) roleCache.delete(pk);
    });

    ctx.adminHttp.get("/stats", (c) => c.json({ ...totals, ...scorer.size, recent }));
    ctx.adminHttp.post("/score", async (c) => {
      const event = (await c.req.json().catch(() => null)) as NostrEvent | null;
      const valid =
        !!event && typeof event === "object" && typeof event.content === "string" && typeof event.pubkey === "string" &&
        typeof event.kind === "number" && Array.isArray(event.tags) &&
        event.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === "string"));
      if (!valid) return c.json({ error: "body must be a nostr event {pubkey, kind, tags, content}", code: "validation" }, 400);
      const preview = new SpamScorer(() => ctx.settings.get());
      return c.json(preview.score(event, { firstSeenAt: (await userInfo(event.pubkey)).firstSeenAt }));
    });
  },
};

export default plugin;
