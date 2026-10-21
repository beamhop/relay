// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Moderation pre-labels (§5.3, §6.5.3): a background job asks the LLM for a
 * label (spam / abuse / ok) and a one-line reason for each new pending queue
 * item, with strict JSON output. Labels live in `ai.labels` next to the queue
 * items and are only hints on the swipe cards — nothing is ever acted on.
 */
import type { Kernel, RelayId } from '@beamhop/core';
import { z } from 'zod';
import { type AiModuleConfig, COL } from './config.ts';
import type { AiLLM } from './llm.ts';
import {
  UNTRUSTED_RULES,
  promptJson,
  scrubText,
  truncate,
  untrusted,
  withTimeout,
} from './safety.ts';

export type ModerationLabel = 'spam' | 'abuse' | 'ok';

export interface LabelRecord {
  relayId: RelayId;
  itemId: string;
  status: 'labeled' | 'failed';
  label?: ModerationLabel;
  /** One plain line. */
  reason?: string;
  model?: string;
  at: number;
  attempts: number;
  error?: string;
}

/** Loose view of the policy module's queue (`kernel.use('policy').queue`). */
export interface QueueItemLike {
  id: string;
  relayId: RelayId;
  type: 'event' | 'report' | 'blob';
  status: string;
  reason: string;
  source?: string;
  pubkey?: string;
  sha256?: string;
  event?: { kind: number; content: string; tags: string[][]; created_at: number };
  reports?: Array<{ type: string; comment?: string }>;
}

export interface PolicyLike {
  queue: { list(relayId: RelayId, opts?: { status?: 'pending' }): Promise<QueueItemLike[]> };
}

const SYNONYMS: Record<string, ModerationLabel> = {
  spam: 'spam',
  scam: 'spam',
  junk: 'spam',
  abuse: 'abuse',
  abusive: 'abuse',
  harassment: 'abuse',
  hate: 'abuse',
  illegal: 'abuse',
  ok: 'ok',
  fine: 'ok',
  safe: 'ok',
  clean: 'ok',
  benign: 'ok',
};

const LabelJson = z.object({
  label: z.string().transform((s, ctx) => {
    const v = SYNONYMS[s.trim().toLowerCase()];
    if (!v) {
      ctx.addIssue({ code: 'custom', message: `unknown label ${s}` });
      return z.NEVER;
    }
    return v;
  }),
  reason: z.string().min(1),
});

/**
 * Strict parse of the model output: exactly one JSON object (code fences
 * tolerated) with a known label and a non-empty reason. Returns null on any
 * deviation — the caller retries later or gives up.
 */
export function parseLabel(text: string): { label: ModerationLabel; reason: string } | null {
  if (!text) return null;
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
  const r = LabelJson.safeParse(obj);
  if (!r.success) return null;
  const line = scrubText(r.data.reason).replace(/\s+/g, ' ').trim();
  const reason = line.length > 140 ? `${line.slice(0, 139).trimEnd()}…` : line;
  if (!reason) return null;
  return { label: r.data.label, reason };
}

const SYSTEM = [
  "You pre-label items in a Nostr relay's moderation queue for a human moderator.",
  'Reply with ONLY one JSON object and nothing else:',
  '{"label":"spam"|"abuse"|"ok","reason":"<one short plain-language sentence>"}',
  'spam = ads, scams, repeated junk, link farms, bulk posting.',
  'abuse = harassment, hate, threats, doxxing, sexual content involving minors, clearly illegal content.',
  'ok = everything else (including heated but legitimate opinions).',
  'Your label is only a hint: nothing is removed automatically.',
  UNTRUSTED_RULES,
].join('\n');

export function labelPrompt(item: QueueItemLike, maxChars = 3000): string {
  const facts: Record<string, unknown> = {
    type: item.type,
    whyInQueue: item.reason,
  };
  if (item.reports?.length)
    facts.reports = item.reports.slice(0, 10).map((r) => ({ type: r.type, comment: r.comment }));
  const data: Record<string, unknown> = {};
  if (item.event)
    Object.assign(data, {
      kind: item.event.kind,
      content: truncate(item.event.content ?? '', 2000),
      tags: (item.event.tags ?? []).slice(0, 20),
    });
  if (item.sha256) data.mediaFile = item.sha256;
  return [
    `Queue item facts: ${JSON.stringify(facts)}`,
    'The item itself (untrusted):',
    untrusted('queue-item', promptJson(data, maxChars)),
    'Answer with the JSON object only.',
  ].join('\n');
}

