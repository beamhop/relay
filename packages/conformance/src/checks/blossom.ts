// SPDX-License-Identifier: AGPL-3.0-or-later
/** Blossom: BUD-01, 02, 03, 04, 05, 06 over plain fetch with kind 24242 auth. */
import {
  type Check,
  type Key,
  type SuiteContext,
  check,
  expect,
  fail,
  short,
  skip,
} from '../types.ts';
import { mustAccept, query } from './util.ts';

export interface BlobDescriptor {
  url?: unknown;
  sha256?: unknown;
  size?: unknown;
  type?: unknown;
  uploaded?: unknown;
}

function base(ctx: SuiteContext): string {
  if (!ctx.blossomUrl) skip('No media server given (use --blossom).');
  return ctx.blossomUrl.replace(/\/+$/, '');
}

function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function blossomAuth(
  ctx: SuiteContext,
  key: Key,
  verb: 'get' | 'upload' | 'list' | 'delete' | 'media',
  opts: { x?: string[]; expiration?: number } = {},
): string {
  const ev = ctx.sign(key, {
    kind: 24242,
    content: `conformance ${verb}`,
    tags: [
      ['t', verb],
      ['expiration', String(opts.expiration ?? ctx.now() + 300)],
      ...(opts.x ?? []).map((h) => ['x', h]),
    ],
  });
  return `Nostr ${toBase64(JSON.stringify(ev))}`;
}

function randomBlob(n = 96): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

const reasonOf = (r: Response) => r.headers.get('x-reason') ?? '';

async function drain(r: Response): Promise<void> {
  try {
    await r.body?.cancel();
  } catch {
    // ignore
  }
}

export async function upload(
  ctx: SuiteContext,
  key: Key,
  data = randomBlob(),
  type = 'application/octet-stream',
): Promise<{ sha: string; data: Uint8Array; desc: BlobDescriptor }> {
  const sha = await sha256Hex(data);
  const res = await ctx.fetch(`${base(ctx)}/upload`, {
    method: 'PUT',
    headers: {
      authorization: blossomAuth(ctx, key, 'upload', { x: [sha] }),
      'content-type': type,
      'x-sha-256': sha,
    },
    body: data as Uint8Array<ArrayBuffer>,
  });
  if (!res.ok) {
    await drain(res);
    fail(`Upload failed: HTTP ${res.status} ${short(reasonOf(res))}`.trim());
  }
  let desc: BlobDescriptor;
  try {
    desc = (await res.json()) as BlobDescriptor;
  } catch {
    fail('The upload answer is not a JSON blob descriptor.');
  }
  return { sha, data, desc };
}

const isPrivateHost = (host: string) =>
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|0\.0\.0\.0)/i.test(host) ||
  host.endsWith('.localhost') ||
  host.endsWith('.test');

