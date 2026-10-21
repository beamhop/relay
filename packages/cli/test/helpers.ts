// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AdminClaimService, adminApiModule } from '@beamhop/admin-api';
import {
  type BeamhopModule,
  type Kernel,
  createKernel,
  defineAction,
  defineModule,
  parseConfig,
} from '@beamhop/core';
import { memoryPorts } from '@beamhop/testkit';
import { nsecEncode } from 'nostr-tools/nip19';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { z } from 'zod';
import { runCli } from '../src/cli.ts';
import { type AdminClient, kernelClient } from '../src/client.ts';
import type { CliContext } from '../src/context.ts';
import { BufferIo } from '../src/io.ts';

export function tmp(prefix = 'beamhop-cli-'): string {
  return mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), prefix));
}

/** A moderation-like module so generated commands have relay-scoped, bulk, undoable actions. */
export function sampleModule(banned: Map<string, Set<string>>): BeamhopModule {
  const set = (relay: string) => {
    let s = banned.get(relay);
    if (!s) {
      s = new Set();
      banned.set(relay, s);
    }
    return s;
  };
  return defineModule({
    id: 'sample',
    register(k) {
      k.actions.register(
        defineAction({
          id: 'moderation.ban-pubkey',
          title: 'Ban a user',
          description: 'They can no longer post here.',
          technical: 'NIP-86 banpubkey',
          scope: 'relay',
          permission: 'moderation.write',
          bulk: true,
          input: z.object({
            pubkey: z
              .string()
              .regex(/^[0-9a-f]{64}$/)
              .describe('Who to ban (hex)'),
            reason: z.string().max(200).optional().describe('Why (shown to them)'),
          }),
          async preview(input) {
            return [
              {
                kind: 'add',
                text: `${input.pubkey.slice(0, 8)} will be banned`,
                technical: `banpubkey ${input.pubkey}`,
              },
            ];
          },
          async run(input, ctx) {
            set(ctx.relayId!).add(input.pubkey);
            return {
              output: { banned: input.pubkey },
              summary: `Banned ${input.pubkey.slice(0, 8)}`,
              undo: {
                actionId: 'moderation.ban-pubkey',
                payload: { pubkey: input.pubkey, relayId: ctx.relayId },
                expiresAt: ctx.ports.clock.now() + 300,
              },
            };
          },
          async undo(payload) {
            const p = payload as { pubkey: string; relayId: string };
            set(p.relayId).delete(p.pubkey);
          },
        }),
      );
      k.actions.register(
        defineAction({
          id: 'moderation.list-banned',
          title: 'Show banned users',
          description: 'Everyone banned here.',
          scope: 'relay',
          permission: 'relay.read',
          readOnly: true,
          input: z.object({}),
          async run(_i, ctx) {
            return { output: { pubkeys: [...set(ctx.relayId!)] }, summary: 'Listed bans' };
          },
        }),
      );
    },
  });
}

export interface TestNode {
  kernel: Kernel;
  banned: Map<string, Set<string>>;
  ownerNsec: string;
  ownerPk: string;
  claimCode: string;
}

export async function bootNode(relays = ['main']): Promise<TestNode> {
  const ports = memoryPorts();
  const config = parseConfig({
    node: { id: 'n1' },
    relays: relays.map((id) => ({ id, hosts: [`${id}.localhost`] })),
  });
  const banned = new Map<string, Set<string>>();
  const kernel = await createKernel({
    runtime: 'test',
    ports,
    config,
    modules: [adminApiModule, sampleModule(banned)],
  });
  const sk = generateSecretKey();
  const code = (await kernel.use<AdminClaimService>('admin.claim')!.issueCode()).code;
  return {
    kernel,
    banned,
    ownerNsec: nsecEncode(sk),
    ownerPk: getPublicKey(sk),
    claimCode: code,
  };
}

export function testContext(over: Omit<Partial<CliContext>, 'io'> & { io?: BufferIo } = {}) {
  const io = over.io ?? new BufferIo();
  const home = over.home ?? tmp('beamhop-home-');
  const ctx: Partial<CliContext> = {
    io,
    env: { HOME: home },
    cwd: home,
    home,
    fetch: async () => {
      throw new Error('network disabled in tests');
    },
    now: () => Date.now(),
    ...over,
  };
  return { io, ctx, home };
}

/** Run the CLI against an in-process kernel with a bearer token. */
export async function cli(
  node: { kernel: Kernel },
  token: string,
  argv: string[],
  io = new BufferIo(),
  extra: Partial<CliContext> = {},
) {
  const client: AdminClient = kernelClient(node.kernel, `Bearer ${token}`);
  const { io: _ignored, ...rest } = extra;
  const { ctx } = testContext({ ...rest, io, client: async () => client });
  const code = await runCli(argv, ctx);
  return { code, out: io.stdout, err: io.stderr, io };
}