const key = (relayId: RelayId, itemId: string) => `${relayId}:${itemId}`;

export class ModerationLabeler {
  private window = { start: 0, count: 0 };
  private running = false;

  constructor(
    private readonly kernel: Kernel,
    private readonly llm: () => AiLLM | undefined,
    private readonly settings: () => AiModuleConfig,
  ) {}

  async get(relayId: RelayId, itemId: string): Promise<LabelRecord | null> {
    return this.kernel.ports.docs.get<LabelRecord>(COL.labels, key(relayId, itemId));
  }

  async list(relayId: RelayId, itemIds?: string[]): Promise<LabelRecord[]> {
    if (itemIds) {
      const got = await Promise.all(itemIds.map((id) => this.get(relayId, id)));
      return got.filter((x): x is LabelRecord => !!x);
    }
    const out: LabelRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.kernel.ports.docs.list<LabelRecord>(COL.labels, {
        prefix: `${relayId}:`,
        cursor,
        limit: 500,
      });
      for (const it of page.items) out.push(it.value);
      cursor = page.cursor;
    } while (cursor);
    return out;
  }

  private allowance(): number {
    const s = this.settings().labeling;
    const now = this.kernel.ports.clock.now();
    if (now - this.window.start >= 3600) this.window = { start: now, count: 0 };
    return Math.max(0, Math.min(s.perRun, s.perHour - this.window.count));
  }

  /** One labeling pass across all relays (rate-limited). Never acts on items. */
  async runOnce(): Promise<{ labeled: number; failed: number; skipped: number }> {
    const stats = { labeled: 0, failed: 0, skipped: 0 };
    const s = this.settings();
    const llm = this.llm();
    const policy = this.kernel.use<PolicyLike>('policy');
    if (!this.kernel.config().ai.enabled || !s.labeling.enabled || !llm || !policy?.queue)
      return stats;
    if (this.running) return stats;
    this.running = true;
    try {
      let budget = this.allowance();
      for (const relay of this.kernel.config().relays) {
        if (budget <= 0) break;
        let items: QueueItemLike[];
        try {
          items = await policy.queue.list(relay.id, { status: 'pending' });
        } catch {
          continue;
        }
        for (const item of items) {
          if (budget <= 0) break;
          const prev = await this.get(relay.id, item.id);
          if (prev && (prev.status === 'labeled' || prev.attempts >= s.labeling.maxAttempts)) {
            stats.skipped++;
            continue;
          }
          budget--;
          this.window.count++;
          const rec = await this.labelOne(llm, item, prev?.attempts ?? 0);
          if (rec.status === 'labeled') stats.labeled++;
          else stats.failed++;
        }
      }
    } finally {
      this.running = false;
    }
    return stats;
  }

  private async labelOne(llm: AiLLM, item: QueueItemLike, attempts: number): Promise<LabelRecord> {
    const s = this.settings();
    const base = {
      relayId: item.relayId,
      itemId: item.id,
      at: this.kernel.ports.clock.now(),
      attempts: attempts + 1,
    };
    if (llm.model) Object.assign(base, { model: llm.model });
    let rec: LabelRecord;
    try {
      const controller = new AbortController();
      const reply = await withTimeout(
        llm.chat(
          [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: labelPrompt(item) },
          ],
          { signal: controller.signal, maxOutputTokens: 120, temperature: 0 },
        ),
        Math.min(s.timeoutSeconds, 30) * 1000,
        () => controller.abort(),
      );
      const parsed = parseLabel(reply.content);
      rec = parsed
        ? { ...base, status: 'labeled', label: parsed.label, reason: parsed.reason }
        : { ...base, status: 'failed', error: 'The model did not answer in the expected format' };
    } catch (err) {
      rec = { ...base, status: 'failed', error: truncate(scrubText(String(err)), 200) };
    }
    await this.kernel.ports.docs.put(COL.labels, key(item.relayId, item.id), rec);
    return rec;
  }
}