const bud01: Check[] = [
  check({
    id: 'bud01.get',
    spec: 'BUD-01',
    title: 'Serves uploaded files by hash (GET and HEAD)',
    blossom: true,
    async run(ctx) {
      const { sha, data } = await upload(ctx, ctx.key(), undefined, 'text/plain');
      const res = await ctx.fetch(`${base(ctx)}/${sha}`);
      expect(res.status === 200, `GET /<sha256> answered HTTP ${res.status}.`);
      const body = new Uint8Array(await res.arrayBuffer());
      expect((await sha256Hex(body)) === sha, 'The downloaded bytes do not match the hash.');
      const ext = await ctx.fetch(`${base(ctx)}/${sha}.txt`);
      await drain(ext);
      expect(ext.status === 200, `GET /<sha256>.txt answered HTTP ${ext.status}.`);
      const head = await ctx.fetch(`${base(ctx)}/${sha}`, { method: 'HEAD' });
      const headBody = await head.arrayBuffer();
      expect(head.status === 200, `HEAD /<sha256> answered HTTP ${head.status}.`);
      expect(headBody.byteLength === 0, 'HEAD returned a body.');
      const len = head.headers.get('content-length');
      expect(
        len === null || Number(len) === data.length,
        `HEAD Content-Length ${len} does not match ${data.length}.`,
      );
      return 'GET, GET with extension and HEAD all work.';
    },
  }),
  check({
    id: 'bud01.missing',
    spec: 'BUD-01',
    title: 'Unknown hashes answer 404',
    blossom: true,
    async run(ctx) {
      const sha = await sha256Hex(randomBlob(16));
      const res = await ctx.fetch(`${base(ctx)}/${sha}`);
      await drain(res);
      expect(res.status === 404, `GET of an unknown hash answered HTTP ${res.status}.`);
      return '404 as expected.';
    },
  }),
  check({
    id: 'bud01.cors',
    spec: 'BUD-01',
    title: 'Media endpoints allow web apps (CORS)',
    blossom: true,
    async run(ctx) {
      const pre = await ctx.fetch(`${base(ctx)}/upload`, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://client.example',
          'access-control-request-method': 'PUT',
          'access-control-request-headers': 'authorization, content-type',
        },
      });
      await drain(pre);
      expect(pre.status < 400, `Pre-flight answered HTTP ${pre.status}.`);
      expect(
        pre.headers.get('access-control-allow-origin'),
        'Missing Access-Control-Allow-Origin on pre-flight.',
      );
      const { sha } = await upload(ctx, ctx.key());
      const get = await ctx.fetch(`${base(ctx)}/${sha}`, {
        headers: { origin: 'https://client.example' },
      });
      await drain(get);
      expect(
        get.headers.get('access-control-allow-origin'),
        'Missing Access-Control-Allow-Origin on GET.',
      );
      return 'CORS headers present.';
    },
  }),
  check({
    id: 'bud01.range',
    spec: 'BUD-01',
    title: 'Partial downloads (Range) work when offered',
    blossom: true,
    async run(ctx) {
      const { sha, data } = await upload(ctx, ctx.key());
      const res = await ctx.fetch(`${base(ctx)}/${sha}`, { headers: { range: 'bytes=0-9' } });
      const body = new Uint8Array(await res.arrayBuffer());
      if (res.status === 200) skip('Range requests are not supported (optional).');
      expect(res.status === 206, `Range request answered HTTP ${res.status}.`);
      expect(body.length === 10, `Expected 10 bytes, got ${body.length}.`);
      expect(
        body.every((b, i) => b === data[i]),
        'The partial content does not match the file.',
      );
      return '206 with the right bytes.';
    },
  }),
];

const bud02: Check[] = [
  check({
    id: 'bud02.upload',
    spec: 'BUD-02',
    title: 'Uploads return a correct blob descriptor',
    blossom: true,
    async run(ctx) {
      const { sha, data, desc } = await upload(ctx, ctx.key(), undefined, 'text/plain');
      const problems: string[] = [];
      if (desc.sha256 !== sha) problems.push(`sha256 is ${String(desc.sha256)}`);
      if (desc.size !== data.length) problems.push(`size is ${String(desc.size)}`);
      if (typeof desc.url !== 'string' || !desc.url.includes(sha))
        problems.push('url does not contain the hash');
      if (typeof desc.type !== 'string') problems.push('type missing');
      if (typeof desc.uploaded !== 'number') problems.push('uploaded missing');
      expect(problems.length === 0, `Descriptor problems: ${problems.join('; ')}.`);
      return 'Descriptor has url, sha256, size, type and uploaded.';
    },
  }),
  check({
    id: 'bud02.upload-auth',
    spec: 'BUD-02',
    title: 'Uploads with bad or missing sign-in are refused',
    blossom: true,
    async run(ctx) {
      const data = randomBlob();
      const sha = await sha256Hex(data);
      const put = (authorization?: string) =>
        ctx.fetch(`${base(ctx)}/upload`, {
          method: 'PUT',
          headers: {
            'content-type': 'application/octet-stream',
            ...(authorization ? { authorization } : {}),
          },
          body: data as Uint8Array<ArrayBuffer>,
        });
      const k = ctx.key();
      const expired = await put(blossomAuth(ctx, k, 'upload', { x: [sha], expiration: 1000 }));
      await drain(expired);
      expect(expired.status >= 400, `An expired authorization was accepted (${expired.status}).`);
      const wrongVerb = await put(blossomAuth(ctx, k, 'delete', { x: [sha] }));
      await drain(wrongVerb);
      expect(wrongVerb.status >= 400, 'An authorization for "delete" was accepted for upload.');
      const other = await sha256Hex(randomBlob(8));
      const wrongHash = await put(blossomAuth(ctx, k, 'upload', { x: [other] }));
      await drain(wrongHash);
      expect(wrongHash.status >= 400, 'An authorization for another file hash was accepted.');
      const none = await put();
      await drain(none);
      const anon = none.ok ? ' (anonymous uploads are allowed here)' : '';
      return `Expired, wrong-verb and wrong-hash authorizations refused${anon}.`;
    },
  }),
  check({
    id: 'bud02.list',
    spec: 'BUD-02',
    title: "Lists a user's uploads",
    blossom: true,
    async run(ctx) {
      const k = ctx.key();
      const { sha } = await upload(ctx, k);
      let res = await ctx.fetch(`${base(ctx)}/list/${k.pk}`);
      if (res.status === 401) {
        await drain(res);
        res = await ctx.fetch(`${base(ctx)}/list/${k.pk}`, {
          headers: { authorization: blossomAuth(ctx, k, 'list') },
        });
      }
      expect(res.ok, `GET /list/<pubkey> answered HTTP ${res.status}.`);
      const list = (await res.json()) as BlobDescriptor[];
      expect(Array.isArray(list), 'The list answer is not a JSON array.');
      expect(
        list.some((d) => d.sha256 === sha),
        'The uploaded file is missing from the list.',
      );
      return `${list.length} file(s) listed, including the upload.`;
    },
  }),
  check({
    id: 'bud02.delete',
    spec: 'BUD-02',
    title: 'Owners can delete their uploads',
    blossom: true,
    async run(ctx) {
      const k = ctx.key();
      const { sha } = await upload(ctx, k);
      const anon = await ctx.fetch(`${base(ctx)}/${sha}`, { method: 'DELETE' });
      await drain(anon);
      expect(anon.status >= 400, `DELETE without sign-in answered HTTP ${anon.status}.`);
      const stranger = await ctx.fetch(`${base(ctx)}/${sha}`, {
        method: 'DELETE',
        headers: { authorization: blossomAuth(ctx, ctx.key(), 'delete', { x: [sha] }) },
      });
      await drain(stranger);
      const still = await ctx.fetch(`${base(ctx)}/${sha}`, { method: 'HEAD' });
      await drain(still);
      expect(still.status === 200, "A stranger's DELETE removed the file.");
      const del = await ctx.fetch(`${base(ctx)}/${sha}`, {
        method: 'DELETE',
        headers: { authorization: blossomAuth(ctx, k, 'delete', { x: [sha] }) },
      });
      await drain(del);
      expect(del.ok, `The owner's DELETE answered HTTP ${del.status} ${reasonOf(del)}.`);
      const gone = await ctx.fetch(`${base(ctx)}/${sha}`);
      await drain(gone);
      expect(gone.status === 404, `After deletion GET answered HTTP ${gone.status}.`);
      return 'Only the owner could delete; the file is gone afterwards.';
    },
  }),
];

