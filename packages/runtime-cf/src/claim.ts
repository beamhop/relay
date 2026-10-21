// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * First-run owner claim on Cloudflare. The Bun server prints the claim code on its console;
 * a Worker has no console the owner sees, so at first boot (no owner yet) the Worker:
 *
 * - takes the code from the `BEAMHOP_CLAIM_CODE` secret when set (`wrangler secret put
 *   BEAMHOP_CLAIM_CODE`): no database access needed, the owner picks the code;
 * - otherwise keeps an existing unused code (e.g. the one `npm create beamhop -- --cf`
 *   wrote and printed) or creates one through the admin module (`admin.claim`, same
 *   document and format as Bun), and writes it once to the Worker log (`wrangler tail`).
 *
 * Never throws: a failure here must not stop the relay from serving.
 */
import type { Clock, DocStore, Kernel, Logger } from '@beamhop/core';

/** Same collection/key the admin module and `create-beamhop` use. */
export const CLAIM_COLLECTION = 'admin.claim';
export const CLAIM_KEY = 'code';
/** Marks that a runtime-created code was written to the log (so it is logged only once). */
export const FIRST_RUN_COLLECTION = 'runtime.first-run';
export const CLAIM_LOGGED_KEY = 'claim-code-logged';
export const MIN_PRESET_CLAIM_CODE = 8;

interface ClaimServiceLike {
  isClaimed(): Promise<boolean>;
  issueCode(): Promise<{ code: string }>;
}

export type ClaimOutcome =
  | 'no-admin'
  | 'claimed'
  | 'preset'
  | 'created-logged'
  | 'existing'
  | 'error';

export async function ensureClaimCode(
  kernel: Kernel,
  deps: { docs: DocStore; logger: Logger; clock: Clock; preset?: string | undefined },
): Promise<ClaimOutcome> {
  const { docs, logger, clock } = deps;
  try {
    const svc = kernel.use<ClaimServiceLike>('admin.claim');
    if (!svc) return 'no-admin';
    if (await svc.isClaimed()) return 'claimed';
    const adminUrl = 'the /admin/ page of this relay';

    const preset = deps.preset?.trim();
    if (preset) {
      if (preset.length >= MIN_PRESET_CLAIM_CODE) {
        const cur = await docs.get<{ code?: string }>(CLAIM_COLLECTION, CLAIM_KEY);
        if (cur?.code !== preset)
          await docs.put(CLAIM_COLLECTION, CLAIM_KEY, { code: preset, createdAt: clock.now() });
        logger.log(
          'info',
          `This relay has no owner yet. Open ${adminUrl} and enter the claim code you saved as a secret.`,
          { technical: 'claim code taken from the BEAMHOP_CLAIM_CODE secret' },
        );
        return 'preset';
      }
      logger.log('warn', 'The claim code secret is too short and was ignored', {
        technical: `BEAMHOP_CLAIM_CODE needs at least ${MIN_PRESET_CLAIM_CODE} characters`,
      });
    }

    const existed = await docs.get(CLAIM_COLLECTION, CLAIM_KEY);
    const { code } = await svc.issueCode();
    if (
      !existed &&
      (await docs.cas(FIRST_RUN_COLLECTION, CLAIM_LOGGED_KEY, null, { at: clock.now() }))
    ) {
      // Shown once (`wrangler tail` / Workers Logs). Redeeming it deletes it.
      logger.log('warn', `First run: your one-time claim code is ${code}`, {
        claimCode: code,
        technical: `Open ${adminUrl}, sign in and enter this code to become the owner. Lost it? Run \`wrangler secret put BEAMHOP_CLAIM_CODE\` with a code of your own.`,
      });
      return 'created-logged';
    }
    logger.log('info', `This relay has no owner yet. Open ${adminUrl} and enter your claim code.`, {
      technical:
        'The code was shown when the relay was set up (create-beamhop output or the first Worker log line). Lost it? Run `wrangler secret put BEAMHOP_CLAIM_CODE` with a code of your own.',
    });
    return 'existing';
  } catch (err) {
    logger.log('error', 'Could not prepare the first sign-in', { error: String(err) });
    return 'error';
  }
}
