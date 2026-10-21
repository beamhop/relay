// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Approval workflows — the two-person rule (§12.9).
 *
 * - `kernel.use<ApprovalsService>('enterprise.approvals')` for modules that gate their own
 *   operations (e.g. keyvault escrow decrypt calls `request` / `isApproved` / `consume`).
 * - Gated actions in the ActionRegistry are wrapped at start (core has no action
 *   interception hook): running a gated action without `_approvalId` files a request and
 *   returns `{ status: 'approval-required', requestId }`; running it again with
 *   `_approvalId` of an approved request executes it once. Rules: approver ≠ requester,
 *   approver needs the action's permission, approvals are interactive (no API tokens),
 *   the input must be identical, requests and approvals expire, approvals are single-use.
 */
import {
  type ActionContext,
  type ActionDef,
  type ActionRegistry,
  type AttentionCard,
  type CardSource,
  type DiffLine,
  type Principal,
  type RelayId,
  can,
  defineAction,
} from '@beamhop/core';
import { z } from 'zod';
import { COL } from './config.ts';
import type { Rt } from './runtime.ts';
import { canonicalJson, redact, sha256Hex } from './util.ts';

export const APPROVALS_SERVICE = 'enterprise.approvals';
export const APPROVAL_FIELD = '_approvalId';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'used';

export interface ApprovalRequest {
  id: string;
  actionId: string;
  actionTitle: string;
  relayId: RelayId | null;
  /** Redacted copy for display. */
  input: unknown;
  /** sha256 of the canonical (un-redacted) input; execution must match it. */
  inputHash: string;
  reason?: string;
  requestedBy: string;
  requestedByName?: string;
  requestedByPubkey?: string;
  createdAt: number;
  /** Pending requests expire at this time. */
  expiresAt: number;
  status: ApprovalStatus;
  decidedBy?: string;
  decidedByName?: string;
  decidedAt?: number;
  note?: string;
  /** Approved requests must be used before this time. */
  approvalExpiresAt?: number;
  usedAt?: number;
  usedBy?: string;
}

export class ApprovalError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'expired'
      | 'not_pending'
      | 'self_approval'
      | 'forbidden'
      | 'not_approved'
      | 'mismatch'
      | 'used'
      | 'interactive_only',
    message: string,
  ) {
    super(message);
    this.name = 'ApprovalError';
  }
}

export interface ApprovalsService {
  /** File a request; returns its id. Notifies the other admins. */
  request(
    actionId: string,
    input: unknown,
    principal: Principal,
    reason?: string,
    relayId?: RelayId | null,
  ): Promise<string>;
  approve(requestId: string, principal: Principal, note?: string): Promise<ApprovalRequest>;
  deny(requestId: string, principal: Principal, note?: string): Promise<ApprovalRequest>;
  status(requestId: string): Promise<ApprovalRequest | null>;
  /** Approved, not expired, not used, and (when given) matching action/input/relay. */
  isApproved(
    requestId: string,
    match?: { actionId?: string; input?: unknown; relayId?: RelayId | null },
  ): Promise<boolean>;
  /** Mark an approved request used (single-use). Throws ApprovalError when not allowed. */
  consume(
    requestId: string,
    match: { actionId: string; input: unknown; principal: Principal; relayId?: RelayId | null },
  ): Promise<ApprovalRequest>;
  list(opts?: { status?: ApprovalStatus; limit?: number }): Promise<ApprovalRequest[]>;
  /** Whether the action id is currently gated by configuration. */
  isGated(actionId: string): boolean;
  /**
   * One-call gate used by enterprise-keyvault (escrow decrypt, key destroy…):
   * without `approvalId` files a request (→ pending); with an approved, matching id
   * consumes it (single-use) and answers `approved`.
   */
  check(req: ApprovalCheckRequest): Promise<ApprovalCheckResult>;
}

export interface ApprovalCheckRequest {
  actionId: string;
  input: unknown;
  principalId: string;
  reason?: string;
  approvalId?: string;
  relayId?: RelayId | null;
}

