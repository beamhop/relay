// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { updateCommand } from '../src/commands/update.ts';
import { BufferIo } from '../src/io.ts';
import {
  keyIdHex,
  parsePublicKey,
  publicKeyLine,
  signMinisign,
  verifyMinisign,
} from '../src/minisign.ts';
import { testContext, tmp } from './helpers.ts';

const enc = new TextEncoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

function releaseKey() {
  const sk = ed25519.utils.randomPrivateKey();
  const keyId = crypto.getRandomValues(new Uint8Array(8));
  return { sk, keyId, pub: publicKeyLine(sk, keyId) };
}

describe('minisign', () => {
  test('prehashed (ED) signatures verify; tampering is detected', () => {
    const k = releaseKey();
    const data = enc.encode('the beamhop binary');
    const sig = signMinisign(data, k.sk, k.keyId, 'timestamp:1700000000\tfile:beamhop');
    expect(sig.split('\n')[0]).toStartWith('untrusted comment:');
    expect(verifyMinisign(data, sig, k.pub)).toEqual({
      ok: true,
      trustedComment: 'timestamp:1700000000\tfile:beamhop',
    });
    // Also accepted: a whole minisign.pub file and a base64-wrapped .minisig.
    const pubFile = `untrusted comment: minisign public key ${keyIdHex(k.keyId)}\n${k.pub}\n`;
    expect(verifyMinisign(data, b64(enc.encode(sig)), pubFile).ok).toBe(true);
    expect(parsePublicKey(pubFile).keyId).toEqual(k.keyId);

    const bad = verifyMinisign(enc.encode('another binary'), sig, k.pub);
    expect(bad).toEqual({ ok: false, reason: 'the signature does not match the file' });
    const lines = sig.split('\n');
    lines[2] = 'trusted comment: timestamp:1800000000';
    expect(verifyMinisign(data, lines.join('\n'), k.pub)).toEqual({
      ok: false,
      reason: 'the trusted comment was tampered with',
    });
    const other = releaseKey();
    const wrong = verifyMinisign(data, sig, other.pub);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toContain(keyIdHex(k.keyId));
    expect(verifyMinisign(data, 'garbage', k.pub).ok).toBe(false);
  });

  test('legacy (Ed) signatures over the raw file are accepted', () => {
    const k = releaseKey();
    const data = enc.encode('legacy');
    const sig = ed25519.sign(data, k.sk);
    const head = new Uint8Array(74);
    head.set(enc.encode('Ed'), 0);
    head.set(k.keyId, 2);
    head.set(sig, 10);
    const tc = 'timestamp:1';
    const global = ed25519.sign(new Uint8Array([...sig, ...enc.encode(tc)]), k.sk);
    const text = `untrusted comment: x\n${b64(head)}\ntrusted comment: ${tc}\n${b64(global)}\n`;
    expect(verifyMinisign(data, text, k.pub)).toEqual({ ok: true, trustedComment: tc });
  });
});

const script = (version: string) =>
  `#!/bin/sh\ncase "$1" in\n  --version) echo "${version}" ;;\nesac\n`;
const shaHex = (t: string) => new Bun.CryptoHasher('sha256').update(t).digest('hex');

/** Release server: manifest with RELATIVE asset/signature URLs under /releases/. */
function server(bin: string, signature?: string, opts: { sigUrl?: boolean } = {}) {
  const asset: Record<string, string> = { url: '../files/beamhop-test-os', sha256: shaHex(bin) };
  if (signature) asset.signature = opts.sigUrl ? 'beamhop-test-os.minisig' : signature;
  const manifest = { version: '0.2.0', assets: { 'test-os': asset } };
  const hits: string[] = [];
  const fetch = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    hits.push(url);
    if (url === 'https://dl.example/releases/latest.json') return Response.json(manifest);
    if (url === 'https://dl.example/files/beamhop-test-os') return new Response(bin);
    if (url === 'https://dl.example/releases/beamhop-test-os.minisig' && signature)
      return new Response(signature);
    return new Response('not found', { status: 404 });
  };
  return { fetch, hits };
}