const bud03: Check[] = [
  check({
    id: 'bud03.server-list',
    spec: 'BUD-03',
    title: 'Keeps user server lists (kind 10063) and uses them as hints',
    blossom: true,
    async run(ctx) {
      const media = base(ctx);
      const k = ctx.key();
      const elsewhere = 'https://media-mirror.invalid';
      const list = ctx.sign(k, {
        kind: 10063,
        tags: [
          ['server', media],
          ['server', elsewhere],
        ],
      });
      const c = await ctx.connect();
      await mustAccept(c, list, 'a server list (kind 10063)');
      const got = await query(c, [{ kinds: [10063], authors: [k.pk] }]);
      expect(
        got.length === 1 && got[0]?.id === list.id,
        'The server list (kind 10063) was not returned by a query for it.',
      );
      const servers = (got[0]?.tags ?? []).filter((t) => t[0] === 'server').map((t) => t[1]);
      expect(
        servers[0] === media && servers[1] === elsewhere,
        'The server list came back with its servers changed or reordered.',
      );
      // Optional server behaviour: a missing blob with an author hint points to their other server.
      const sha = await sha256Hex(randomBlob(24));
      const res = await ctx.fetch(`${media}/${sha}?as=${k.pk}`, { redirect: 'manual' });
      await drain(res);
      const loc = res.headers.get('location') ?? '';
      if (res.status >= 300 && res.status < 400) {
        expect(
          loc.startsWith(`${elsewhere}/${sha}`),
          `The redirect for a missing file went to "${short(loc)}", not the author's other server.`,
        );
        return "Stores the list and redirects missing files to the author's other server.";
      }
      expect(res.status === 404, `A missing file with an author hint answered HTTP ${res.status}.`);
      return 'Stores the list (no redirect hints for missing files).';
    },
  }),
];

