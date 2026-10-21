// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Connection } from './connection.ts';
import type { NostrEvent } from './event.ts';
import type { Filter } from './filter.ts';
import type { ReasonPrefix } from './messages.ts';
import type { RelayId } from './ports.ts';

/**
 * The policy pipeline. Built-in filters, goals-derived limits, access modes,
 * plugins and enterprise checks all register hooks here. Hooks run in
 * ascending `priority`; the first non-accept decision wins.
 */
export type Decision =
  | { action: 'accept' }
  | { action: 'reject'; prefix: ReasonPrefix; message: string }
  /** Accept to the client but do not store/broadcast (shadow ban). */
  | { action: 'shadow'; message?: string }
  /** Hold for moderation review: stored hidden, surfaced in queue. */
  | { action: 'hold'; message?: string };

export const ACCEPT: Decision = Object.freeze({ action: 'accept' });

export function reject(prefix: ReasonPrefix, message: string): Decision {
  return { action: 'reject', prefix, message };
}

export interface PolicyContext {
  relayId: RelayId;
  now: number;
  conn?: Connection;
  /** Which tier the subject resolves to (set by the tiers stage). */
  tier?: string;
  /** Observe-only evaluation (sandbox / dry-run): hooks must not mutate state. */
  dryRun?: boolean;
}

export interface UploadInfo {
  sha256: string;
  size: number;
  type: string;
  pubkey: string;
}

export interface PolicyHooks {
  /** Unique id, e.g. `builtin.rate-limit`, `plugin.wot-filter`, `enterprise.binding`. */
  id: string;
  /** Lower runs first. Bands: 0-99 access, 100-199 limits, 200-299 content, 300+ plugins. */
  priority: number;
  onConnect?(ctx: PolicyContext): Decision | Promise<Decision>;
  onAuth?(pubkey: string, ctx: PolicyContext): Decision | Promise<Decision>;
  onEvent?(event: NostrEvent, ctx: PolicyContext): Decision | Promise<Decision>;
  onReq?(filters: Filter[], ctx: PolicyContext): Decision | Promise<Decision>;
  onUpload?(info: UploadInfo, ctx: PolicyContext): Decision | Promise<Decision>;
  onBlobServe?(sha256: string, ctx: PolicyContext): Decision | Promise<Decision>;
}

export type HookName = Exclude<keyof PolicyHooks, 'id' | 'priority'>;

export class PolicyPipeline {
  private hooks: PolicyHooks[] = [];

  add(h: PolicyHooks): () => void {
    this.hooks = [...this.hooks.filter((x) => x.id !== h.id), h].sort(
      (a, b) => a.priority - b.priority,
    );
    return () => this.remove(h.id);
  }

  remove(id: string): void {
    this.hooks = this.hooks.filter((h) => h.id !== id);
  }

  list(): readonly PolicyHooks[] {
    return this.hooks;
  }

  async run<K extends HookName>(
    name: K,
    args: Parameters<NonNullable<PolicyHooks[K]>>,
  ): Promise<Decision & { by?: string }> {
    for (const h of this.hooks) {
      const fn = h[name] as ((...a: unknown[]) => Decision | Promise<Decision>) | undefined;
      if (!fn) continue;
      const d = await fn.apply(h, args as unknown[]);
      if (d.action !== 'accept') return { ...d, by: h.id };
    }
    return ACCEPT;
  }
}
