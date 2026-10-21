// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Passkeys (WebAuthn) via @simplewebauthn/server. Credentials and one-time
 * ceremony challenges live in the DocStore.
 */
import type { Ports } from '@beamhop/core';
import {
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { COL } from '../settings.ts';
import { b64urlDecode, b64urlEncode, utf8 } from '../util.ts';

export interface PasskeyRecord {
  id: string;
  adminId: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  label?: string;
  createdAt: number;
  lastUsedAt?: number;
}

export interface ChallengeRecord {
  purpose: 'register' | 'login';
  challenge: string;
  rpId: string;
  origins: string[];
  expiresAt: number;
  /** Existing admin adding a passkey. */
  adminId?: string;
  /** Code-based first login (claim, invite, recovery). */
  claimCode?: string;
  inviteCode?: string;
  recoveryCode?: string;
  displayName?: string;
}

export interface RpContext {
  rpId: string;
  rpName: string;
  origins: string[];
}

const CHALLENGE_TTL = 300;

export class PasskeyService {
  constructor(private readonly ports: Ports) {}

  async registrationOptions(
    rp: RpContext,
    who: Omit<ChallengeRecord, 'purpose' | 'challenge' | 'rpId' | 'origins' | 'expiresAt'> & {
      userName: string;
    },
  ) {
    const { userName, ...rest } = who;
    const exclude = rest.adminId ? await this.forAdmin(rest.adminId) : [];
    const options = await generateRegistrationOptions({
      rpName: rp.rpName,
      rpID: rp.rpId,
      userName,
      userID: utf8(
        rest.adminId ?? `new:${this.ports.crypto.randomHex(16)}`,
      ) as Uint8Array<ArrayBuffer>,
      attestationType: 'none',
      excludeCredentials: exclude.map((p) => ({ id: p.id })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    const challengeId = this.ports.crypto.randomHex(16);
    const rec: ChallengeRecord = {
      ...rest,
      purpose: 'register',
      challenge: options.challenge,
      rpId: rp.rpId,
      origins: rp.origins,
      expiresAt: this.ports.clock.now() + CHALLENGE_TTL,
    };
    await this.ports.docs.put(COL.challenges, challengeId, rec);
    return { challengeId, options };
  }

  /** Consume a challenge (one-time). */
  async takeChallenge(id: string, purpose: ChallengeRecord['purpose']) {
    const rec = await this.ports.docs.get<ChallengeRecord>(COL.challenges, id);
    if (!rec || rec.purpose !== purpose) return null;
    if (!(await this.ports.docs.delete(COL.challenges, id))) return null;
    if (rec.expiresAt < this.ports.clock.now()) return null;
    return rec;
  }

  async verifyRegistration(rec: ChallengeRecord, response: RegistrationResponseJSON) {
    const v = await verifyRegistrationResponse({
      response,
      expectedChallenge: rec.challenge,
      expectedOrigin: rec.origins,
      expectedRPID: rec.rpId,
      requireUserVerification: false,
    });
    if (!v.verified) return null;
    return v.registrationInfo.credential;
  }

  async saveCredential(
    adminId: string,
    cred: { id: string; publicKey: Uint8Array; counter: number; transports?: string[] },
    label?: string,
  ): Promise<PasskeyRecord> {
    const rec: PasskeyRecord = {
      id: cred.id,
      adminId,
      publicKey: b64urlEncode(cred.publicKey),
      counter: cred.counter,
      createdAt: this.ports.clock.now(),
    };
    if (cred.transports) rec.transports = cred.transports;
    if (label) rec.label = label;
    await this.ports.docs.put(COL.passkeys, cred.id, rec);
    return rec;
  }

  async loginOptions(rp: RpContext) {
    const options = await generateAuthenticationOptions({
      rpID: rp.rpId,
      userVerification: 'preferred',
    });
    const challengeId = this.ports.crypto.randomHex(16);
    const rec: ChallengeRecord = {
      purpose: 'login',
      challenge: options.challenge,
      rpId: rp.rpId,
      origins: rp.origins,
      expiresAt: this.ports.clock.now() + CHALLENGE_TTL,
    };
    await this.ports.docs.put(COL.challenges, challengeId, rec);
    return { challengeId, options };
  }

  async verifyLogin(
    rec: ChallengeRecord,
    response: AuthenticationResponseJSON,
  ): Promise<PasskeyRecord | null> {
    const stored = await this.ports.docs.get<PasskeyRecord>(COL.passkeys, response.id);
    if (!stored) return null;
    let v: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      v = await verifyAuthenticationResponse({
        response,
        expectedChallenge: rec.challenge,
        expectedOrigin: rec.origins,
        expectedRPID: rec.rpId,
        requireUserVerification: false,
        credential: {
          id: stored.id,
          publicKey: b64urlDecode(stored.publicKey) as Uint8Array<ArrayBuffer>,
          counter: stored.counter,
          transports: stored.transports,
        },
      });
    } catch {
      return null;
    }
    if (!v.verified) return null;
    const next = {
      ...stored,
      counter: v.authenticationInfo.newCounter,
      lastUsedAt: this.ports.clock.now(),
    };
    await this.ports.docs.put(COL.passkeys, stored.id, next);
    return next;
  }

  async forAdmin(adminId: string): Promise<PasskeyRecord[]> {
    const page = await this.ports.docs.list<PasskeyRecord>(COL.passkeys, { limit: 1000 });
    return page.items.map((i) => i.value).filter((p) => p.adminId === adminId);
  }

  async gc(): Promise<void> {
    const now = this.ports.clock.now();
    const page = await this.ports.docs.list<ChallengeRecord>(COL.challenges, { limit: 1000 });
    for (const i of page.items)
      if (i.value.expiresAt < now) await this.ports.docs.delete(COL.challenges, i.key);
  }
}