export interface ApprovalCheckResult {
  status: 'approved' | 'pending' | 'denied' | 'expired';
  requestId?: string;
  approvers?: string[];
  /** Plain-language reason when not approved. */
  message?: string;
}

/** Identities of a principal (an admin may appear by record id or pubkey). */
function actorKeys(p: Principal): Set<string> {
  const s = new Set<string>([p.id]);
  if (p.pubkey) s.add(p.pubkey);
  return s;
}

function sameActor(req: ApprovalRequest, p: Principal): boolean {
  const keys = actorKeys(p);
  return keys.has(req.requestedBy) || (!!req.requestedByPubkey && keys.has(req.requestedByPubkey));
}

export async function inputHash(input: unknown): Promise<string> {
  return sha256Hex(canonicalJson(input ?? null));
}

export function stripApproval(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v) && APPROVAL_FIELD in v) {
    const { [APPROVAL_FIELD]: _drop, ...rest } = v as Record<string, unknown>;
    return rest;
  }
  return v;
}

export class Approvals implements ApprovalsService {
  constructor(private readonly rt: Rt) {}

  private cfg() {
    return this.rt.settings().approvals;
  }

  isGated(actionId: string): boolean {
    const c = this.cfg();
    if (!c.enabled || actionId.startsWith('approvals.')) return false;
    if (c.gatedActions.includes(actionId)) return true;
    const def = this.rt.kernel.actions.get(actionId);
    return !!(c.gateAllSensitive && def?.sensitive && !def.readOnly);
  }

  private async load(id: string): Promise<ApprovalRequest | null> {
    const r = await this.rt.ports.docs.get<ApprovalRequest>(COL.approvals, id);
    if (!r) return null;
    const now = this.rt.now();
    let next: ApprovalRequest | null = null;
    if (r.status === 'pending' && now >= r.expiresAt) next = { ...r, status: 'expired' };
    if (r.status === 'approved' && r.approvalExpiresAt !== undefined && now >= r.approvalExpiresAt)
      next = { ...r, status: 'expired' };
    if (next) {
      await this.rt.ports.docs.cas(COL.approvals, id, r, next);
      return next;
    }
    return r;
  }

  private async transition(
    id: string,
    fn: (r: ApprovalRequest) => ApprovalRequest,
  ): Promise<ApprovalRequest> {
    for (let i = 0; i < 10; i++) {
      const cur = await this.load(id);
      if (!cur) throw new ApprovalError('not_found', 'That approval request does not exist');
      const next = fn(cur);
      if (await this.rt.ports.docs.cas(COL.approvals, id, cur, next)) return next;
    }
    throw new ApprovalError('not_pending', 'The request changed at the same time; try again');
  }

  async request(
    actionId: string,
    input: unknown,
    principal: Principal,
    reason?: string,
    relayId: RelayId | null = null,
  ): Promise<string> {
    const def = this.rt.kernel.actions.get(actionId);
    const now = this.rt.now();
    const id = `apr_${this.rt.ports.crypto.randomHex(12)}`;
    const req: ApprovalRequest = {
      id,
      actionId,
      actionTitle: def?.title ?? actionId,
      relayId,
      input: redact(input) ?? null,
      inputHash: await inputHash(input),
      requestedBy: principal.id,
      createdAt: now,
      expiresAt: now + this.cfg().requestTtlMinutes * 60,
      status: 'pending',
    };
    if (reason) req.reason = reason;
    if (principal.displayName) req.requestedByName = principal.displayName;
    if (principal.pubkey) req.requestedByPubkey = principal.pubkey;
    await this.rt.ports.docs.put(COL.approvals, id, req);
    const who = principal.displayName ?? 'An admin';
    const what = lowerFirst(req.actionTitle);
    await this.rt.kernel
      .notify({
        severity: 'warning',
        title: 'Approval needed',
        body: `${who} wants to ${what}${reason ? ` — “${reason}”` : ''}. Another admin must approve.`,
        url: `/approvals/${id}`,
        ...(relayId ? { relayId } : {}),
        // Admin-only: approvals are never mirrored to public status pages.
        category: 'safety',
      })
      .catch((err) => this.rt.log('warn', 'approval notification failed', { err: String(err) }));
    this.rt.record({
      stream: 'compliance',
      type: 'approval.requested',
      relayId,
      principalId: principal.id,
      summary: `Approval requested to ${what}`,
      data: { requestId: id, actionId, reason: reason ?? null },
    });
    return id;
  }

