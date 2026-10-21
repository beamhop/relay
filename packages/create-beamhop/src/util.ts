// SPDX-License-Identifier: AGPL-3.0-or-later
/** Small helpers: argument parsing, npub decoding, names and random codes. */
import { parseArgs } from 'node:util';

export interface Options {
  cf: boolean;
  dryRun: boolean;
  yes: boolean;
  help: boolean;
  /** Relay name shown in apps. */
  name?: string;
  /** Custom domain; empty or "workers.dev" means the free workers.dev address. */
  domain?: string;
  /** Owner npub (or hex public key). */
  owner?: string;
  /** Project folder (default: the relay name as a slug). */
  dir?: string;
  /** npm spec for the Worker bundle (default: the published @beamhop/runtime-cf). */
  runtime?: string;
}

export function parseOptions(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    strict: false,
    options: {
      cf: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      help: { type: 'boolean', short: 'h' },
      name: { type: 'string' },
      domain: { type: 'string' },
      owner: { type: 'string' },
      dir: { type: 'string' },
      runtime: { type: 'string' },
    },
  });
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  return {
    cf: values.cf === true,
    dryRun: values['dry-run'] === true,
    yes: values.yes === true,
    help: values.help === true,
    name: str(values.name),
    domain: str(values.domain),
    owner: str(values.owner),
    dir: str(values.dir),
    runtime: str(values.runtime),
  };
}

/** "My Cool Relay!" → "my-cool-relay" (valid Worker, D1 and R2 name). */
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return s || 'beamhop';
}

/** Normalize a domain answer: strip scheme/path; "" or "workers.dev" → undefined. */
export function normalizeDomain(input: string | undefined): string | undefined {
  const s = (input ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/\/.*$/, '');
  if (!s || s === 'workers.dev' || s === 'none') return undefined;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) {
    throw new Error(`"${input}" does not look like a domain name (example: relay.example.com)`);
  }
  return s;
}

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function polymod(values: number[]): number {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= gen[i] as number;
  }
  return chk;
}

/** Accept an npub or a 64-char hex public key; return hex, or null if invalid. */
export function parsePubkey(input: string): string | null {
  const s = input.trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(s)) return s;
  if (!s.startsWith('npub1')) return null;
  const data: number[] = [];
  for (const c of s.slice(5)) {
    const v = BECH32.indexOf(c);
    if (v < 0) return null;
    data.push(v);
  }
  const hrp = [...'npub'].map((c) => c.charCodeAt(0));
  const expanded = [...hrp.map((c) => c >> 5), 0, ...hrp.map((c) => c & 31)];
  if (polymod([...expanded, ...data]) !== 1) return null;
  // 5-bit groups → bytes
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const v of data.slice(0, -6)) {
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (out.length !== 32) return null;
  return out.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Claim code in the same shape the server generates (XXXX-XXXX-XXXX-XXXX). */
export function humanCode(groups = 4): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(groups * 4));
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  const out: string[] = [];
  for (let g = 0; g < groups; g++) out.push(chars.slice(g * 4, g * 4 + 4).join(''));
  return out.join('-');
}

/** 32 random bytes as hex (IP hash salt). */
export function randomSecret(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
