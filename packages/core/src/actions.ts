// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Action registry (§6.13): the single definition of every admin operation.
 * The admin API routes, CLI commands, command palette entries, AI assistant
 * tools and NIP-86 methods are all GENERATED from this registry.
 *
 * Every state-changing action returns a plain-language diff preview first
 * (`preview`) and is undoable when `undo` is provided (§6.3).
 */
import type { z } from 'zod';
import type { Permission, Principal } from './auth.ts';
import type { Ports, RelayId } from './ports.ts';

export type ActionScope = 'node' | 'relay';

export interface DiffLine {
  /** Plain language, e.g. "New users must solve a harder puzzle (20 → 24)". */
  text: string;
  /** Technical lens, e.g. "limits.newKeyPowDifficulty: 20 → 24 (NIP-13)". */
  technical?: string;
  kind: 'add' | 'remove' | 'change' | 'info' | 'warning';
}

export interface ActionContext {
  principal: Principal;
  relayId: RelayId | null;
  ports: Ports;
  /** Request-scoped audit reason (from UI / CLI flag). */
  reason?: string;
  dryRun?: boolean;
}

export interface UndoToken {
  actionId: string;
  /** Opaque JSON payload the undo handler receives. */
  payload: unknown;
  expiresAt: number;
}

export interface ActionResult<O = unknown> {
  output: O;
  undo?: UndoToken;
  summary: string;
}

export interface ActionDef<I extends z.ZodTypeAny = z.ZodTypeAny, O = unknown> {
  /** Dotted id, e.g. `moderation.ban-pubkey`. Used as CLI command `beamhop moderation ban-pubkey`. */
  id: string;
  /** Plain-language title for UI/palette. */
  title: string;
  description: string;
  /** Technical lens text (NIPs, kinds). */
  technical?: string;
  scope: ActionScope;
  permission: Permission;
  input: I;
  /** Read-only actions skip preview/approval/undo. */
  readOnly?: boolean;
  /** Requires two-person approval when the approvals module is enabled (§12.9). */
  sensitive?: boolean;
  /** Supports multi-select bulk invocation. */
  bulk?: boolean;
  /** Palette keywords. */
  keywords?: string[];
  /** Keyboard shortcut hint for list contexts, e.g. "#". */
  shortcut?: string;
  preview?(input: z.infer<I>, ctx: ActionContext): Promise<DiffLine[]>;
  run(input: z.infer<I>, ctx: ActionContext): Promise<ActionResult<O>>;
  undo?(payload: unknown, ctx: ActionContext): Promise<void>;
}

export class ActionRegistry {
  private readonly defs = new Map<string, ActionDef>();

  register<I extends z.ZodTypeAny, O>(def: ActionDef<I, O>): void {
    if (this.defs.has(def.id)) throw new Error(`duplicate action id: ${def.id}`);
    this.defs.set(def.id, def as unknown as ActionDef);
  }

  unregister(id: string): void {
    this.defs.delete(id);
  }

  get(id: string): ActionDef | undefined {
    return this.defs.get(id);
  }

  list(): ActionDef[] {
    return [...this.defs.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

export function defineAction<I extends z.ZodTypeAny, O>(def: ActionDef<I, O>): ActionDef<I, O> {
  return def;
}