const bud04: Check[] = [
  check({
    id: 'bud04.mirror',
    spec: 'BUD-04',
    title: 'Copies a file from another server URL (mirror)',
    blossom: true,
    async run(ctx) {
      const { sha, desc } = await upload(ctx, ctx.key());
      const source = typeof desc.url === 'string' ? desc.url : `${base(ctx)}/${sha}`;
      let host = '';
      try {
        host = new URL(source).hostname;
      } catch {
        fail(`The descriptor url "${short(source)}" is not a valid URL.`);
      }
      if (isPrivateHost(host) && !ctx.allowPrivateMirror)
        skip('The test file lives on a private address; mirroring it would be refused.');
      const k = ctx.key();
      const res = await ctx.fetch(`${base(ctx)}/mirror`, {
        method: 'PUT',
        headers: {
          authorization: blossomAuth(ctx, k, 'upload', { x: [sha] }),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ url: source }),
      });
      if (res.status === 404 || res.status === 405) {
        await drain(res);
        skip('Mirroring is not offered.');
      }
      expect(res.ok, `PUT /mirror answered HTTP ${res.status} ${reasonOf(res)}.`);
      const d = (await res.json()) as BlobDescriptor;
      expect(d.sha256 === sha, `Mirrored descriptor sha256 is ${String(d.sha256)}.`);
      return 'Mirrored; descriptor matches.';
    },
  }),
];

// 1×1 transparent PNG.
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

const bud05: Check[] = [
  check({
    id: 'bud05.media',
    spec: 'BUD-05',
    title: 'Optimizes media uploads (when offered)',
    blossom: true,
    async run(ctx) {
      const k = ctx.key();
      const sha = await sha256Hex(PNG);
      const head = await ctx.fetch(`${base(ctx)}/media`, {
        method: 'HEAD',
        headers: {
          authorization: blossomAuth(ctx, k, 'media', { x: [sha] }),
          'x-sha-256': sha,
          'x-content-type': 'image/png',
          'x-content-length': String(PNG.length),
        },
      });
      await drain(head);
      if (head.status === 404 || head.status === 405) skip('The /media endpoint is not offered.');
      const res = await ctx.fetch(`${base(ctx)}/media`, {
        method: 'PUT',
        headers: {
          authorization: blossomAuth(ctx, k, 'media', { x: [sha] }),
          'content-type': 'image/png',
        },
        body: PNG as Uint8Array<ArrayBuffer>,
      });
      expect(res.ok, `PUT /media answered HTTP ${res.status} ${reasonOf(res)}.`);
      const d = (await res.json()) as BlobDescriptor;
      expect(typeof d.sha256 === 'string' && typeof d.url === 'string', 'Bad descriptor.');
      const get = await ctx.fetch(`${base(ctx)}/${d.sha256}`, { method: 'HEAD' });
      await drain(get);
      expect(get.status === 200, `The optimized file is not served (HTTP ${get.status}).`);
      return d.sha256 === sha ? 'Stored unchanged.' : 'Stored an optimized version.';
    },
  }),
];

const bud06: Check[] = [
  check({
    id: 'bud06.preflight',
    spec: 'BUD-06',
    title: 'Upload pre-check (HEAD /upload) answers before sending data',
    blossom: true,
    async run(ctx) {
      const k = ctx.key();
      const sha = await sha256Hex(randomBlob());
      const ok = await ctx.fetch(`${base(ctx)}/upload`, {
        method: 'HEAD',
        headers: {
          authorization: blossomAuth(ctx, k, 'upload', { x: [sha] }),
          'x-sha-256': sha,
          'x-content-length': '96',
          'x-content-type': 'application/octet-stream',
        },
      });
      await drain(ok);
      if (ok.status === 404 || ok.status === 405) skip('HEAD /upload is not offered.');
      expect(ok.status === 200, `A small upload pre-check answered HTTP ${ok.status}.`);
      const big = await ctx.fetch(`${base(ctx)}/upload`, {
        method: 'HEAD',
        headers: {
          authorization: blossomAuth(ctx, k, 'upload', { x: [sha] }),
          'x-sha-256': sha,
          'x-content-length': String(10 ** 13),
          'x-content-type': 'application/octet-stream',
        },
      });
      await drain(big);
      expect(big.status >= 400, 'A 10 TB upload pre-check was accepted.');
      expect(reasonOf(big), 'Refusals must explain themselves in an X-Reason header.');
      const bad = await ctx.fetch(`${base(ctx)}/upload`, {
        method: 'HEAD',
        headers: {
          authorization: blossomAuth(ctx, k, 'upload'),
          'x-sha-256': 'not-a-hash',
          'x-content-length': '10',
        },
      });
      await drain(bad);
      expect(bad.status === 400, `An invalid X-SHA-256 answered HTTP ${bad.status}, not 400.`);
      const note =
        big.status === 413 ? '' : ` (size refusal used HTTP ${big.status}, 413 expected)`;
      if (note) fail(`Oversized upload pre-check must answer 413${note}.`);
      return 'Accepts small uploads, refuses oversized (413) and malformed (400) ones.';
    },
  }),
];

export const blossomChecks: Check[] = [...bud01, ...bud02, ...bud03, ...bud04, ...bud05, ...bud06];