function installed() {
  const dir = tmp();
  const bin = join(dir, 'beamhop');
  writeFileSync(bin, script('0.1.0'), { mode: 0o755 });
  return bin;
}

const deps = { platform: 'test-os', currentVersion: '0.1.0', serverUrl: async () => null };
const MANIFEST = ['--manifest', 'https://dl.example/releases/latest.json'];

describe('beamhop update: relative URLs and signatures', () => {
  test('relative asset URLs resolve against the manifest; signed release installs', async () => {
    const k = releaseKey();
    const newBin = script('0.2.0');
    for (const sigUrl of [false, true]) {
      const bin = installed();
      const srv = server(newBin, signMinisign(enc.encode(newBin), k.sk, k.keyId), { sigUrl });
      const io = new BufferIo();
      const { ctx } = testContext({ io, fetch: srv.fetch as never, execPath: bin });
      (ctx.env as Record<string, string>).BEAMHOP_UPDATE_PUBLIC_KEY = k.pub;
      expect(await updateCommand(ctx as never, MANIFEST, {}, deps)).toBe(0);
      expect(readFileSync(bin, 'utf8')).toBe(newBin);
      expect(srv.hits).toContain('https://dl.example/files/beamhop-test-os');
      if (sigUrl) expect(srv.hits).toContain('https://dl.example/releases/beamhop-test-os.minisig');
      expect(io.stdout).toContain('Checksum and signature verified');
    }
  });

  test('with a key set: bad signatures are refused, unsigned needs --allow-unsigned', async () => {
    const k = releaseKey();
    const other = releaseKey();
    const newBin = script('0.2.0');

    const bin = installed();
    const forged = server(newBin, signMinisign(enc.encode(newBin), other.sk, other.keyId));
    const { ctx } = testContext({ fetch: forged.fetch as never, execPath: bin });
    (ctx.env as Record<string, string>).BEAMHOP_UPDATE_PUBLIC_KEY = k.pub;
    await expect(updateCommand(ctx as never, MANIFEST, {}, deps)).rejects.toThrow('not signed');
    expect(readFileSync(bin, 'utf8')).toBe(script('0.1.0'));

    const unsigned = server(newBin);
    const { ctx: c2 } = testContext({ fetch: unsigned.fetch as never, execPath: bin });
    (c2.env as Record<string, string>).BEAMHOP_UPDATE_PUBLIC_KEY = k.pub;
    await expect(updateCommand(c2 as never, MANIFEST, {}, deps)).rejects.toThrow(
      '--allow-unsigned',
    );
    expect(readFileSync(bin, 'utf8')).toBe(script('0.1.0'));
    const io = new BufferIo();
    expect(
      await updateCommand({ ...c2, io } as never, [...MANIFEST, '--allow-unsigned'], {}, deps),
    ).toBe(0);
    expect(readFileSync(bin, 'utf8')).toBe(newBin);
    expect(io.stdout).toContain('NOT signed');
  });

  test('without a key (placeholder), updates are refused unless the developer override is set', async () => {
    const bin = installed();
    const srv = server(script('0.2.0'));
    const { ctx } = testContext({ fetch: srv.fetch as never, execPath: bin });
    await expect(updateCommand(ctx as never, MANIFEST, {}, deps)).rejects.toThrow(
      'cannot check that this download is genuine',
    );
    expect(readFileSync(bin, 'utf8')).toBe(script('0.1.0'));
    expect(srv.hits).not.toContain('https://dl.example/files/beamhop-test-os');

    const io = new BufferIo();
    expect(
      await updateCommand({ ...ctx, io } as never, [...MANIFEST, '--allow-unsigned'], {}, deps),
    ).toBe(0);
    expect(io.stdout).toContain('signatures were NOT checked');

    const bin2 = installed();
    const { ctx: c2 } = testContext({ fetch: srv.fetch as never, execPath: bin2 });
    (c2.env as Record<string, string>).BEAMHOP_UPDATE_ALLOW_UNSIGNED = '1';
    expect(await updateCommand({ ...c2, io: new BufferIo() } as never, MANIFEST, {}, deps)).toBe(0);
    expect(readFileSync(bin2, 'utf8')).toBe(script('0.2.0'));
  });
});
