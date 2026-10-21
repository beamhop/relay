// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * OpenAPI 3.1 document: static routes from the @hono/zod-openapi registry,
 * plus per-action paths generated at request time from `kernel.actions`
 * (modules may register actions after the admin API).
 */
import type { Api, Deps } from './api.ts';
import { inputJsonSchema } from './routes-actions.ts';

type Paths = Record<string, Record<string, unknown>>;

export function buildOpenApi(api: Api, deps: Deps): Record<string, unknown> {
  const doc = api.getOpenAPI31Document({
    openapi: '3.1.0',
    info: {
      title: 'Beamhop Admin API',
      version: '1',
      description:
        'Every admin operation is an action from the registry; this document is generated from it. Paths are fleet-ready: /nodes/{node}/… and /nodes/{node}/relays/{relay}/… (use `self` for this node).',
    },
    servers: [{ url: '/api/v1' }],
  }) as unknown as { paths?: Paths } & Record<string, unknown>;
  const paths: Paths = { ...(doc.paths ?? {}) };
  const security = [{ session: [] }, { token: [] }, { nip98: [] }];
  for (const def of deps.kernel.actions.list()) {
    const base = def.scope === 'relay' ? '/nodes/{node}/relays/{relay}' : '/nodes/{node}';
    const params = [
      { name: 'node', in: 'path', required: true, schema: { type: 'string' } },
      ...(def.scope === 'relay'
        ? [{ name: 'relay', in: 'path', required: true, schema: { type: 'string' } }]
        : []),
    ];
    const body = (inputSchema: unknown) => ({
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { input: inputSchema, reason: { type: 'string' } },
            required: ['input'],
          },
        },
      },
    });
    const common = {
      tags: [`Action: ${def.id.split('.')[0]}`],
      parameters: params,
      security,
      'x-permission': def.permission,
      'x-technical': def.technical,
    };
    paths[`${base}/actions/${def.id}`] = {
      post: {
        ...common,
        operationId: `run_${def.id}`,
        summary: def.title,
        description: `${def.description}${def.readOnly ? '' : ' Audited; returns an undo token when undoable.'}`,
        requestBody: body(inputJsonSchema(def)),
        responses: { 200: { description: 'Result with plain-language summary' } },
      },
    };
    if (!def.readOnly)
      paths[`${base}/actions/${def.id}/preview`] = {
        post: {
          ...common,
          operationId: `preview_${def.id}`,
          summary: `Preview: ${def.title}`,
          requestBody: body(inputJsonSchema(def)),
          responses: { 200: { description: 'Plain-language diff lines' } },
        },
      };
    if (def.bulk)
      paths[`${base}/actions/${def.id}/bulk`] = {
        post: {
          ...common,
          operationId: `bulk_${def.id}`,
          summary: `Bulk: ${def.title}`,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { inputs: { type: 'array', items: inputJsonSchema(def) } },
                  required: ['inputs'],
                },
              },
            },
          },
          responses: { 200: { description: 'Per-item results and one undo token' } },
        },
      };
  }
  return { ...doc, paths };
}

export function openApiRoute(api: Api, deps: Deps): void {
  api.get('/openapi.json', (c) => c.json(buildOpenApi(api, deps)));
}
