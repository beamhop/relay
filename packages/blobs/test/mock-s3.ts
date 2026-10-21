// SPDX-License-Identifier: AGPL-3.0-or-later
/** Minimal in-memory S3 (path-style) as a Hono app, for tests. No network. */
import { Hono } from 'hono';

interface Obj {
  data: Uint8Array;
  type: string;
}

export interface MockS3 {
  app: Hono;
  fetch: (req: Request) => Promise<Response>;
  objects: Map<string, Obj>;
  calls: Array<{ method: string; path: string; query: string }>;
  aborted: string[];
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export function mockS3(bucket = 'test-bucket'): MockS3 {
  const objects = new Map<string, Obj>();
  const uploads = new Map<string, { key: string; type: string; parts: Map<number, Uint8Array> }>();
  const calls: MockS3['calls'] = [];
  const aborted: string[] = [];
  const app = new Hono();
  const err = (status: number, code: string) =>
    new Response(`<?xml version="1.0"?><Error><Code>${code}</Code></Error>`, {
      status,
      headers: { 'content-type': 'application/xml' },
    });

  app.all('*', async (c) => {
    const url = new URL(c.req.url);
    calls.push({ method: c.req.method, path: url.pathname, query: url.search });
    const auth = c.req.header('authorization') ?? '';
    if (!auth.startsWith('AWS4-HMAC-SHA256 Credential=')) return err(403, 'AccessDenied');
    if (!c.req.header('x-amz-date')) return err(403, 'AccessDenied');
    const segs = url.pathname.split('/').filter(Boolean);
    if (segs[0] !== bucket) return err(404, 'NoSuchBucket');
    const key = segs.slice(1).map(decodeURIComponent).join('/');
    const q = url.searchParams;
    const method = c.req.method;

    if (!key && method === 'GET' && q.get('list-type') === '2') {
      const prefix = q.get('prefix') ?? '';
      const after = q.get('start-after') ?? '';
      const max = Number(q.get('max-keys') ?? 1000);
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
      const page = keys.slice(0, max);
      const body = page
        .map(
          (k) => `<Contents><Key>${k}</Key><Size>${objects.get(k)!.data.length}</Size></Contents>`,
        )
        .join('');
      return new Response(
        `<?xml version="1.0"?><ListBucketResult><IsTruncated>${keys.length > max}</IsTruncated>${body}</ListBucketResult>`,
        { headers: { 'content-type': 'application/xml' } },
      );
    }

    if (method === 'POST' && q.has('uploads')) {
      const id = `up-${crypto.randomUUID()}`;
      uploads.set(id, {
        key,
        type: c.req.header('content-type') ?? 'binary/octet-stream',
        parts: new Map(),
      });
      return new Response(
        `<?xml version="1.0"?><InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      );
    }
    const uploadId = q.get('uploadId');
    if (uploadId) {
      const up = uploads.get(uploadId);
      if (!up) return err(404, 'NoSuchUpload');
      if (method === 'PUT') {
        const n = Number(q.get('partNumber'));
        const data = new Uint8Array(await c.req.arrayBuffer());
        up.parts.set(n, data);
        return new Response(null, { headers: { etag: `"etag-${n}"` } });
      }
      if (method === 'POST') {
        const xml = await c.req.text();
        const nums = [...xml.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => Number(m[1]));
        const parts = nums.map((n) => up.parts.get(n));
        if (parts.some((p) => !p)) return err(400, 'InvalidPart');
        objects.set(up.key, { data: concat(parts as Uint8Array[]), type: up.type });
        uploads.delete(uploadId);
        return new Response('<CompleteMultipartUploadResult/>');
      }
      if (method === 'DELETE') {
        uploads.delete(uploadId);
        aborted.push(uploadId);
        return new Response(null, { status: 204 });
      }
    }

    const obj = objects.get(key);
    switch (method) {
      case 'PUT': {
        const data = new Uint8Array(await c.req.arrayBuffer());
        objects.set(key, { data, type: c.req.header('content-type') ?? 'binary/octet-stream' });
        return new Response(null, { headers: { etag: '"x"' } });
      }
      case 'HEAD':
        if (!obj) return new Response(null, { status: 404 });
        return new Response(null, {
          headers: { 'content-length': String(obj.data.length), 'content-type': obj.type },
        });
      case 'GET': {
        if (!obj) return err(404, 'NoSuchKey');
        const range = /^bytes=(\d+)-(\d+)$/.exec(c.req.header('range') ?? '');
        if (range) {
          const s = Number(range[1]);
          const e = Math.min(Number(range[2]), obj.data.length - 1);
          return new Response(obj.data.slice(s, e + 1), {
            status: 206,
            headers: {
              'content-type': obj.type,
              'content-range': `bytes ${s}-${e}/${obj.data.length}`,
            },
          });
        }
        return new Response(obj.data as BodyInit, { headers: { 'content-type': obj.type } });
      }
      case 'DELETE':
        objects.delete(key);
        return new Response(null, { status: 204 });
    }
    return err(405, 'MethodNotAllowed');
  });

  return {
    app,
    fetch: async (req) => app.fetch(req),
    objects,
    calls,
    aborted,
  };
}