  private checkApprover(r: ApprovalRequest, p: Principal): void {
    if (p.via === 'token')
      throw new ApprovalError(
        'interactive_only',
        'Approvals must be given by a signed-in admin, not an API token',
      );
    if (sameActor(r, p))
      throw new ApprovalError('self_approval', 'You cannot approve your own request');
    const def = this.rt.kernel.actions.get(r.actionId);
    if (def && !can(p, def.permission, r.relayId))
      throw new ApprovalError(
        'forbidden',
        `You don't have permission to approve “${r.actionTitle}”`,
      );
  }

  async approve(requestId: string, principal: Principal, note?: string): Promise<ApprovalRequest> {
    const now = this.rt.now();
    const r = await this.transition(requestId, (cur) => {
      if (cur.status === 'expired') throw new ApprovalError('expired', 'This request has expired');
      if (cur.status !== 'pending')
        throw new ApprovalError('not_pending', `This request is already ${cur.status}`);
      this.checkApprover(cur, principal);
      const next: ApprovalRequest = {
        ...cur,
        status: 'approved',
        decidedBy: principal.id,
        decidedAt: now,
        approvalExpiresAt: now + this.cfg().executeWithinMinutes * 60,
      };
      if (principal.displayName) next.decidedByName = principal.displayName;
      if (note) next.note = note;
      return next;
    });
    this.rt.record({
      stream: 'compliance',
      type: 'approval.approved',
      relayId: r.relayId,
      principalId: principal.id,
      summary: `Approved: ${lowerFirst(r.actionTitle)}`,
      data: { requestId, actionId: r.actionId, requestedBy: r.requestedBy },
    });
    return r;
  }

  async deny(requestId: string, principal: Principal, note?: string): Promise<ApprovalRequest> {
    const now = this.rt.now();
    const r = await this.transition(requestId, (cur) => {
      if (cur.status !== 'pending')
        throw new ApprovalError('not_pending', `This request is already ${cur.status}`);
      // The requester may withdraw their own request; anyone else needs the permission.
      if (!sameActor(cur, principal)) this.checkApprover(cur, principal);
      const next: ApprovalRequest = {
        ...cur,
        status: 'denied',
        decidedBy: principal.id,
        decidedAt: now,
      };
      if (principal.displayName) next.decidedByName = principal.displayName;
      if (note) next.note = note;
      return next;
    });
    this.rt.record({
      stream: 'compliance',
      type: 'approval.denied',
      relayId: r.relayId,
      principalId: principal.id,
      summary: `Denied: ${lowerFirst(r.actionTitle)}`,
      data: { requestId, actionId: r.actionId },
    });
    return r;
  }

  status(requestId: string): Promise<ApprovalRequest | null> {
    return this.load(requestId);
  }

  async isApproved(
    requestId: string,
    match: { actionId?: string; input?: unknown; relayId?: RelayId | null } = {},
  ): Promise<boolean> {
    const r = await this.load(requestId);
    if (!r || r.status !== 'approved') return false;
    if (match.actionId !== undefined && match.actionId !== r.actionId) return false;
    if (match.relayId !== undefined && match.relayId !== r.relayId) return false;
    if (match.input !== undefined && (await inputHash(match.input)) !== r.inputHash) return false;
    return true;
  }

