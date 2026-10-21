// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PolicyContext } from '@beamhop/core';
import type { CtxView } from './types.ts';

/** Strip a PolicyContext down to plain, structured-clonable data. */
export function toCtxView(ctx: PolicyContext | undefined): CtxView {
  if (!ctx) return { relayId: 'default', now: Math.floor(Date.now() / 1000) };
  const out: CtxView = { relayId: ctx.relayId, now: ctx.now };
  if (ctx.tier !== undefined) out.tier = ctx.tier;
  if (ctx.dryRun) out.dryRun = true;
  const c = ctx.conn;
  if (c) {
    out.conn = {
      id: c.id,
      ipHash: c.ipHash,
      openedAt: c.openedAt,
      authed: [...c.authed],
      ...(c.userAgent ? { userAgent: c.userAgent } : {}),
    };
  }
  return out;
}
