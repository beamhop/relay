// SPDX-License-Identifier: AGPL-3.0-or-later
/** One-time undo tokens for actions, bulk runs and config commits. */
import type { Ports, RelayId } from '@beamhop/core';
import { COL } from './settings.ts';

export interface UndoEntry {
  kind: 'action' | 'bulk' | 'config';
  principalId: string;
  relayId: RelayId | null;
  expiresAt: number;
  summary: string;
  actionId?: string;
  payload?: unknown;
  /** Config revision to undo. */
  revision?: number;
  /** Bulk: child undo tokens. */
  children?: string[];
}

export class UndoStore {
  constructor(private readonly ports: Ports) {}

  async create(entry: UndoEntry): Promise<string> {
    const token = this.ports.crypto.randomHex(16);
    await this.ports.docs.put(COL.undo, token, entry);
    return token;
  }

  async peek(token: string): Promise<UndoEntry | null> {
    if (!/^[0-9a-f]{32}$/.test(token)) return null;
    const e = await this.ports.docs.get<UndoEntry>(COL.undo, token);
    if (!e || e.expiresAt < this.ports.clock.now()) return null;
    return e;
  }

  /** Consume a token (exactly once). */
  async take(token: string): Promise<UndoEntry | null> {
    const e = await this.peek(token);
    if (!e) return null;
    return (await this.ports.docs.delete(COL.undo, token)) ? e : null;
  }

  async gc(): Promise<void> {
    const now = this.ports.clock.now();
    const page = await this.ports.docs.list<UndoEntry>(COL.undo, { limit: 1000 });
    for (const i of page.items)
      if (i.value.expiresAt < now) await this.ports.docs.delete(COL.undo, i.key);
  }
}