  async consume(
    requestId: string,
    match: { actionId: string; input: unknown; principal: Principal; relayId?: RelayId | null },
  ): Promise<ApprovalRequest> {
    const hash = await inputHash(match.input);
    const now = this.rt.now();
    const r = await this.transition(requestId, (cur) => {
      if (cur.status === 'used') throw new ApprovalError('used', 'This approval was already used');
      if (cur.status === 'expired') throw new ApprovalError('expired', 'This approval has expired');
      if (cur.status !== 'approved')
        throw new ApprovalError('not_approved', 'This request has not been approved yet');
      if (cur.actionId !== match.actionId || hash !== cur.inputHash)
        throw new ApprovalError('mismatch', 'The approval was given for a different change');
      if (match.relayId !== undefined && match.relayId !== cur.relayId)
        throw new ApprovalError('mismatch', 'The approval was given for a different relay');
      if (!sameActor(cur, match.principal))
        throw new ApprovalError('forbidden', 'Only the admin who asked can carry out the approval');
      return { ...cur, status: 'used', usedAt: now, usedBy: match.principal.id };
    });
    this.rt.record({
      stream: 'compliance',
      type: 'approval.used',
      relayId: r.relayId,
      principalId: match.principal.id,
      summary: `Carried out after approval: ${lowerFirst(r.actionTitle)}`,
      data: { requestId, actionId: r.actionId, approvedBy: r.decidedBy ?? null },
    });
    return r;
  }

