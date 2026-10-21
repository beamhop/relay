// SPDX-License-Identifier: AGPL-3.0-or-later
/** Software WebAuthn authenticator (ES256, "none" attestation) for passkey ceremony tests. */
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { b64urlDecode, b64urlEncode, sha256Hex, utf8 } from '../src/util.ts';

const hexToBytes = (h: string) =>
  new Uint8Array(h.match(/../g)!.map((x) => Number.parseInt(x, 16)));

async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return hexToBytes(await sha256Hex(b));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function derInt(b: Uint8Array): Uint8Array {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  let v: Uint8Array = b.slice(i);
  if (v[0]! & 0x80) v = concat(new Uint8Array([0]), v);
  return concat(new Uint8Array([0x02, v.length]), v);
}

function rawToDer(sig: Uint8Array): Uint8Array {
  const r = derInt(sig.slice(0, 32));
  const s = derInt(sig.slice(32));
  return concat(new Uint8Array([0x30, r.length + s.length]), r, s);
}

export class SoftAuthenticator {
  readonly credentialId = crypto.getRandomValues(new Uint8Array(16));
  counter = 0;
  private constructor(private readonly keys: CryptoKeyPair) {}

  static async create(): Promise<SoftAuthenticator> {
    const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    return new SoftAuthenticator(keys);
  }

  get id(): string {
    return b64urlEncode(this.credentialId);
  }

  private async authData(rpId: string, flags: number, attested?: Uint8Array): Promise<Uint8Array> {
    const counter = new Uint8Array(4);
    new DataView(counter.buffer).setUint32(0, this.counter);
    return concat(
      await sha256(utf8(rpId)),
      new Uint8Array([flags]),
      counter,
      attested ?? new Uint8Array(),
    );
  }

  async register(
    options: { challenge: string; rp: { id?: string } },
    origin: string,
  ): Promise<Record<string, unknown>> {
    const rpId = options.rp.id ?? new URL(origin).hostname;
    const jwk = await crypto.subtle.exportKey('jwk', this.keys.publicKey);
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, b64urlDecode(jwk.x!)],
        [-3, b64urlDecode(jwk.y!)],
      ]),
    );
    const idLen = new Uint8Array(2);
    new DataView(idLen.buffer).setUint16(0, this.credentialId.length);
    const attested = concat(new Uint8Array(16), idLen, this.credentialId, cose);
    const authData = await this.authData(rpId, 0x01 | 0x04 | 0x40, attested);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]) as never,
    );
    const clientDataJSON = utf8(
      JSON.stringify({
        type: 'webauthn.create',
        challenge: options.challenge,
        origin,
        crossOrigin: false,
      }),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64urlEncode(clientDataJSON),
        attestationObject: b64urlEncode(attestationObject),
        transports: ['internal'],
      },
    };
  }

  async login(
    options: { challenge: string; rpId?: string },
    origin: string,
  ): Promise<Record<string, unknown>> {
    const rpId = options.rpId ?? new URL(origin).hostname;
    this.counter++;
    const authData = await this.authData(rpId, 0x01 | 0x04);
    const clientDataJSON = utf8(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: options.challenge,
        origin,
        crossOrigin: false,
      }),
    );
    const signed = concat(authData, await sha256(clientDataJSON));
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        this.keys.privateKey,
        signed as Uint8Array<ArrayBuffer>,
      ),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64urlEncode(clientDataJSON),
        authenticatorData: b64urlEncode(authData),
        signature: b64urlEncode(rawToDer(raw)),
      },
    };
  }
}
