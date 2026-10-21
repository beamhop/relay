// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * DM escrow (§12.8) and the two-person approval gate (§12.9).
 *
 * When escrow is on for a relay, NIP-17 DMs addressed to MANAGED keys can be
 * unwrapped by the company: gift wrap (1059) → seal (13) → rumor (14/15), using
 * the recipient's managed key inside the isolated signer. Self-custody keys
 * have no secret here, so their DMs stay end-to-end. Every decrypt needs a
 * stated reason, an approval (when the approvals service exists) and is audited.
 */
import type { Kernel, NostrEvent, RelayId } from '@beamhop/core';
import { verifyEvent } from '@beamhop/core';
import { getConversationKey, decrypt as nip44decrypt } from 'nostr-tools/nip44';
import { zeroize } from './bytes.ts';
import type { KeyvaultConfig } from './config.ts';
import { type Signer, errMsg } from './signer.ts';

export const APPROVALS_SERVICE = 'enterprise.approvals';

export interface ApprovalRequest {
  actionId: string;
  relayId: RelayId | null;
  principalId: string;
  input: unknown;
  reason?: string;
  /** Approval request id supplied by the caller (after a second admin approved). */
  approvalId?: string;
}

export interface ApprovalDecision {
  status: 'approved' | 'pending' | 'denied' | 'expired';
  requestId?: string;
  approvers?: string[];
}

/**
 * Expected shape of `kernel.use('enterprise.approvals')` (compliance module).
 * `check` returns the decision for this exact request, creating a pending
 * request when none exists yet.
 */
export interface ApprovalsLike {
  check(req: ApprovalRequest): Promise<ApprovalDecision>;
}

export class ApprovalRequiredError extends Error {
  constructor(
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

/**
 * Gate a sensitive operation. With an approvals service: must be approved.
 * Without one: allowed only when `allowWithout` is true.
 */
export async function requireApproval(
  kernel: Kernel,
  req: ApprovalRequest,
  allowWithout: boolean,
): Promise<ApprovalDecision | null> {
  const approvals = kernel.use<ApprovalsLike>(APPROVALS_SERVICE);
  if (!approvals) {
    if (allowWithout) return null;
    throw new ApprovalRequiredError(
      'This needs a second admin to approve, but approvals are not set up. Turn on Compliance first.',
    );
  }
  const d = await approvals.check(req);
  if (d.status === 'approved') return d;
  const id = d.requestId ? ` (request ${d.requestId})` : '';
  if (d.status === 'pending')
    throw new ApprovalRequiredError(`Waiting for a second admin to approve${id}`, d.requestId);
  throw new ApprovalRequiredError(
    `This request was ${d.status === 'denied' ? 'denied' : 'not approved in time'}${id}`,
    d.requestId,
  );
}

export interface EscrowStatus {
  /** DMs of this pubkey on this relay can be read by the company. */
  escrowed: boolean;
  /** The pubkey is a company-managed key. */
  managed: boolean;
  /** Text the team client shows when `escrowed`. */
  notice?: string;
}

export interface DecryptedDm {
  wrapId: string;
  recipient: string;
  sender: string;
  kind: number;
  createdAt: number;
  content: string;
  tags: string[][];
}

export class EscrowError extends Error {}

export class Escrow {
  constructor(
    private readonly kernel: Kernel,
    private readonly signer: Signer,
    private readonly cfg: () => KeyvaultConfig,
  ) {}

  enabledFor(relayId: RelayId | null | undefined): boolean {
    const e = this.cfg().escrow;
    if (!e.enabled) return false;
    if (e.relays.length === 0) return true;
    return !!relayId && e.relays.includes(relayId);
  }

  async status(pubkey: string, relayId?: RelayId): Promise<EscrowStatus> {
    const managed = await this.signer.isManaged(pubkey);
    // Without a relay: escrowed if escrow applies anywhere on this node.
    const on = relayId === undefined ? this.cfg().escrow.enabled : this.enabledFor(relayId);
    const escrowed = managed && on;
    return escrowed
      ? { escrowed, managed, notice: this.cfg().escrow.notice }
      : { escrowed, managed };
  }

  async decryptDm(
    relayId: RelayId,
    eventId: string,
    reason: string,
    principalId: string,
  ): Promise<DecryptedDm> {
    if (!this.enabledFor(relayId))
      throw new EscrowError('Message escrow is not turned on for this relay');
    const wrap = await this.kernel.ports.events.getById(relayId, eventId);
    if (!wrap) throw new EscrowError('That message was not found');
    if (wrap.kind !== 1059)
      throw new EscrowError('That event is not a private message (gift wrap)');
    const recipients = wrap.tags.filter((t) => t[0] === 'p' && t[1]).map((t) => t[1] as string);
    let recipient: string | undefined;
    for (const pk of recipients) if (await this.signer.isManaged(pk)) recipient = pk;
    const base = { op: 'escrow_decrypt' as const, reason, principalId, eventId, via: 'escrow' };
    if (!recipient) {
      await this.signer.audit({
        ...base,
        subjectId: recipients[0] ?? 'unknown',
        ok: false,
        error: 'self-custody recipient',
      });
      throw new EscrowError(
        'This message belongs to someone who holds their own key. It cannot be read by the company.',
      );
    }
    const subjectId = (await this.signer.subjectOf(recipient)) as string;
    try {
      const dm = await this.signer.withSecretKey(
        subjectId,
        (sk) => unwrapGift(wrap, sk, recipient as string),
        { allowPendingDestroy: true },
      );
      await this.signer.audit({ ...base, subjectId, pubkey: recipient, kind: dm.kind, ok: true });
      return dm;
    } catch (err) {
      await this.signer.audit({
        ...base,
        subjectId,
        pubkey: recipient,
        ok: false,
        error: errMsg(err),
      });
      throw err instanceof EscrowError
        ? err
        : new EscrowError(`Could not open this message: ${errMsg(err)}`);
    }
  }
}

/** NIP-59 unwrap with explicit checks; conversation keys are zeroized. */
export function unwrapGift(wrap: NostrEvent, sk: Uint8Array, recipient: string): DecryptedDm {
  const open = (ct: string, peer: string) => {
    const ck = getConversationKey(sk, peer);
    try {
      return nip44decrypt(ct, ck);
    } finally {
      zeroize(ck);
    }
  };
  const seal = JSON.parse(open(wrap.content, wrap.pubkey)) as NostrEvent;
  if (seal.kind !== 13 || !verifyEvent(seal))
    throw new EscrowError('The sealed message is invalid');
  const rumor = JSON.parse(open(seal.content, seal.pubkey)) as {
    kind: number;
    pubkey: string;
    created_at: number;
    content: string;
    tags: string[][];
  };
  if (rumor.pubkey !== seal.pubkey)
    throw new EscrowError('The message author does not match its seal');
  return {
    wrapId: wrap.id,
    recipient,
    sender: rumor.pubkey,
    kind: rumor.kind,
    createdAt: rumor.created_at,
    content: rumor.content,
    tags: rumor.tags,
  };
}