  async check(req: ApprovalCheckRequest): Promise<ApprovalCheckResult> {
    const principal: Principal = { id: req.principalId, roles: {}, via: 'cli' };
    if (!req.approvalId) {
      const requestId = await this.request(
        req.actionId,
        req.input,
        principal,
        req.reason,
        req.relayId ?? null,
      );
      return { status: 'pending', requestId };
    }
    const cur = await this.load(req.approvalId);
    if (!cur) return { status: 'denied', message: 'That approval request does not exist' };
    const requestId = cur.id;
    if (cur.status === 'pending') return { status: 'pending', requestId };
    if (cur.status === 'denied') return { status: 'denied', requestId };
    if (cur.status === 'expired' || cur.status === 'used')
      return { status: 'expired', requestId, message: `This approval is ${cur.status}` };
    try {
      const used = await this.consume(req.approvalId, {
        actionId: req.actionId,
        input: req.input,
        principal,
        ...(req.relayId !== undefined ? { relayId: req.relayId } : {}),
      });
      return { status: 'approved', requestId, approvers: used.decidedBy ? [used.decidedBy] : [] };
    } catch (err) {
      const code = err instanceof ApprovalError ? err.code : 'not_approved';
      return {
        status: code === 'expired' || code === 'used' ? 'expired' : 'denied',
        requestId,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async list(opts: { status?: ApprovalStatus; limit?: number } = {}): Promise<ApprovalRequest[]> {
    const out: ApprovalRequest[] = [];
    let cursor: string | undefined;
    const limit = Math.min(opts.limit ?? 100, 500);
    do {
      const page = await this.rt.ports.docs.list<ApprovalRequest>(COL.approvals, {
        cursor,
        limit: 200,
      });
      for (const { key } of page.items) {
        const r = await this.load(key);
        if (r && (!opts.status || r.status === opts.status)) out.push(r);
      }
      cursor = page.cursor;
    } while (cursor);
    return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  /** Delete decided requests older than 90 days. */
  async gc(): Promise<number> {
    const cutoff = this.rt.now() - 90 * 86400;
    let n = 0;
    for (const r of await this.list({ limit: 500 })) {
      if (r.status !== 'pending' && r.createdAt < cutoff) {
        if (await this.rt.ports.docs.delete(COL.approvals, r.id)) n++;
      }
    }
    return n;
  }
}

function lowerFirst(s: string): string {
  return s ? s[0]!.toLowerCase() + s.slice(1) : s;
}

// ───────────────────────────── Gate (action wrapping) ─────────────────────────────

const approvalField = z.object({
  [APPROVAL_FIELD]: z
    .string()
    .max(64)
    .optional()
    .describe('Approval request id (needed for actions that require a second admin)'),
});

/** Original schema (minus `_approvalId`) ∩ `{ _approvalId? }`; JSON Schema stays flat. */
export function withApprovalField(schema: z.ZodType): z.ZodType {
  return z.intersection(z.preprocess(stripApproval, schema), approvalField);
}

export interface ApprovalGate {
  /** Re-evaluate which actions are gated (after config changes). */
  refresh(): void;
  /** Restore every original ActionDef. */
  uninstall(): void;
  wrapped(): string[];
}

/**
 * Wrap gated actions in the registry. Also patches `registry.register` on this
 * kernel instance so actions registered later are gated too.
 */
export function installApprovalGate(
  registry: ActionRegistry,
  svc: Approvals,
  rt: Rt,
): ApprovalGate {
  const originals = new Map<string, ActionDef>();
  const rawRegister = registry.register.bind(registry);

  const gatedDef = (def: ActionDef): ActionDef => ({
    ...def,
    input: withApprovalField(def.input),
    async preview(input: unknown, ctx: ActionContext): Promise<DiffLine[]> {
      const clean = stripApproval(input);
      const lines = def.preview ? await def.preview(clean, ctx) : [];
      const id = (input as Record<string, unknown> | null)?.[APPROVAL_FIELD];
      const ok =
        typeof id === 'string' &&
        (await svc.isApproved(id, { actionId: def.id, input: clean, relayId: ctx.relayId }));
      return [
        ...lines,
        ok
          ? { kind: 'info', text: 'A second admin approved this change' }
          : {
              kind: 'warning',
              text: 'Another admin must approve this before it happens',
              technical: `two-person rule (§12.9): run again with ${APPROVAL_FIELD} once approved`,
            },
      ];
    },
    async run(input: unknown, ctx: ActionContext) {
      const clean = stripApproval(input);
      if (!svc.isGated(def.id)) return def.run(clean, ctx);
      const id = (input as Record<string, unknown> | null)?.[APPROVAL_FIELD];
      if (typeof id !== 'string' || !id) {
        const requestId = await svc.request(def.id, clean, ctx.principal, ctx.reason, ctx.relayId);
        const req = await svc.status(requestId);
        return {
          output: {
            status: 'approval-required',
            requestId,
            expiresAt: req?.expiresAt ?? null,
          },
          summary: `Asked another admin to approve: ${lowerFirst(def.title)}`,
        };
      }
      await svc.consume(id, {
        actionId: def.id,
        input: clean,
        principal: ctx.principal,
        relayId: ctx.relayId,
      });
      return def.run(clean, ctx);
    },
  });

  const wrap = (def: ActionDef) => {
    if (originals.has(def.id)) return;
    originals.set(def.id, def);
    registry.unregister(def.id);
    rawRegister(gatedDef(def));
  };
  const unwrap = (id: string) => {
    const orig = originals.get(id);
    if (!orig) return;
    originals.delete(id);
    registry.unregister(id);
    rawRegister(orig);
  };

  const refresh = () => {
    for (const def of registry.list()) {
      const isWrapped = originals.has(def.id);
      if (def.readOnly) continue;
      const gated = svc.isGated(def.id);
      if (gated && !isWrapped) wrap(def);
      else if (!gated && isWrapped) unwrap(def.id);
    }
  };

  registry.register = ((def: ActionDef) => {
    rawRegister(def);
    try {
      if (!def.readOnly && svc.isGated(def.id)) wrap(def);
    } catch (err) {
      rt.log('error', 'could not gate action', { actionId: def.id, err: String(err) });
    }
  }) as ActionRegistry['register'];

  refresh();
  return {
    refresh,
    uninstall() {
      for (const id of [...originals.keys()]) unwrap(id);
      registry.register = rawRegister;
    },
    wrapped: () => [...originals.keys()].sort(),
  };
}

// ───────────────────────────── Actions & cards ─────────────────────────────

function needPrincipalCanSee(r: ApprovalRequest, p: Principal, rt: Rt): boolean {
  const def = rt.kernel.actions.get(r.actionId);
  return sameActor(r, p) || !def || can(p, def.permission, r.relayId);
}

export function approvalActions(svc: Approvals, rt: Rt): ActionDef[] {
  const RequestId = z.object({
    requestId: z.string().min(1).max(64).describe('Approval request id'),
    note: z.string().max(500).optional().describe('Optional note for the requester'),
  });
  return [
    defineAction({
      id: 'approvals.list',
      title: 'Show approval requests',
      description: 'Risky changes waiting for (or decided by) a second admin.',
      technical: 'Two-person rule (§12.9); requests live in compliance.approvals.',
      scope: 'node',
      permission: 'relay.read',
      readOnly: true,
      keywords: ['approve', 'pending', 'two-person', 'four eyes'],
      input: z.object({
        status: z.enum(['pending', 'approved', 'denied', 'expired', 'used']).optional(),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      async run(input, ctx) {
        const all = await svc.list({
          limit: input.limit,
          ...(input.status ? { status: input.status } : {}),
        });
        const visible = all.filter((r) => needPrincipalCanSee(r, ctx.principal, rt));
        return {
          output: {
            requests: visible.map((r) => ({
              ...r,
              mine: sameActor(r, ctx.principal),
              canApprove:
                r.status === 'pending' &&
                !sameActor(r, ctx.principal) &&
                ctx.principal.via !== 'token',
            })),
          },
          summary: `Listed ${visible.length} approval request${visible.length === 1 ? '' : 's'}`,
        };
      },
    }),
    defineAction({
      id: 'approvals.approve',
      title: 'Approve a request',
      description: 'Let another admin go ahead with a risky change. You cannot approve your own.',
      technical:
        'Two-person rule: approver ≠ requester, approver needs the gated action’s permission; single-use, expires.',
      scope: 'node',
      permission: 'relay.read',
      keywords: ['approve', 'allow', 'accept'],
      input: RequestId,
      async preview(input) {
        const r = await svc.status(input.requestId);
        if (!r) return [{ kind: 'warning', text: 'That request does not exist' }];
        return [
          {
            kind: 'change',
            text: `${r.requestedByName ?? 'An admin'} will be allowed to ${lowerFirst(r.actionTitle)}`,
            technical: `${r.actionId} input sha256 ${r.inputHash.slice(0, 16)}…`,
          },
        ];
      },
      async run(input, ctx) {
        const r = await svc.approve(input.requestId, ctx.principal, input.note);
        return {
          output: { request: r },
          summary: `Approved: ${lowerFirst(r.actionTitle)}`,
        };
      },
    }),
    defineAction({
      id: 'approvals.deny',
      title: 'Deny a request',
      description: 'Stop a risky change another admin asked for (or withdraw your own).',
      technical: 'Marks the request denied; it can no longer be used.',
      scope: 'node',
      permission: 'relay.read',
      keywords: ['deny', 'reject', 'decline'],
      input: RequestId,
      async run(input, ctx) {
        const r = await svc.deny(input.requestId, ctx.principal, input.note);
        return { output: { request: r }, summary: `Denied: ${lowerFirst(r.actionTitle)}` };
      },
    }),
  ] as unknown[] as ActionDef[];
}

/** Pending requests as swipeable attention cards (approve = primary, deny = secondary). */
export function approvalCards(svc: Approvals): CardSource {
  return {
    id: 'enterprise-compliance.approvals',
    async cards(relayId): Promise<AttentionCard[]> {
      const pending = await svc.list({ status: 'pending', limit: 50 });
      return pending
        .filter((r) => relayId === null || r.relayId === null || r.relayId === relayId)
        .map((r) => ({
          id: `approval:${r.id}`,
          relayId: r.relayId,
          severity: 'warning',
          title: `Approve: ${r.actionTitle}?`,
          body: `${r.requestedByName ?? 'An admin'} asked${r.reason ? ` — “${r.reason}”` : ''}. Swipe right to approve, left to deny.`,
          technical: `${r.actionId} · request ${r.id} · expires ${new Date(r.expiresAt * 1000).toISOString()}`,
          createdAt: r.createdAt,
          batchKey: 'approvals',
          primary: { label: 'Approve', actionId: 'approvals.approve', input: { requestId: r.id } },
          secondary: { label: 'Deny', actionId: 'approvals.deny', input: { requestId: r.id } },
        }));
    },
  };
}
